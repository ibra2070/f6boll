// recordingServer.js
require('dotenv').config()

// ── Imports ──────────────────────────────────────────────────────────────────
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const jwt = require('jsonwebtoken')
const axios = require('axios')
const nodemailer = require('nodemailer')
const Redis = require('ioredis')
const { MongoClient } = require('mongodb')
const path = require('path')
const fs = require('fs')

// Twilio client (Node runtime only)
const twilio = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

// ── App setup ────────────────────────────────────────────────────────────────
const app = express()

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "script-src": ["'self'"], // serve local scripts only
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
)

app.use(express.json())

// CORS: lock to your site in production
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*'
app.use(cors({ origin: allowedOrigin, credentials: true }))

// Basic request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`)
  next()
})

// Health (plain text)
app.get('/health', (_req, res) => res.type('text/plain').send('OK'))

// Serve static site
const staticDir = path.resolve(__dirname, 'public')
console.log('🧭 Static dir:', staticDir)
console.log('📄 record.html exists?', fs.existsSync(path.join(staticDir, 'record.html')))
app.use(express.static(staticDir)) // /index.html, /record.html, assets...
app.use('/public', express.static(staticDir))
app.get('/record', (_req, res) => res.sendFile(path.join(staticDir, 'record.html')))
app.get('/__ls', (_req, res) => {
  fs.readdir(staticDir, (err, files) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ staticDir, files })
  })
})

// ── DB + Redis ───────────────────────────────────────────────────────────────
const client = new MongoClient(process.env.MONGO_URI)
const redis = new Redis(process.env.REDIS_URL) // use rediss:// for TLS

let db, Users, Recordings

;(async () => {
  try {
    await client.connect()
    db = client.db()
    Users = db.collection('users')
    Recordings = db.collection('recordings')

    await Users.createIndex({ phone: 1 }, { unique: true })
    await Recordings.createIndex({ cameraId: 1, lockOwnerTokenId: 1 })
    await Recordings.createIndex({ status: 1, cameraId: 1, startedAt: -1 })
  } catch (e) {
    console.error('Mongo init failed:', e.message)
  }
})().catch(console.error)

// ── Email (Gmail App Password) ───────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
})

// ── Helpers ─────────────────────────────────────────────────────────────────
function signJwt(payload, exp = '2h') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: exp })
}
function verifyJwtOrThrow401(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET)
  } catch (_e) {
    const err = new Error('Invalid or expired token')
    err.statusCode = 401
    throw err
  }
}
async function sendEmail(subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject,
      text
    })
  } catch (e) {
    console.error('Email send failed:', e.message)
  }
}
function getCameraUrl(type, cameraId) {
  const base = type === 'start' ? process.env.CAMERA_START_URL : process.env.CAMERA_STOP_URL
  return base.replace('<CAM_ID>', encodeURIComponent(cameraId))
}

// ── Redis lock helpers ───────────────────────────────────────────────────────
const LOCK_TTL_SEC = Number(process.env.LOCK_TTL_SEC || 2 * 60 * 60) // 2h
const OTP_LIMIT_SEC = Number(process.env.OTP_LIMIT_SEC || 60)

const UNLOCK_LUA = `
  local key   = KEYS[1]
  local owner = ARGV[1]
  if redis.call("GET", key) == owner then
    return redis.call("DEL", key)
  else
    return 0
  end
`
const lockKey = (cameraId) => `camera:${cameraId}:lock`

async function acquireLock(cameraId, ownerString, ttlSec = LOCK_TTL_SEC) {
  const ok = await redis.set(lockKey(cameraId), ownerString, 'NX', 'EX', ttlSec)
  return ok === 'OK'
}
async function currentLockOwner(cameraId) {
  return redis.get(lockKey(cameraId))
}
async function releaseLockIfOwner(cameraId, ownerString) {
  return redis.eval(UNLOCK_LUA, 1, lockKey(cameraId), ownerString)
}

// ── Twilio OTP endpoints ────────────────────────────────────────────────────
app.post('/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body
    if (!phone) return res.status(400).json({ error: 'Phone required' })

    // simple rate-limit: one SMS per phone per minute
    const limiterKey = `otp:limit:${phone}`
    const blocked = await redis.exists(limiterKey)
    if (blocked) return res.status(429).json({ error: 'Please wait before requesting another code' })
    await redis.set(limiterKey, '1', 'EX', OTP_LIMIT_SEC)

    await twilio.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID || process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'sms' })

    res.json({ ok: true })
  } catch (e) {
    console.error('Twilio send error:', e.code, e.message)
    res.status(500).json({ error: e.message })
  }
})

app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phone, cameraId, code } = req.body
    if (!phone || !code || !cameraId)
      return res.status(400).json({ error: 'Missing fields' })

    const check = await twilio.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID || process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code })

    if (check.status !== 'approved')
      return res.status(400).json({ error: 'Invalid code' })

    const lockOwnerTokenId = Math.random().toString(36).slice(2)
    const token = signJwt({ phone, cameraId, lockOwnerTokenId }, '2h')

    await Users.updateOne(
      { phone },
      { $setOnInsert: { phone, createdAt: new Date() } },
      { upsert: true }
    )

    res.json({ token })
  } catch (e) {
    console.error('Twilio verify error:', e.code, e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Start Recording ─────────────────────────────────────────────────────────
app.post('/record/start', async (req, res) => {
  let ownerString = null
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token' })

    const { phone, cameraId, lockOwnerTokenId } = verifyJwtOrThrow401(token)

    ownerString = `${cameraId}:${lockOwnerTokenId}`

    const locked = await acquireLock(cameraId, ownerString)
    if (!locked) {
      const active = await Recordings.findOne(
        { cameraId, status: 'active' },
        { sort: { startedAt: -1 }, projection: { phone: 1 } }
      )
      return res.status(409).json({
        error: 'Already recording',
        activeUser: active?.phone
      })
    }

    const url = getCameraUrl('start', cameraId)
    await axios.post(url, {}, { timeout: 8000 })

    await Recordings.insertOne({
      cameraId,
      phone,
      startedAt: new Date(),
      status: 'active',
      lockOwnerTokenId
    })

    await sendEmail(`🎥 Recording started on ${cameraId}`, `${phone} started recording.`)
    res.json({ ok: true })
  } catch (e) {
    try {
      if (ownerString) {
        const camId = ownerString.split(':')[0]
        await releaseLockIfOwner(camId, ownerString)
      }
    } catch (unlockErr) {
      console.error('unlock failed (start error path):', unlockErr.message)
    }
    const code = e.statusCode || 500
    res.status(code).json({ error: e.message })
  }
})

// ── Stop Recording ──────────────────────────────────────────────────────────
app.post('/record/stop', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token' })

    const { cameraId, lockOwnerTokenId } = verifyJwtOrThrow401(token)

    const current = await currentLockOwner(cameraId)
    if (!current) return res.status(400).json({ error: 'No active recording' })

    const ownerString = `${cameraId}:${lockOwnerTokenId}`
    if (current !== ownerString) {
      return res.status(403).json({ error: 'You are not the one who started recording' })
    }

    const url = getCameraUrl('stop', cameraId)
    await axios.post(url, {}, { timeout: 8000 })

    await Recordings.updateOne(
      { cameraId, lockOwnerTokenId, status: 'active' },
      { $set: { status: 'stopped', stoppedAt: new Date() } }
    )

    await releaseLockIfOwner(cameraId, ownerString)
    res.json({ ok: true })
  } catch (e) {
    const code = e.statusCode || 500
    res.status(code).json({ error: e.message })
  }
})

// ── Status + Heartbeat ──────────────────────────────────────────────────────
app.get('/record/status', async (req, res) => {
  const { cameraId } = req.query
  if (!cameraId) return res.status(400).json({ error: 'cameraId required' })
  const val = await currentLockOwner(cameraId)
  res.json({ active: !!val })
})

app.post('/record/heartbeat', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No token' })
    const { cameraId, lockOwnerTokenId } = verifyJwtOrThrow401(token)
    const ownerString = `${cameraId}:${lockOwnerTokenId}`
    const curr = await currentLockOwner(cameraId)
    if (curr !== ownerString) return res.status(409).json({ error: 'No active lock or not the owner' })
    await redis.expire(lockKey(cameraId), LOCK_TTL_SEC)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Export for Vercel. Listen only when run locally ─────────────────────────
const PORT = process.env.PORT || 3001
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('Server running on port', PORT)
    console.log('CORS origin:', allowedOrigin)
  })
}
module.exports = app

