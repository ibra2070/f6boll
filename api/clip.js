// api/clip.js  — Vercel Node serverless function (CommonJS)
// NOTE: Do NOT run this on the Edge runtime. Keep it as a Node function.

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Your Cloudflare Worker base + playlist name
const BASE = 'https://fision-videos-worker.myfisionupload.workers.dev';
const PLAYLIST = 'stream_0.m3u8';

// Max allowed clip length (in seconds)
const MAX_LEN = 600; // 10 minutes

module.exports = async (req, res) => {
  try {
    // Read query params (Vercel populates req.query in Node functions)
    const q = req.query || {};
    const code = (q.code || '').trim();
    const start = parseFloat(q.start || '0');
    const end = parseFloat(q.end || '0');

    if (!code || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      res.statusCode = 400;
      return res.end('Bad params');
    }

    const duration = +(end - start).toFixed(3);
    if (duration > MAX_LEN) {
      res.statusCode = 400;
      return res.end(`Max clip length is ${MAX_LEN}s`);
    }

    // Full HLS playlist URL for this code
    const m3u8Url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;

    // ffmpeg args:
    // - fast seek with -ss BEFORE -i
    // - -t limits duration
    // - "-c copy" remux to MP4 (no re-encode) → fast + mobile friendly
    // - protocol whitelist for HTTPS HLS in serverless envs
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file,crypto,data,http,https,tcp,tls',
      '-ss', String(start),
      '-t', String(duration),
      '-i', m3u8Url,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-f', 'mp4',
      'pipe:1'
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Stream MP4 out as it's produced
    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4"`
    );

    proc.stdout.pipe(res);

    let errLog = '';
    proc.stderr.on('data', d => { errLog += d.toString(); });

    proc.on('close', codeExit => {
      if (codeExit !== 0) {
        console.error('ffmpeg exit', codeExit, errLog);
        try { res.end(); } catch {}
      }
    });

    proc.on('error', e => {
      console.error('ffmpeg spawn error', e);
      try {
        if (!res.headersSent) res.statusCode = 500;
        res.end('Server error');
      } catch {}
    });
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end('Server error');
  }
};
