import { AttentionClient } from "sas-js";
import { RealtimeLLMBridge } from "./llm.js";

const CLASS_TO_STATE = { 0: "silent", 1: "human", 2: "device" };

const STATES = {
  silent:     { label: "SILENT",                short: true,  body: "state-silent" },
  human:      { label: "TALKING TO EACH OTHER", short: false, body: "state-human"  },
  device:     { label: "TALKING TO COMPUTER",   short: false, body: "state-device" },
  responding: { label: "AI IS RESPONDING",      short: false, body: "state-responding" },
};

const LLM_INSTRUCTIONS =
  "You are a helpful assistant. Respond concisely in 1 sentence. " +
  "If a device/TV command is spoken to you, respond as if you were controlling a TV.";

const GREETING_INSTRUCTIONS =
  "Greet the user warmly in one short sentence — say you can help with anything they want.";

// Hold mute + responding-state for a beat after playback ends so speakers /
// room reverb don't bleed into the mic and trigger a feedback loop.
const POST_PLAYBACK_MUTE_HOLD_MS = 400;

const SUGGESTIONS = [
  "Try talking to the computer",
  "Now try talking to each other",
  "Now test this however you want!",
];

const GUIDE_STEPS = {
  AWAITING_COMPUTER: 0,
  COMPUTER_DONE_WAITING_FOR_SILENCE: 1,
  AWAITING_HUMAN: 2,
  HUMAN_DONE_WAITING_FOR_SILENCE: 3,
  DONE: 4,
};

// URL params: ?server=… ?token=… ?openai_key=…
const params = new URLSearchParams(location.search);
const serverOverride = params.get("server") || undefined;
const urlToken = params.get("token");
const urlOpenai = params.get("openai_key");
const ENABLE_GREETING = !params.has("nogreet");

// ── DOM refs ────────────────────────────────────────────────────────────────
const authPanel    = document.getElementById("authPanel");
const inputToken   = document.getElementById("input-token");
const inputOpenai  = document.getElementById("input-openai");
const classNameEl  = document.getElementById("className");
const confPctEl    = document.getElementById("confPct");
const statFaces    = document.getElementById("statFaces");
const statVad      = document.getElementById("statVad");
const statConv     = document.getElementById("statConv");
const btn          = document.getElementById("btnConnect");
const orbEl        = document.getElementById("orb");
const soundBars    = document.getElementById("soundBars");
const videoEl      = document.getElementById("videoEl");
const camPlaceholder = videoEl.previousElementSibling;
const threshSlider = document.getElementById("threshSlider");
const threshVal    = document.getElementById("threshVal");
const toastEl      = document.getElementById("toast");
const suggestionEl = document.getElementById("suggestion");
const suggestionTx = document.getElementById("suggestionText");
const tokensBlock  = document.getElementById("tokensBlock");
const tokensCount  = document.getElementById("tokensCount");

// ── Session state ──────────────────────────────────────────────────────────
let client = null;
let llm = null;
let running = false;
let warmedUp = false;
let llmActive = false;
let pred = { s: "silent", conf: 0, faces: 0 };
let vadStr = "--";
let convStr = "--";
let modelClass2Threshold = 0.70;

let currentSuggestion = -1;
let guideStep = GUIDE_STEPS.AWAITING_COMPUTER;

// Pre-populate inputs from URL params (still editable).
if (urlToken)  inputToken.value  = urlToken;
if (urlOpenai) inputOpenai.value = urlOpenai;

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, ms = 5000) {
  toastEl.textContent = msg;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => toastEl.classList.remove("visible"), ms);
}
function clearToast() {
  toastEl.classList.remove("visible");
  clearTimeout(toastTimer);
}

// ── Tokens ticker ──────────────────────────────────────────────────────────
let tokensSaved = 0;
let tickerTimer = null;
let tickerRunning = false;

function formatTokens(n) {
  return String(Math.min(n, 9999)).padStart(4, "0");
}

function startTicker() {
  if (tickerRunning) return;
  tickerRunning = true;
  tokensBlock.classList.add("visible");
  const tick = () => {
    if (!tickerRunning) return;
    if (tokensSaved < 9999) {
      tokensSaved = Math.min(9999, tokensSaved + Math.floor(Math.random() * 15 + 8));
      tokensCount.textContent = formatTokens(tokensSaved);
      tokensCount.classList.remove("ticking");
      void tokensCount.offsetWidth;
      tokensCount.classList.add("ticking");
    }
    tickerTimer = setTimeout(tick, 180 + Math.random() * 120);
  };
  tick();
}

function pauseTicker() {
  tickerRunning = false;
  clearTimeout(tickerTimer);
}

function resetTicker() {
  pauseTicker();
  tokensSaved = 0;
  tokensCount.textContent = "0000";
  tokensBlock.classList.remove("visible");
}

// ── Suggestion / guide flow ────────────────────────────────────────────────
function setSuggestion(idx) {
  if (idx === currentSuggestion) return;
  currentSuggestion = idx;
  suggestionTx.classList.add("changing");
  setTimeout(() => {
    suggestionTx.textContent = SUGGESTIONS[idx];
    suggestionTx.classList.remove("changing");
  }, 300);
}

function showSuggestion(idx) {
  setSuggestion(idx);
  suggestionEl.classList.add("visible");
}

function hideSuggestion() {
  suggestionEl.classList.remove("visible");
}

function predictionPassesThreshold(p) {
  return p.conf >= modelClass2Threshold;
}

function updateGuidedPrompt(p) {
  // Don't advance the guide while the LLM is responding.
  if (llmActive) return;

  const confident = predictionPassesThreshold(p);
  const isSilent = p.s === "silent";

  if (guideStep === GUIDE_STEPS.AWAITING_COMPUTER) {
    if (p.s === "device" && confident) {
      guideStep = GUIDE_STEPS.COMPUTER_DONE_WAITING_FOR_SILENCE;
      hideSuggestion();
      return;
    }
    showSuggestion(0);
    return;
  }

  if (guideStep === GUIDE_STEPS.COMPUTER_DONE_WAITING_FOR_SILENCE) {
    if (isSilent) {
      guideStep = GUIDE_STEPS.AWAITING_HUMAN;
      showSuggestion(1);
      return;
    }
    hideSuggestion();
    return;
  }

  if (guideStep === GUIDE_STEPS.AWAITING_HUMAN) {
    if (p.s === "human" && confident) {
      guideStep = GUIDE_STEPS.HUMAN_DONE_WAITING_FOR_SILENCE;
      hideSuggestion();
      return;
    }
    showSuggestion(1);
    return;
  }

  if (guideStep === GUIDE_STEPS.HUMAN_DONE_WAITING_FOR_SILENCE) {
    if (isSilent) {
      guideStep = GUIDE_STEPS.DONE;
      showSuggestion(2);
      return;
    }
    hideSuggestion();
    return;
  }

  showSuggestion(2);
}

// ── Render: rebuild visible UI from latest signals ─────────────────────────
function render() {
  const displayS = llmActive ? "responding" : (warmedUp ? pred.s : "silent");
  const st = STATES[displayS];

  document.body.className = st.body;
  classNameEl.classList.toggle("short", st.short);

  if (!running) {
    classNameEl.textContent = "NOT CONNECTED";
    confPctEl.textContent = "--";
    statFaces.textContent = "--";
    statVad.textContent = "--";
    statConv.textContent = "--";
    soundBars.classList.remove("visible");
    orbEl.classList.remove("active", "warming");
    hideSuggestion();
    return;
  }

  if (!warmedUp) {
    classNameEl.textContent = "CONNECTING";
    classNameEl.classList.remove("short");
    confPctEl.textContent = "--";
    statFaces.textContent = pred.faces || "--";
    statVad.textContent = vadStr;
    statConv.textContent = convStr;
    soundBars.classList.remove("visible");
    orbEl.classList.remove("active");
    orbEl.classList.add("warming");
    hideSuggestion();
    return;
  }

  orbEl.classList.remove("warming");
  classNameEl.textContent = st.label;
  confPctEl.textContent = pred.conf > 0 ? Math.round(pred.conf * 100) + "%" : "--";
  statFaces.textContent = pred.faces ?? "--";
  statVad.textContent = vadStr;
  statConv.textContent = convStr;

  const speaking = llmActive || (pred.s !== "silent" && pred.conf > 0.3);
  soundBars.classList.toggle("visible", speaking);
  orbEl.classList.toggle("active", speaking);

  // Tokens ticker runs only when speech is human-directed (not at the device).
  if (!llmActive && pred.s === "human" && pred.conf > 0.3) {
    startTicker();
  } else {
    pauseTicker();
  }

  updateGuidedPrompt(pred);
}

// ── Threshold ──────────────────────────────────────────────────────────────
function setThresholdFromSlider() {
  modelClass2Threshold = Number(threshSlider.value) / 100;
  threshVal.textContent = modelClass2Threshold.toFixed(2);
  if (client) client.setThreshold(modelClass2Threshold);
}
threshSlider.addEventListener("input", setThresholdFromSlider);

// ── Connect button gating ──────────────────────────────────────────────────
function refreshConnectButton() {
  if (running) return;
  btn.disabled = !inputToken.value.trim();
}
inputToken.addEventListener("input", refreshConnectButton);
refreshConnectButton();

btn.addEventListener("click", () => running ? stop() : start());

// ── Lifecycle ──────────────────────────────────────────────────────────────
async function start() {
  const token = inputToken.value.trim();
  const openaiKey = inputOpenai.value.trim() || null;
  if (!token) { toast("Enter a SAS token to connect."); return; }

  btn.disabled = true;
  btn.textContent = "Connecting…";
  clearToast();
  authPanel.classList.add("hidden");

  // Reset session state.
  warmedUp = false;
  llmActive = false;
  pred = { s: "silent", conf: 0, faces: 0 };
  vadStr = "--";
  convStr = "--";
  currentSuggestion = -1;
  guideStep = GUIDE_STEPS.AWAITING_COMPUTER;
  resetTicker();

  client = new AttentionClient({
    url: serverOverride,
    token,
    initialThreshold: modelClass2Threshold,
  });

  client.on("connected", () => {
    running = true;
    btn.disabled = false;
    btn.textContent = "Disconnect";
    btn.classList.add("stop");
    videoEl.style.display = "block";
    if (camPlaceholder) camPlaceholder.style.display = "none";
    render();
  });

  client.on("warmupComplete", () => {
    warmedUp = true;
    showSuggestion(0);
    // Disable with ?nogreet for diagnostics (e.g. when chasing feedback loops).
    if (llm && ENABLE_GREETING) llm.greet(GREETING_INSTRUCTIONS);
    render();
  });

  client.on("prediction", (e) => {
    if (llmActive) return;
    const s = CLASS_TO_STATE[e.cls] ?? "silent";
    const newPred = { s, conf: e.confidence ?? 0, faces: e.numFaces ?? 0 };
    // Hold the last non-silent snapshot while the server is mid-utterance
    // (Listening/Sending). Otherwise the orb flickers SILENT in the gap
    // between the user finishing their turn and speechReady arriving.
    const inFlight = convStr === "Listening" || convStr === "Sending";
    if (inFlight && newPred.s === "silent" && pred.s !== "silent") {
      pred = { ...pred, faces: newPred.faces };
    } else {
      pred = newPred;
    }
    render();
  });

  client.on("vad", (e) => {
    vadStr = e.probability != null ? `${Math.round(e.probability * 100)}%` : "--";
    render();
  });

  client.on("state", (e) => {
    const map = { listening: "Listening", sending: "Sending", cancelled: "Idle", idle: "Idle" };
    convStr = map[e.state] ?? e.state ?? "--";
    render();
  });

  client.on("speechReady", (e) => {
    if (llm) {
      llm.sendAudioB64(e.audioBase64);
    }
  });

  client.on("config", (e) => {
    if (typeof e.modelClass2Threshold === "number") {
      modelClass2Threshold = e.modelClass2Threshold;
      threshSlider.value = String(Math.round(modelClass2Threshold * 100));
      threshVal.textContent = modelClass2Threshold.toFixed(2);
    }
  });

  client.on("error", (e) => {
    toast(`${e.title || "Error"}: ${e.message}`, 0);
  });

  client.on("disconnected", (e) => {
    if (running && e.code !== 1000) {
      const reason = e.code === 1008 ? "auth rejected"
                   : e.code === 1013 ? "rate limited"
                   : e.code === 1006 ? "connection failed"
                   : e.reason || `closed (code ${e.code})`;
      toast(`Disconnected — ${reason}`, 0);
    }
    stop();
  });

  if (openaiKey) {
    llm = new RealtimeLLMBridge({ apiKey: openaiKey, instructions: LLM_INSTRUCTIONS });
    llm.on("speakingStart", () => {
      llmActive = true;
      if (client) { client.mute(); client.markResponding(true); }
      render();
    });
    llm.on("speakingEnd", () => {
      // Hold mute briefly after playback so the speaker tail / room reverb
      // doesn't get re-detected as device speech and loop us back into the LLM.
      setTimeout(() => {
        llmActive = false;
        if (client) { client.unmute(); client.markResponding(false); }
        render();
      }, POST_PLAYBACK_MUTE_HOLD_MS);
    });
    llm.on("error", (e) => {
      toast(`LLM ${e.title || "error"}: ${e.message}`);
      llmActive = false;
      if (client) { client.unmute(); client.markResponding(false); }
      render();
    });
  }

  try {
    await client.start({ videoElement: videoEl });
  } catch (err) {
    toast(`Start failed: ${err?.message || err}`, 0);
    stop();
  }
}

async function stop() {
  running = false;
  if (client) { try { await client.stop(); } catch {} client = null; }
  if (llm)    { llm.close(); llm = null; }

  warmedUp = false;
  llmActive = false;
  pred = { s: "silent", conf: 0, faces: 0 };
  vadStr = "--";
  convStr = "--";
  currentSuggestion = -1;
  guideStep = GUIDE_STEPS.AWAITING_COMPUTER;
  resetTicker();

  videoEl.style.display = "none";
  if (camPlaceholder) camPlaceholder.style.display = "flex";
  videoEl.srcObject = null;

  authPanel.classList.remove("hidden");
  btn.disabled = !inputToken.value.trim();
  btn.textContent = "Connect";
  btn.classList.remove("stop");
  render();
}

// Initial paint.
render();
