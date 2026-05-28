// recordingServer.js
require('dotenv').config();

// ── Imports ──────────────────────────────────────────────────────────────────
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const nodemailer = require('nodemailer');
const Redis = require('ioredis');
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');
const twilio = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── App setup ────────────────────────────────────────────────────────────────
const app = express();

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'"], // use local hls.min.js & panzoom.min.js
        "style-src": ["'self'", "https:", "'unsafe-inline'"],
        "connect-src": [
          "'self'",
          "fision-videos-worker.myfisionupload.workers.dev",
          "*.cloudflarestream.com"
        ],
        "media-src": [
          "'self'",
          "blob:",
          "fision-videos-worker.myfisionupload.workers.dev",
          "*.cloudflarestream.com"
        ],
        "img-src": [
          "'self'",
          "data:",
          "fision-videos-worker.myfisionupload.workers.dev",
          "*.cloudflarestream.com"
        ]
      }
    }
  })
);

app.use(express.json());

// CORS: lock to your site in production (optional)
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin, credentials: true }));

// Log every request (helpful in ops)
app.use((req, _res, next) => {
  const url = req.originalUrl || req.url;
  console.log(`[${new Date().toISOString()}] ${req.method} ${url}`);
  next();
});

// Health (plain text)
app.get('/health', (_req, res) => res.type('text/plain').send('OK'));

// Serve static site locally only (Vercel serves /public via vercel.json)
if (!process.env.VERCEL) {
  const staticDir = path.resolve(__dirname, 'public');
  console.log('🧭 Static dir:', staticDir);
  console.log('📄 record.html exists?', fs.existsSync(path.join(staticDir, 'record.html')));
  app.use(express.static(staticDir)); // /record.html
  app.use('/public', express.static(staticDir));
  app.get('/record', (_req, res) => res.sendFile(path.join(staticDir, 'record.html')));
  app.get('/__ls', (_req, res) => {
    fs.readdir(staticDir, (err, files) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ staticDir, files });
    });
  });
}

// ── DB + Redis ───────────────────────────────────────────────────────────────
const client = new MongoClient(process.env.MONGO_URI, {
  // optional: keepAlive etc. (Atlas Serverless is recommended for Vercel)
});
const redis = new Redis(process.env.REDIS_URL); // expect rediss://... for TLS

let db, Users, Recordings;

(async () => {
  await client.connect();
  db = client.db();
  Users = db.collection('users');
  Recordings = db.collection('recordings');
  console.log('Mongo initialized');

  // Useful indexes
  await Users.createIndex({ phone: 1 }, { unique: true });
  await Recordings.createIndex({ cameraId: 1, lockOwnerTokenId: 1 });
  await Recordings.createIndex({ status: 1, cameraId: 1, startedAt: -1 });
})().catch(err => {
  console.warn('Mongo init failed; continuing without Mongo:', err.message);
});

// ── Email (Gmail App Password) ───────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function signJwt(payload, exp = '2h') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: exp });
}
function verifyJwtOrThrow401(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    const err = new Error('Invalid or expired token');
    err.statusCode = 401;
    throw err;
  }
}
async function sendEmail(subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject,
      text
    });
  } catch (e) {
    console.error('Email send failed:', e.message);
    // don’t throw; we don’t want to block the user if email is down
  }
}
function getCameraUrl(type, cameraId) {
  const base = type === 'start' ? process.env.CAMERA_START_URL : process.env.CAMERA_STOP_URL;
  return base.replace('<CAM_ID>', encodeURIComponent(cameraId));
}
function getCameraStatusUrl() {
  return process.env.CAMERA_STATUS_URL;
}
function normalizeIsraeliPhone(value) {
  if (typeof value !== 'string') return null;

  const compact = value.trim().replace(/[\s-]/g, '');
  if (/^05\d{8}$/.test(compact)) {
    return `+972${compact.slice(1)}`;
  }
  if (/^\+?9725\d{8}$/.test(compact)) {
    return compact.startsWith('+') ? compact : `+${compact}`;
  }
  return null;
}
function toIsraeliLocalPhone(value) {
  if (typeof value !== 'string') return null;

  const compact = value.trim().replace(/[\s-]/g, '');
  if (/^05\d{8}$/.test(compact)) {
    return compact;
  }
  if (/^\+?9725\d{8}$/.test(compact)) {
    return `0${compact.replace(/^\+?972/, '')}`;
  }
  return null;
}
// ── Redis lock helpers (owner-checked unlock) ────────────────────────────────
const REQUEST_LOCK_TTL_SEC = Number(process.env.REQUEST_LOCK_TTL_SEC || 60);
const OTP_LIMIT_SEC = Number(process.env.OTP_LIMIT_SEC || 60);

const UNLOCK_LUA = `
  local key   = KEYS[1]
  local owner = ARGV[1]
  if redis.call("GET", key) == owner then
    return redis.call("DEL", key)
  else
    return 0
  end
`;

const lockKey = (cameraId) => `camera:${cameraId}:lock`;
const requestLockKey = (cameraId) => `camera:${cameraId}:request`;

async function currentLockOwner(cameraId) {
  return redis.get(lockKey(cameraId)); // returns raw owner string or null
}
async function releaseLockIfOwner(cameraId, ownerString) {
  return redis.eval(UNLOCK_LUA, 1, lockKey(cameraId), ownerString);
}
async function acquireRequestLock(cameraId, ownerString) {
  const ok = await redis.set(requestLockKey(cameraId), ownerString, 'NX', 'EX', REQUEST_LOCK_TTL_SEC);
  return ok === 'OK';
}
async function releaseRequestLockIfOwner(cameraId, ownerString) {
  return redis.eval(UNLOCK_LUA, 1, requestLockKey(cameraId), ownerString);
}

// ── Twilio OTP endpoints ────────────────────────────────────────────────────
app.post('/auth/send-otp', async (req, res) => {
  try {
    const phone = normalizeIsraeliPhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid Israeli mobile number' });

    // simple rate-limit: one SMS per phone per minute (tolerant to Redis hiccups)
    let blocked = false;
    try {
      const limiterKey = `otp:limit:${phone}`;
      blocked = await redis.exists(limiterKey);
      if (!blocked) await redis.set(limiterKey, '1', 'EX', OTP_LIMIT_SEC);
    } catch (e) {
      console.warn('Redis unavailable, skipping OTP rate-limit:', e.message);
    }
    if (blocked) return res.status(429).json({ error: 'Please wait before requesting another code' });

    await twilio.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { cameraId, code } = req.body || {};
    const phone = normalizeIsraeliPhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid Israeli mobile number' });
    if (!code || !cameraId)
      return res.status(400).json({ error: 'Missing fields' });

    const check = await twilio.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== 'approved')
      return res.status(400).json({ error: 'Invalid code' });

    const lockOwnerTokenId = Math.random().toString(36).slice(2);
    const token = signJwt({ phone, cameraId, lockOwnerTokenId }, '2h');

    try {
      if (Users) {
        await Users.updateOne(
          { phone },
          { $setOnInsert: { phone, createdAt: new Date() } },
          { upsert: true }
        );
      } else {
        console.warn('Mongo Users collection not ready; skipping user upsert');
      }
    } catch (e) {
      console.warn('User upsert failed; continuing verification:', e.message);
    }

    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start Recording ─────────────────────────────────────────────────────────
app.post('/record/start', async (req, res) => {
  let requestLockOwner = null;
  let requestCameraId = null;
  let requestLockAcquired = false;
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    const { phone, cameraId, lockOwnerTokenId } = verifyJwtOrThrow401(token);
    const localPhone = toIsraeliLocalPhone(phone);
    if (!localPhone) return res.status(400).json({ error: 'Invalid Israeli mobile number' });

    requestCameraId = cameraId;
    requestLockOwner = `${cameraId}:${lockOwnerTokenId}`;

    const locked = await acquireRequestLock(cameraId, requestLockOwner);
    if (!locked) {
      return res.status(423).json({
        error: 'A recording request is already being processed'
      });
    }
    requestLockAcquired = true;

    // Request recording using the verified phone identity.
    const url = getCameraUrl('start', cameraId);
    const recordingRequest = { phone: localPhone };
    console.log('Requesting recording', { phone: localPhone, cameraId, hasTime: false });
    await axios.post(url, recordingRequest, {
      timeout: 8000,
      headers: { 'Content-Type': 'application/json' }
    });

    await Recordings.insertOne({
      cameraId,
      phone,
      requestedAt: new Date(),
      status: 'requested',
      lockOwnerTokenId
    });

    await sendEmail(`🎥 Recording requested on ${cameraId}`, `${phone} requested recording.`);
    res.json({ ok: true });
  } catch (e) {
    const upstreamStatus = e.response?.status;
    if (upstreamStatus === 409) {
      return res.status(409).json({ error: 'Recording is already in progress or unavailable' });
    }
    if (upstreamStatus === 422) {
      return res.status(422).json({ error: 'The recording request could not be accepted' });
    }
    if (e.isAxiosError) {
      return res.status(503).json({ error: 'Recording service is temporarily unavailable' });
    }
    const code = e.statusCode || 500;
    res.status(code).json({ error: code === 401 ? e.message : 'Unable to complete recording request' });
  } finally {
    try {
      if (requestLockAcquired && requestCameraId && requestLockOwner) {
        await releaseRequestLockIfOwner(requestCameraId, requestLockOwner);
      }
    } catch (unlockErr) {
      console.error('request lock release failed:', unlockErr.message);
    }
  }
});

// ── Stop Recording ──────────────────────────────────────────────────────────
app.post('/record/stop', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    const { cameraId, lockOwnerTokenId } = verifyJwtOrThrow401(token);

    const current = await currentLockOwner(cameraId);
    if (!current) return res.status(400).json({ error: 'No active recording' });

    const ownerString = `${cameraId}:${lockOwnerTokenId}`;
    if (current !== ownerString) {
      return res.status(403).json({ error: 'You are not the one who started recording' });
    }

    const url = getCameraUrl('stop', cameraId);
    await axios.post(url, {}, { timeout: 8000 });

    await Recordings.updateOne(
      { cameraId, lockOwnerTokenId, status: 'active' },
      { $set: { status: 'stopped', stoppedAt: new Date() } }
    );

    await releaseLockIfOwner(cameraId, ownerString);
    res.json({ ok: true });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: e.message });
  }
});

// ── Status + Heartbeat ──────────────────────────────────────────────────────
app.get('/record/status', async (req, res) => {
  try {
    const { cameraId } = req.query;
    if (!cameraId) return res.status(400).json({ error: 'cameraId required' });
    const statusUrl = getCameraStatusUrl();
    if (!statusUrl) return res.status(503).json({ error: 'Recording status unavailable' });

    const upstream = await axios.get(statusUrl, {
      params: { cameraId },
      timeout: 8000
    });
    const data = upstream.data || {};
    if (typeof data.available !== 'boolean') {
      return res.status(502).json({ error: 'Recording status unavailable' });
    }
    res.json({
      available: data.available,
      recording: Boolean(data.recording),
      status: typeof data.status === 'string' ? data.status : undefined,
      start: typeof data.start === 'string' ? data.start : undefined,
      until: typeof data.until === 'string' ? data.until : undefined
    });
  } catch {
    res.status(503).json({ error: 'Recording status unavailable' });
  }
});

app.post('/record/heartbeat', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    verifyJwtOrThrow401(token);
    res.json({ ok: true, trackingRecordingState: false });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ error: code === 401 ? e.message : 'Heartbeat unavailable' });
  }
});

// ── Start server / export app ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
if (process.env.VERCEL) {
  // On Vercel we export the Express app; routing is handled by vercel.json
  module.exports = app;
} else {
  app.listen(PORT, () => console.log('Server running on', PORT));
}
