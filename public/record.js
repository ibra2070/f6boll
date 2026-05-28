// --- helpers ------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const msgBox = $("#msg");

function showMsg(text, type = "ok") {
  msgBox.textContent = text;
  msgBox.classList.remove("hidden", "ok", "err");
  msgBox.classList.add(type === "ok" ? "ok" : "err");
}
function hideMsg() {
  msgBox.classList.add("hidden");
}
function normalizeIsraeliPhone(value) {
  const compact = value.trim().replace(/[\s-]/g, "");
  if (/^05\d{8}$/.test(compact)) {
    return `+972${compact.slice(1)}`;
  }
  if (/^\+?9725\d{8}$/.test(compact)) {
    return compact.startsWith("+") ? compact : `+${compact}`;
  }
  return null;
}
function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : btn.dataset.label;
}

function customerError(action, status) {
  if (status === 401 || status === 403) {
    return "Please verify your phone again, then try once more.";
  }
  if (status === 409) {
    return "Recording is not available at this time.";
  }
  if (action === "start" && status === 423) {
    return "Your recording request is already being processed. Please wait a moment.";
  }
  if (status === 429) {
    return "Please wait a minute before requesting another code.";
  }
  if (action === "start" && status === 422) {
    return "Recording is not available at this time.";
  }
  if (action === "start" && status >= 500) {
    return "The recording service is unavailable right now. Please try again shortly.";
  }
  if (action === "sendCode") {
    return "We couldn’t send the verification code. Please check your phone number and try again.";
  }
  if (action === "verify") {
    return "That code didn’t work. Please check the SMS and try again.";
  }
  if (action === "start") {
    return "We couldn’t start the recording. Please try again or ask the staff for help.";
  }
  return "Something went wrong. Please try again.";
}

// --- API prefix detection (local vs Vercel) ------------------------------
// Locally (served by the same Express app), routes are like `/auth/...`.
// On Vercel, your Express app is mounted at `/api/...`.
const isLocalHost =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1";

// If you ever serve from /public locally, this still counts as local.
const API_PREFIX = isLocalHost ? "" : "/api";

// Helper for fetch calls
function api(path, opts) {
  const url = `${API_PREFIX}${path}`;
  return fetch(url, opts);
}

// --- camera id display (supports camerald typo too) ---------------------
const params = new URLSearchParams(location.search);
const cameraId = params.get("cameraId") || params.get("camerald") || "";
$("#camLabel").textContent = cameraId
  ? `Camera ${cameraId}`
  : "This recording link is missing camera details. Please scan the QR code again or ask the staff for a new link.";

// --- state --------------------------------------------------------------
let token = null;
let sentPhone = null;

const phoneEl = $("#phone");
const codeEl = $("#code");
const sendBtn = $("#send");
const verifyBtn = $("#verify");
const startBtn = $("#start");
const outEl = $("#out");
const pill = $("#statusPill");
const copyNumberBtn = $("#copyNumber");
const copyStatus = $("#copyStatus");
let statusCheckPending = false;
let startRequestPending = false;

sendBtn.dataset.label = "Send verification code";
verifyBtn.dataset.label = "Verify";
startBtn.dataset.label = "Start Recording";

copyNumberBtn.onclick = async () => {
  try {
    await navigator.clipboard.writeText("0506360021");
    copyStatus.textContent = "Number copied";
  } catch {
    copyStatus.textContent = "Could not copy. Use 050-636-0021.";
  }
};

if (!cameraId) {
  sendBtn.disabled = true;
  phoneEl.disabled = true;
  showMsg("This link can’t start a recording because the camera is missing. Please scan the QR code again or ask the staff for help.", "err");
}

function reservationMessage(until) {
  const match = typeof until === "string" ? until.match(/(\d{2}:\d{2})$/) : null;
  return match
    ? `This pitch is already reserved until ${match[1]}.`
    : "This pitch is already reserved right now.";
}

async function checkAvailability(showBusyMessage = true) {
  if (!cameraId || statusCheckPending) return null;
  statusCheckPending = true;
  try {
    const res = await api(`/record/status?cameraId=${encodeURIComponent(cameraId)}`);
    if (!res.ok) return null;
    const status = await res.json().catch(() => ({}));
    if (status.available === false) {
      startBtn.disabled = true;
      startBtn.classList.add("hidden");
      pill.textContent = "Reserved";
      pill.classList.remove("hidden");
      pill.classList.add("red");
      if (showBusyMessage) showMsg(reservationMessage(status.until), "err");
      return false;
    }
    if (status.available === true) {
      if (!startRequestPending) startBtn.disabled = false;
      startBtn.classList.remove("hidden");
      pill.textContent = "Available";
      pill.classList.remove("hidden", "red");
      return true;
    }
    return null;
  } catch {
    return null;
  } finally {
    statusCheckPending = false;
  }
}

// --- actions ------------------------------------------------------------
sendBtn.onclick = async () => {
  hideMsg();
  if (!cameraId) {
    showMsg("This link can’t start a recording because the camera is missing. Please scan the QR code again or ask the staff for help.", "err");
    return;
  }
  const phone = normalizeIsraeliPhone(phoneEl.value);
  if (!phone) {
    showMsg("Enter a valid Israeli mobile number, for example 054-919-5229.", "err");
    return;
  }

  setLoading(sendBtn, true);
  try {
    const r = await api("/auth/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    if (!r.ok) {
      showMsg(customerError("sendCode", r.status), "err");
      return;
    }

    sentPhone = phone;
    phoneEl.disabled = true;
    $("#step2").classList.remove("hidden");
    showMsg("Code sent. Check your SMS.", "ok");
  } catch {
    showMsg(customerError("sendCode"), "err");
  } finally {
    setLoading(sendBtn, false);
  }
};

verifyBtn.onclick = async () => {
  hideMsg();
  const code = codeEl.value.trim();
  if (!sentPhone) {
    showMsg("Send the verification code first.", "err");
    return;
  }
  if (!code) {
    showMsg("Enter the code you received.", "err");
    return;
  }

  setLoading(verifyBtn, true);
  try {
    const res = await api("/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: sentPhone, cameraId, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMsg(customerError("verify", res.status), "err");
      return;
    }

    token = data.token;
    $("#controls").classList.remove("hidden");
    showMsg("You’re verified. Start recording when you’re ready.", "ok");
    await checkAvailability(true);
  } catch {
    showMsg(customerError("verify"), "err");
  } finally {
    setLoading(verifyBtn, false);
  }
};

startBtn.onclick = async () => {
  if (!token) {
    showMsg("Please verify your phone first.", "err");
    return;
  }
  if (startRequestPending) return;
  startRequestPending = true;
  setLoading(startBtn, true);
  try {
    const available = await checkAvailability(true);
    if (available === false) return;
    const res = await api("/record/start", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    await res.text().catch(() => "");
    outEl.textContent = "";
    if (!res.ok) {
      showMsg(customerError("start", res.status), "err");
    } else {
      showMsg("Recording started. The system will stop automatically at the scheduled time. Thank you for choosing Hatrick LTD. Your video will be sent after the game.", "ok");
      pill.textContent = "Requested";
      pill.classList.remove("hidden", "red");
      startBtn.classList.add("hidden");
    }
  } catch {
    outEl.textContent = "";
    showMsg(customerError("start"), "err");
  } finally {
    startRequestPending = false;
    setLoading(startBtn, false);
  }
};

checkAvailability(true);
