 // server.js — HLS → MP4 clipper (H.264/AAC) using ffmpeg
// CommonJS so it runs on plain Node without ESM config

const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8080;

// HLS origin (your Cloudflare Worker)
const BASE = process.env.HLS_BASE || 'https://fision-videos-worker.myfisionupload.workers.dev';
const PLAYLIST = process.env.PLAYLIST || 'stream_0.m3u8';

// Limits / quality
const MAX_SECONDS = Number(process.env.MAX_SECONDS || 600); // 10 min
const PRESET = process.env.PRESET || 'veryfast';
const CRF = process.env.CRF || '22';
const FPS = process.env.FPS || '30';
const MAX_WIDTH = Number(process.env.MAX_WIDTH || 1080);

// CORS (relaxed while testing; lock to your domain later)
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  next();
});

app.get('/health', (_req, res) => res.type('text').send('ok'));

app.get('/clip', async (req, res) => {
  try {
    const code  = String(req.query.code || '').trim();
    const start = Number(req.query.start || 0);
    const end   = Number(req.query.end   || 0);

    if (!code || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).type('text').end('Bad params: code/start/end');
    }

    const duration = +(end - start).toFixed(3);
    if (duration > MAX_SECONDS) {
      return res.status(400).type('text').end(`Max clip length is ${MAX_SECONDS}s`);
    }

    const m3u8Url = `${BASE}/videos/${encodeURIComponent(code)}/${PLAYLIST}`;
    const outfile = `clip_${code}_${Math.floor(start)}-${Math.floor(end)}.mp4`;

    // Video filter: cap width, keep AR, even dimensions, yuv420p
    const vf = [
      `scale='min(${MAX_WIDTH},iw)':-2:force_original_aspect_ratio=decrease`,
      'pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2',
      'format=yuv420p'
    ].join(',');

    const args = [
      '-hide_banner','-loglevel','error','-nostdin',
      // remote HLS sometimes needs this whitelist on some hosts
      '-protocol_whitelist','file,crypto,https,tcp,tls',
      // network + UA
      '-rw_timeout','15000000',
      '-user_agent','FisionClipper/1.0',

      // trim first for speed
      '-ss', String(start),
      '-t', String(duration),

      // input
      '-i', m3u8Url,

      // select streams
      '-map','0:v?','-map','0:a?',

      // shape output
      '-r', FPS,
      '-vf', vf,

      // encoder — single thread for stability on small instances
      '-c:v','libx264',
      '-preset', PRESET,
      '-crf', CRF,
      '-profile:v','high',
      '-level','4.1',
      '-pix_fmt','yuv420p',
      '-threads','1',

      '-c:a','aac',
      '-b:a','128k',
      '-ac','2',

      '-movflags','+faststart',
      '-f','mp4',
      'pipe:1'
    ];

    const ff = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });

    // kill ffmpeg if client cancels
    req.on('aborted', () => { try { ff.kill('SIGKILL'); } catch {} });

    let sentHeaders = false;
    let hadData = false;
    let errLog = '';

    ff.stdout.once('data', (chunk) => {
      hadData = true;
      if (!sentHeaders) {
        sentHeaders = true;
        res.status(200);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `attachment; filename="${outfile}"`);
      }
      res.write(chunk);
      ff.stdout.pipe(res);
    });

    ff.stderr.on('data', d => { errLog += d.toString(); });

    ff.on('close', (codeExit) => {
      if (!hadData && !sentHeaders) {
        return res.status(500).type('text').end((errLog.trim() || `ffmpeg exited. code=${codeExit}`).slice(0, 2000));
      }
      if (!res.writableEnded) res.end();
      if (codeExit !== 0) console.error('ffmpeg exit', codeExit, errLog);
    });

    ff.on('error', (e) => {
      console.error('spawn error', e);
      if (!sentHeaders) res.status(500).type('text').end('spawn error: ' + (e.message || e));
      else try { res.end(); } catch {}
    });

  } catch (e) {
    console.error('handler', e);
    res.status(500).type('text').end('Server error: ' + (e.message || e));
  }
});

app.listen(PORT, () => console.log('MP4 clipper on :' + PORT));
