// OpenAI Realtime bridge — sample-app only, NOT part of the SDK.
// The SDK emits `speechReady` with base64 PCM16; this helper forwards it to
// OpenAI's Realtime API and plays the audio response back through WebAudio.

const DEFAULT_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28";
const DEFAULT_VOICE = "sage";
const OUTPUT_SAMPLE_RATE = 24000;
const DEFAULT_GAIN_DB = 6;

export class RealtimeLLMBridge {
  constructor(options) {
    if (!options?.apiKey) throw new Error("RealtimeLLMBridge: apiKey required");
    this.apiKey = options.apiKey;
    this.url = options.url ?? DEFAULT_URL;
    this.voice = options.voice ?? DEFAULT_VOICE;
    this.instructions = options.instructions ?? "You are a helpful assistant.";
    this.gainDb = options.gainDb ?? DEFAULT_GAIN_DB;
    this.temperature = options.temperature ?? 0.8;

    this.ws = null;
    this.sessionReady = false;
    this.pendingAudio = null;
    this.audioChunks = [];
    this.responseTimer = null;
    this.closed = false;
    this.listeners = new Map();
  }

  on(event, fn) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  _emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[llm] listener '${event}' threw:`, err);
      }
    }
  }

  sendAudioB64(b64) {
    this.pendingAudio = b64;
    this.closed = false;
    if (this.sessionReady && this.ws?.readyState === WebSocket.OPEN) {
      this._flush();
      return;
    }
    this._connect();
  }

  _connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.sessionReady = false;

    // OpenAI accepts the API key as a WS subprotocol for browser clients.
    // Note: exposes the key to the browser — only do this for local demos.
    this.ws = new WebSocket(this.url, [
      "realtime",
      `openai-insecure-api-key.${this.apiKey}`,
      "openai-beta.realtime-v1",
    ]);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: this.instructions,
          voice: this.voice,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: null,
          tool_choice: "auto",
          temperature: this.temperature,
          max_response_output_tokens: "inf",
        },
      }));
    };

    this.ws.onmessage = (e) => this._onMessage(e);
    this.ws.onerror = () => {};
    this.ws.onclose = (e) => {
      this.sessionReady = false;
      this.ws = null;
      if (this.pendingAudio && !this.closed) {
        this.pendingAudio = null;
        this._emit("error", {
          title: "LLM Disconnected",
          message: "LLM connection dropped mid-request.",
          detail: `code=${e.code} reason=${e.reason || "none"}`,
        });
        this._emit("speakingEnd");
      }
    };
  }

  _flush() {
    if (!this.pendingAudio) return;
    const audio = this.pendingAudio;
    this.pendingAudio = null;
    this.responseTimer = performance.now();
    try {
      this.ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_audio", audio }],
        },
      }));
      this.ws.send(JSON.stringify({ type: "response.create" }));
    } catch (err) {
      this._emit("error", {
        title: "LLM Send Error",
        message: err.message ?? String(err),
      });
      this._emit("speakingEnd");
    }
  }

  _onMessage(e) {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    switch (data.type) {
      case "session.created":
      case "session.updated":
        if (!this.sessionReady) {
          this.sessionReady = true;
          this._flush();
        }
        break;
      case "response.audio.delta":
        this.audioChunks.push(data.delta);
        break;
      case "response.audio.done":
        this._playback();
        break;
      case "response.audio_transcript.done":
        this._emit("transcript", data.transcript);
        break;
      case "error":
        this._emit("error", {
          title: "LLM Error",
          message: data.error?.message ?? JSON.stringify(data),
        });
        this._emit("speakingEnd");
        break;
    }
  }

  async _playback() {
    const pcm16 = this._concatBase64PCM(this.audioChunks);
    this.audioChunks = [];

    if (this.responseTimer != null) {
      const dt = (performance.now() - this.responseTimer) / 1000;
      console.log(`[llm] response time: ${dt.toFixed(2)}s`);
    }

    if (pcm16.length === 0) {
      this._emit("speakingEnd");
      return;
    }

    this._emit("speakingStart");

    const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    const f32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
    const buf = ctx.createBuffer(1, f32.length, OUTPUT_SAMPLE_RATE);
    buf.copyToChannel(f32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = Math.pow(10, this.gainDb / 20);
    src.connect(gain).connect(ctx.destination);

    src.onended = () => {
      ctx.close().catch(() => {});
      this._emit("speakingEnd");
    };
    src.start();
  }

  _concatBase64PCM(b64List) {
    let total = 0;
    const bins = b64List.map((b64) => {
      const s = atob(b64);
      total += s.length;
      return s;
    });
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const s of bins) {
      for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
      off += s.length;
    }
    return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  }

  close() {
    this.closed = true;
    this.pendingAudio = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.sessionReady = false;
  }
}
