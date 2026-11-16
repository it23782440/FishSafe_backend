require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const connectDB = require('./config/db');
const registry = require('./services/speciesRegistry');
const watchdog = require('./services/watchdog');

const PORT = process.env.PORT || 5000;
let server;

async function start() {
  await connectDB();
  await registry.seedDefaults(); // adds missing built-in species; never overwrites edits
  await registry.load();
  console.log(`[SPECIES] ${registry.ids().length} species registered: ${registry.ids().join(', ')}`);
  watchdog.start();
  server = app.listen(PORT, () => {
    console.log(`[HTTP] FishSafe backend listening on port ${PORT}`);
    console.log(`[HTTP] Health: http://localhost:${PORT}/api/health`);
  });
}

start();

// Graceful shutdown: Render sends SIGTERM on every deploy/restart.
async function shutdown(signal) {
  console.log(`[SYS] ${signal} received, shutting down...`);
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Fail loud on unhandled rejections so Render restarts the service.
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
  process.exit(1);
});
