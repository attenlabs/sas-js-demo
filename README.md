# sas-js-demo

End-to-end browser demo for [SAS](https://server.attentionlabs.ai) — streams microphone and webcam to the SD Attention Server, then forwards detected speech segments to OpenAI Realtime for a conversational audio response.

Everything runs in the browser. The server tells you *when* someone is speaking and what they said; this demo routes that speech to the LLM of your choice (OpenAI Realtime is shown, but the SDK hands you PCM16 audio — drop in any provider).

## What you'll need

- A SAS auth token
- An OpenAI API key with Realtime access *(optional — omit to run without the LLM stage and just see live predictions)*

## Run

```bash
npm install
```

Serve the repo root with any static file server — e.g. `npx serve`, `python3 -m http.server` — and open the demo at:

```
/?token=YOUR_TOKEN&openai_key=sk-...
```

## URL parameters

| param        | required | notes |
| ------------ | -------- | ----- |
| `token`      | yes      | SAS auth token |
| `openai_key` | no       | Enables the LLM round-trip. Omit to just watch predictions and VAD. |
| `server`     | no       | Override the default server URL (`wss://server.attentionlabs.ai/ws`) to point at your own SAS instance. |

## How it works

1. [`app.js`](app.js) constructs an `AttentionClient` from [`sas-js`](https://www.npmjs.com/package/sas-js), which acquires the mic + webcam and opens a WebSocket to the SAS server.
2. The SDK emits typed events — `prediction`, `vad`, `state`, and `speechReady` — which `app.js` renders into the UI.
3. On `speechReady`, `app.js` hands the PCM16 audio to [`llm.js`](llm.js), a small OpenAI Realtime bridge that sends it to OpenAI and plays the response back through WebAudio.
4. While the LLM is speaking, `app.js` calls `client.mute()` + `client.markResponding(true)` so the server stops emitting predictions until playback ends.

The LLM bridge is deliberately part of this demo, not the SDK — swap in whichever provider you like.

## Security note

This demo passes the OpenAI API key through the browser (via a URL param) for simplicity. **Never do that in production** — proxy the Realtime connection through a server you control so the key never reaches the client.

## License

MIT
