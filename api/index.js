// api/index.js
// Expose the Express app to Vercel (@vercel/node)
const app = require('../recordingServer.js');

// Vercel detects an exported Express app and mounts it.
// Do not call app.listen() here.
module.exports = app;

