'use strict';

/**
 * server.js — Express Application Entry Point
 *
 * Initializes and starts the WhatsApp Broadcasting API server.
 *
 * Architecture note:
 * This file runs the API server ONLY. The BullMQ workers run in separate
 * processes (src/workers/broadcastWorker.js and src/workers/webhookWorker.js).
 * On Render, deploy them as separate "Background Worker" services.
 *
 * Port: defaults to 3000, overridden by PORT env var (Render sets this automatically).
 */

// Load environment variables first — must be before any other imports
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');

const logger  = require('./config/logger');
const { webhookRouter, rawBodyMiddleware } = require('./routes/webhookRoutes');
const campaignRoutes = require('./routes/campaignRoutes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ──────────────────────────────────────────────────────

/**
 * Helmet — sets secure HTTP headers automatically.
 * Protects against clickjacking, MIME sniffing, XSS, etc.
 */
app.use(helmet());

/**
 * CORS — allow requests only from your WordPress site.
 * In development, temporarily use '*' for local testing.
 */
const allowedOrigins = [
  process.env.WP_SITE_URL,
  'http://localhost',
  'http://localhost:3000',
  'http://localhost:8080',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Render health checks, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    logger.warn('[CORS] Blocked origin', { origin });
    callback(new Error('CORS policy: origin not allowed'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
/**
 * Global rate limiter — protects against brute-force and DDoS.
 * Applied to all /api/* routes. The webhook route has its own protection via HMAC.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 100,               // Max 100 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please slow down' },
});

app.use('/api', apiLimiter);

// ─── Request Logging ──────────────────────────────────────────────────────────
/**
 * Morgan HTTP request logger.
 * Uses 'combined' format in production (includes IP, user-agent),
 * and 'dev' format locally (colorized, compact).
 *
 * Streams to Winston so all logs go through the same transport.
 */
app.use(morgan(
  process.env.NODE_ENV === 'production' ? 'combined' : 'dev',
  {
    stream: { write: (msg) => logger.http(msg.trim()) },
    // Skip health check logs to reduce noise
    skip: (req) => req.url === '/health',
  }
));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
/**
 * IMPORTANT: The webhook route MUST be mounted BEFORE express.json() is applied.
 * Meta's HMAC verification requires the raw, unparsed body.
 * The rawBodyMiddleware (applied per-route) handles JSON parsing for the webhook.
 */

// Mount webhook routes FIRST — with raw body middleware, NOT express.json()
app.use('/webhook/whatsapp', rawBodyMiddleware, webhookRouter);

// Now apply JSON parsing for all other routes
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * Health Check — Required by Render for deployment verification.
 * Render pings this endpoint and expects 200 within 5 seconds.
 * Returns server status, uptime, and environment info.
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'wa-broadcast-backend',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/**
 * API routes — protected by JWT (applied inside campaignRoutes)
 */
app.use('/api', campaignRoutes);

/**
 * 404 handler — catches any unmatched routes
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.url}`,
  });
});

/**
 * Global error handler — catches any errors thrown in route handlers.
 * Must have 4 parameters for Express to recognize it as an error handler.
 */
app.use((err, req, res, _next) => {
  logger.error('[Server] Unhandled error', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info('[Server] WhatsApp Broadcasting API started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      health:  `http://localhost:${PORT}/health`,
      webhook: `http://localhost:${PORT}/webhook/whatsapp`,
      api:     `http://localhost:${PORT}/api`,
    },
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
/**
 * Render sends SIGTERM before stopping a service.
 * We close the HTTP server gracefully to finish in-flight requests.
 */
function shutdown(signal) {
  logger.info(`[Server] ${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('[Server] HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    logger.warn('[Server] Forcing exit after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Log unhandled promise rejections (don't crash the process, just alert)
process.on('unhandledRejection', (reason, promise) => {
  logger.error('[Server] Unhandled Promise Rejection', {
    reason: String(reason),
    promise: String(promise),
  });
});

module.exports = app; // Exported for testing
