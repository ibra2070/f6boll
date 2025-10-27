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
const normPhone = (v) => v.trim().replace(/\s+/g, "");
function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : btn.dataset.label;
}
function logAny(outEl, payload) {
  try {
    const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
    outEl.textContent = JSON.stringify(obj, null, 2);
  } catch {
    outEl.textContent = String(payload);
  }
}

// --- camera id display (supports camerald typo too) ---------------------
const params = new URLSearchParams(location.search);
const cameraId = params.get("cameraId") || params.get("camerald") || "";
$("#camLabel").textContent = cameraId
  ? `Camera: ${cameraId}`
  : "Camera: (missing id)";

// --- state --------------------------------------------------------------
let token = null;
let sentPhone = null;
let heartbeatTimer = null;
let statusTimer = null;

const phoneEl = $("#phone");
const codeEl = $("#code");
const sendBtn = $("#send");
const verifyBtn = $("#verify");
const startBtn = $("#start");
const stopBtn = $("#stop");
const outEl = $("#out");
const pill = $("#statusPill");

sendBtn.dataset.label = "Send OTP";
verifyBtn.dataset.label = "Verify";
startBtn.dataset.label = "Start Recording";
stopBtn.dataset.label = "Stop Recording";

function setPill(active) {
  pill.classList.remove("hidden");
  if (active) {
    pill.textContent = "Active";
    pill.classList.remove("red");
  } else {
    pill.textContent = "Idle";
    pill.classList.add("red");
  }
}
async function refreshStatus() {
    if (!cameraId) return;
    try {
      const r = await fetch(`/api/record/status?cameraId=${encodeURIComponent(cameraId)}`);
      const j = await r.json();
      setPill(!!j.active, j); // optionally pass details
    } catch {
      pill.textContent = "Status unknown";
      pill.classList.remove("hidden");
    }
}
  


// --- actions ------------------------------------------------------------
sendBtn.onclick = async () => {
  hideMsg();
  const phone = normPhone(phoneEl.value);
  if (!phone || !phone.startsWith("+")) {
    showMsg("Enter your phone in international format, e.g. +9725…", "err");
    return;
  }

  setLoading(sendBtn, true);
  try {
    const r = await fetch("/api/auth/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error || "Failed to send OTP");
    }

    sentPhone = phone;
    phoneEl.disabled = true;
    $("#step2").classList.remove("hidden");
    showMsg("Code sent. Check your SMS.", "ok");
  } catch (err) {
    showMsg(err.message || "Failed to send OTP", "err");
  } finally {
    setLoading(sendBtn, false);
  }
};

verifyBtn.onclick = async () => {
  hideMsg();
  const code = codeEl.value.trim();
  if (!sentPhone) {
    showMsg("Send the OTP first.", "err");
    return;
  }
  if (!code) {
    showMsg("Enter the code you received.", "err");
    return;
  }

  setLoading(verifyBtn, true);
  try {
    const res = await fetch("/api/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: sentPhone, cameraId, code }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Verification failed");
    }

    token = data.token;
    $("#controls").classList.remove("hidden");
    showMsg("Phone verified. You can control the camera now.", "ok");

    await refreshStatus();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(refreshStatus, 10000);
  } catch (err) {
    showMsg(err.message || "Verification failed", "err");
  } finally {
    setLoading(verifyBtn, false);
  }
};

startBtn.onclick = async () => {
  if (!token) {
    showMsg("You must verify first.", "err");
    return;
  }
  setLoading(startBtn, true);
  try {
    const res = await fetch("/api/record/start", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
    const text = await res.text();
    logAny(outEl, text);
    if (!res.ok) {
      showMsg("Could not start recording. See details below.", "err");
    } else {
      showMsg("Recording started.", "ok");
      setPill(true);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(async () => {
        try {
          await fetch("/api/record/heartbeat", {
            method: "POST",
            headers: { Authorization: "Bearer " + token },
          });
        } catch {}
      }, 60000);
    }
  } catch (err) {
    logAny(outEl, String(err));
    showMsg("Network error while starting.", "err");
  } finally {
    setLoading(startBtn, false);
  }
};

stopBtn.onclick = async () => {
  if (!token) {
    showMsg("You must verify first.", "err");
    return;
  }
  setLoading(stopBtn, true);
  try {
    const res = await fetch("/api/record/stop", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
    });
    const text = await res.text();
    logAny(outEl, text);
    if (!res.ok) {
      showMsg("Could not stop recording. See details below.", "err");
    } else {
      showMsg("Recording stopped.", "ok");
      setPill(false);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  } catch (err) {
    logAny(outEl, String(err));
    showMsg("Network error while stopping.", "err");
  } finally {
    setLoading(stopBtn, false);
  }
};

// initial status (even before verify, if cam id present)
refreshStatus();
