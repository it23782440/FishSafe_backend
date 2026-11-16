const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const apiRoutes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

// --- Security headers ---
app.use(helmet());

// Behind Render's proxy: without this every client shares the proxy's IP and
// the rate limiter would throttle all users together.
app.set('trust proxy', 1);

// --- CORS ---
// Allowed: localhost (any port), origins listed in CORS_ORIGINS (comma separated),
// and https://*.vercel.app unless CORS_STRICT=true.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const VERCEL_ORIGIN = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
const listed = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);
const allowVercel = process.env.CORS_STRICT !== 'true';

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header: curl, Postman, the ESP32, server-to-server.
      if (!origin) return callback(null, true);
      const ok =
        LOCAL_ORIGIN.test(origin) ||
        listed.includes(origin) ||
        (allowVercel && VERCEL_ORIGIN.test(origin));
      // Not allowed -> no CORS headers (browser blocks it); no server error.
      return callback(null, ok);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  })
);

app.use(compression());

// --- Body parsing ---
app.use(express.json({ limit: '16kb' }));

// --- Rate limiting ---
// The dashboard polls several endpoints every 10-30 s (about 30-45 requests/min per open tab),
// and farms/phones often share one IP, so reads get a generous allowance.
// Anything that changes data (POST/PUT/PATCH/DELETE, including the ESP32 uploads) is limited tighter.
const limiterOpts = { windowMs: 60 * 1000, standardHeaders: true, legacyHeaders: false };
app.use('/api', rateLimit({ ...limiterOpts, max: parseInt(process.env.RATE_LIMIT_READ, 10) || 600, skip: (req) => req.method !== 'GET' && req.method !== 'HEAD' }));
app.use('/api', rateLimit({ ...limiterOpts, max: parseInt(process.env.RATE_LIMIT_WRITE, 10) || 120, skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' }));

// --- Routes ---
app.get('/', (req, res) =>
  res.json({ service: 'FishSafe API', docs: '/api/health' })
);
app.use('/api', apiRoutes);

// --- 404 + error handling ---
app.use(notFound);
app.use(errorHandler);

module.exports = app;