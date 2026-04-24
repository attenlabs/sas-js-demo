import { AttentionClient } from "sas-js";
import { RealtimeLLMBridge } from "./llm.js";

const CLASS_LABELS = { 0: "Silent", 1: "Human", 2: "Device" };
const LLM_INSTRUCTIONS =
  "You are a helpful assistant. Respond concisely in 1 sentence. " +
  "If a device/TV command is spoken to you, respond as if you were controlling a TV.";

// Read server override from URL params (everything else comes from UI inputs).
const params = new URLSearchParams(location.search);
const serverOverride = params.get("server") || undefined;

const inputToken = document.getElementById("input-token");
const inputOpenai = document.getElementById("input-openai");
const preview = document.getElementById("preview");
const warmup = document.getElementById("warmup");
const predClass = document.getElementById("pred-class");
const predConf = document.getElementById("pred-conf");
const confFill = document.getElementById("conf-fill");
const predSource = document.getElementById("pred-source");
const numFaces = document.getElementById("num-faces");
const vadValue = document.getElementById("vad-value");
const convStateEl = document.getElementById("conv-state");
const llmStateEl = document.getElementById("llm-state");
const thresholdInput = document.getElementById("threshold");
const thresholdValue = document.getElementById("threshold-value");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const logEl = document.getElementById("log");

let client = null;
let llm = null;
let llmState = "idle";

function log(kind, msg, extra) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${kind}: ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
  const lines = (logEl.textContent ? logEl.textContent.split("\n") : []).concat(line);
  logEl.textContent = lines.slice(-200).join("\n");
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(state) {
  statusDot.className = `status-dot ${state === "connected" ? "connected" : state === "connecting" ? "connecting" : ""}`;
  statusText.textContent =
    state === "connected" ? "Connected" :
    state === "connecting" ? "Connecting…" :
    "Disconnected";
}

function setLLMState(state) {
  llmState = state;
  llmStateEl.textContent = state.toUpperCase();
  llmStateEl.className = `value state-${state}`;
}

function renderPrediction({ cls, confidence, source, numFaces: faces }) {
  const label = CLASS_LABELS[cls] ?? `Class ${cls}`;
  predClass.textContent = label.toUpperCase();
  const pct = Math.round((confidence ?? 0) * 100);
  predConf.textContent = `${pct}%`;
  confFill.style.width = `${pct}%`;
  confFill.className = `conf-fill class-${cls ?? 0}`;
  predSource.textContent = source || "--";
  numFaces.textContent = faces ?? 0;
}

function renderConvState(state) {
  convStateEl.textContent = state.toUpperCase();
  convStateEl.className = `value state-${state}`;
}

function renderThreshold() {
  thresholdValue.textContent = Number(thresholdInput.value).toFixed(2);
}

thresholdInput.addEventListener("input", () => {
  renderThreshold();
  if (client) client.setThreshold(Number(thresholdInput.value));
});

// Enable Start only when a token is present.
inputToken.addEventListener("input", () => {
  btnStart.disabled = !inputToken.value.trim();
});

btnStart.addEventListener("click", () => { start(); });
btnStop.addEventListener("click", () => { teardown(); });

async function start() {
  const token = inputToken.value.trim();
  const openaiKey = inputOpenai.value.trim() || null;

  if (!token) {
    log("error", "enter a SAS token above");
    return;
  }
  if (!openaiKey) {
    log("warn", "no OpenAI key — LLM bridge disabled");
  }

  btnStart.disabled = true;
  btnStop.disabled = false;
  setStatus("connecting");

  client = new AttentionClient({
    url: serverOverride,
    token,
    initialThreshold: Number(thresholdInput.value),
  });

  client.on("connected", () => {
    setStatus("connected");
    warmup.hidden = false;
    log("info", "ws connected");
  });
  client.on("started", () => log("info", "server warmup complete"));
  client.on("warmupComplete", () => {
    warmup.hidden = true;
    log("info", "first prediction received");
  });
  client.on("prediction", (e) => {
    // Server keeps predicting during LLM response; freeze UI during that window.
    if (llmState === "speaking" || llmState === "processing") return;
    renderPrediction(e);
  });
  client.on("vad", (e) => {
    vadValue.textContent = `${Math.round(e.probability * 100)}%`;
  });
  client.on("state", (e) => renderConvState(e.state));
  client.on("speechReady", (e) => {
    setLLMState("processing");
    log("info", `speech ready (${e.durationSec.toFixed(2)}s) — forwarding to LLM`);
    if (llm) {
      llm.sendAudioB64(e.audioBase64);
    } else {
      setLLMState("idle");
      log("warn", "no LLM configured — audio dropped");
    }
  });
  client.on("config", (e) => {
    thresholdInput.value = String(e.modelClass2Threshold);
    renderThreshold();
  });
  client.on("stats", (s) => {
    log(
      "stats",
      `rtt=${s.rttMs != null ? s.rttMs.toFixed(0) + "ms" : "n/a"} ` +
      `video=${s.sentVideo}(skip ${s.skippedVideo}) audio=${s.sentAudio} ` +
      `buf=${s.bufferedAmount}B`,
    );
  });
  client.on("error", (e) => {
    log("error", `${e.title}: ${e.message}${e.detail ? " | " + e.detail : ""}`);
  });
  client.on("disconnected", (e) => {
    setStatus("disconnected");
    log("warn", `disconnected code=${e.code}${e.reason ? " reason=" + e.reason : ""}`);
  });

  if (openaiKey) {
    llm = new RealtimeLLMBridge({
      apiKey: openaiKey,
      instructions: LLM_INSTRUCTIONS,
    });
    llm.on("speakingStart", () => {
      setLLMState("speaking");
      client.mute();
      client.markResponding(true);
    });
    llm.on("transcript", (t) => log("llm", `transcript: ${t}`));
    llm.on("speakingEnd", () => {
      setLLMState("idle");
      if (client) {
        client.unmute();
        client.markResponding(false);
      }
    });
    llm.on("error", (e) => {
      log("error", `${e.title}: ${e.message}`);
      setLLMState("idle");
    });
  }

  try {
    await client.start({ videoElement: preview });
  } catch (err) {
    log("error", `start failed: ${err?.title || err?.name || "Error"}: ${err?.message || err}`);
    await teardown();
  }
}

async function teardown() {
  if (client) { await client.stop(); client = null; }
  if (llm) { llm.close(); llm = null; }

  warmup.hidden = true;
  setStatus("disconnected");
  renderPrediction({ cls: 0, confidence: 0, source: "--", numFaces: 0 });
  predClass.textContent = "--";
  predConf.textContent = "--";
  vadValue.textContent = "--";
  renderConvState("idle");
  setLLMState("idle");

  btnStart.disabled = false;
  btnStop.disabled = true;
}

renderThreshold();
