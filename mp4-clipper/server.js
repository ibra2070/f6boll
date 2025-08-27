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

    // Video filter: cap width, keep AR, even dims, yuv420p
    const vf = [
      `scale='min(${MAX_WIDTH},iw)':-2:force_original_aspect_ratio=decrease`,
      'pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2',
      'format=yuv420p'
    ].join(',');

    const args = [
      '-hide_banner','-loglevel','error','-nostdin',
      '-protocol_whitelist','file,crypto,https,tcp,tls',
      '-rw_timeout','15000000',
      '-user_agent','FisionClipper/1.0',

      // trim first → speeds up processing
      '-ss', String(start),
      '-t',  String(duration),

      // input
      '-i', m3u8Url,

      // select streams
      '-map','0:v?','-map','0:a?',

      // output shaping
      '-r', FPS,
      '-vf', vf,

      // encoders (single thread keeps RAM/CPU tiny on free tier)
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

    // Kill ffmpeg if client disconnects
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

    ff.on('exit', (codeExit, signal) => {
      if (!hadData && !sentHeaders) {
        const msg = (errLog.trim() || `ffmpeg exited. code=${codeExit} signal=${signal}`).slice(0, 1800);
        return res.status(500).type('text').end(msg);
      }
      if (!res.writableEnded) res.end();
      if (codeExit !== 0 || signal) {
        console.error('ffmpeg exit', { codeExit, signal, err: errLog });
      }
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
