# sas-js-demo

End-to-end browser demo for attention labs SAS (Selective Attention System) SDK — streams microphone and webcam to the SAS Server, then forwards detected speech segments to OpenAI Realtime.

Everything runs in the browser. The server tells you *when* someone is speaking and what they said; this demo routes that speech to the LLM of your choice (OpenAI Realtime is shown).

## What you'll need

- A SAS auth token (sign up on the dashboard [here](https://attentionlabs.ai/dashboard/))
- An OpenAI API key with Realtime access *(optional — omit to run and just see live predictions)*

## Run

```bash
npm install
```

Serve the repo root with any static file server — e.g. `npx serve`, `python3 -m http.server` — and open the demo in a browser. Paste your SAS token (and optionally your OpenAI key) into the top-left panel and click **Connect**.

## URL parameters

All optional. The token / key fields stay editable in the UI. URL params just auto-populate them for future runs.

| param         | notes |
| ------------- | ----- |
| `token`       | Pre-fills the SAS auth token field. |
| `openai_key`  | Pre-fills the OpenAI key field.  Omit to just watch predictions and VAD.  |

Example: `/?token=al_live_…&openai_key=sk-…`

## How it works

1. [`app.js`](app.js) constructs an `AttentionClient` from [`sas-js`](https://www.npmjs.com/package/sas-js), which acquires the mic + webcam and opens a WebSocket to the SAS server.
2. The SDK emits typed events — `prediction`, `vad`, `state`, `speechReady`, `warmupComplete`.  `app.js` renders into the UI.
3. On `speechReady`, `app.js` hands the PCM16 audio to [`llm.js`](llm.js), a small OpenAI Realtime bridge that sends it to OpenAI and plays the response back through WebAudio.
4. While the LLM is speaking, `app.js` calls `client.mute()` + `client.markResponding(true)` so the server stops emitting predictions until playback ends.
6. A small guided flow (top-of-screen pill) walks first-time users through *talk to the computer → talk to each other → free play*.

The LLM bridge is deliberately part of this demo, not the SDK — swap in whichever provider you like.

## Security note

This demo accepts the OpenAI API key in the browser (typed into the UI or passed via URL) for simplicity. **Never do that in production**, always proxy the Realtime connection through a server you control so the key never reaches the client.

## License

MIT
