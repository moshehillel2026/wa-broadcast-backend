'use strict';

/**
 * webhookRoutes.js — Meta WhatsApp Webhook Endpoints
 *
 * Meta requires two endpoints on the same path:
 *
 *  GET  /webhook/whatsapp  → Webhook Verification (one-time setup in Meta dashboard)
 *  POST /webhook/whatsapp  → Inbound payload ingestion (statuses + messages)
 *
 * CRITICAL DESIGN PRINCIPLE:
 * The POST handler must return HTTP 200 within 20 seconds or Meta will retry
 * the delivery. We achieve this by:
 *  1. Validating the HMAC signature synchronously (fast)
 *  2. Writing the raw payload to a Redis queue (fast)
 *  3. Returning 200 immediately
 *  4. Processing asynchronously in the webhookWorker
 *
 * Meta webhook payload documentation:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { verifyMetaWebhookSignature } = require('../middleware/auth');
const { webhookQueue, optoutQueue } = require('../queues/queues');
const logger = require('../config/logger');

const router = express.Router();

// ─── GET /webhook/whatsapp — Verification Handshake ─────────────────────────
/**
 * Meta calls this endpoint once when you configure the webhook in the dashboard.
 * It sends three query params and expects the hub.challenge back if valid.
 *
 * Query params from Meta:
 *  - hub.mode         : always "subscribe"
 *  - hub.verify_token : the token you set in Meta dashboard (must match META_WEBHOOK_VERIFY_TOKEN)
 *  - hub.challenge    : a random number Meta expects echoed back
 */
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logger.info('[Webhook] Received verification request', { mode, tokenMatches: token === process.env.META_WEBHOOK_VERIFY_TOKEN });

  // Validate mode and token
  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    logger.info('[Webhook] Verification successful — sending challenge back to Meta');
    // Respond with challenge as plain text (not JSON)
    return res.status(200).send(challenge);
  }

  logger.warn('[Webhook] Verification FAILED — token mismatch or wrong mode', { mode, receivedToken: token });
  return res.status(403).json({ error: 'Forbidden: verification token mismatch' });
});

// ─── POST /webhook/whatsapp — Payload Ingestion ──────────────────────────────
/**
 * This route receives ALL inbound events from Meta:
 *  - Status updates: sent, delivered, read, failed (for our outbound messages)
 *  - Inbound messages: text replies, button clicks, media from contacts
 *
 * Processing pipeline:
 *  1. Capture raw body for HMAC verification (requires rawBody middleware below)
 *  2. Validate X-Hub-Signature-256 header
 *  3. Check idempotency — reject duplicate payloads
 *  4. Route payload type to appropriate queue
 *  5. Return 200 immediately
 */
router.post('/', async (req, res) => {
  // --- Step 1: HMAC Signature Verification ---
  const signature = req.headers['x-hub-signature-256'];
  const rawBody   = req.rawBody; // Set by the rawBodyMiddleware below

  if (!rawBody) {
    logger.error('[Webhook] rawBody not available — ensure rawBodyMiddleware is applied');
    return res.status(500).json({ error: 'Internal configuration error' });
  }

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    logger.warn('[Webhook] HMAC signature verification FAILED', {
      ip: req.ip,
      signature: signature?.slice(0, 20) + '...',
    });
    // Still return 200 to prevent Meta from retrying a bad request
    return res.status(200).send('OK');
  }

  // --- Step 2: Parse and validate payload structure ---
  const payload = req.body;

  if (payload?.object !== 'whatsapp_business_account') {
    logger.debug('[Webhook] Non-WhatsApp payload ignored', { object: payload?.object });
    return res.status(200).send('OK');
  }

  // --- Step 3: Extract entries and classify ---
  const entries = payload?.entry || [];

  if (entries.length === 0) {
    return res.status(200).send('OK');
  }

  // --- Step 4: Return 200 IMMEDIATELY before async processing ---
  res.status(200).send('OK');

  // --- Step 5: Enqueue for async processing (fire-and-forget after response) ---
  try {
    for (const entry of entries) {
      const changes = entry?.changes || [];

      for (const change of changes) {
        const value = change?.value;
        if (!value) continue;

        // Unique job ID = prevents duplicate processing if Meta sends same payload twice
        const jobId = `webhook-${entry.id}-${uuidv4()}`;

        // --- Status updates (our outbound messages) ---
        if (value.statuses && value.statuses.length > 0) {
          await webhookQueue.add('status-update', {
            type: 'status',
            statuses: value.statuses,
            metadata: value.metadata,
            receivedAt: Date.now(),
          }, { jobId });

          logger.debug('[Webhook] Status update(s) enqueued', {
            count: value.statuses.length,
            statuses: value.statuses.map(s => s.status),
            jobId,
          });
        }

        // --- Inbound messages (replies from contacts) ---
        if (value.messages && value.messages.length > 0) {
          for (const message of value.messages) {
            const msgJobId = `msg-${message.id}`;

            // Detect opt-out keywords (STOP, הסר, בטל, cancel, etc.)
            const isOptOut = isOptOutMessage(message);

            if (isOptOut) {
              // Route to isolated high-priority opt-out queue
              await optoutQueue.add('optout', {
                phone: message.from,
                wamid: message.id,
                text: message.text?.body,
                timestamp: message.timestamp,
              }, { jobId: `optout-${message.id}`, priority: 1 });

              logger.info('[Webhook] Opt-out request enqueued', { phone: message.from });
            } else {
              // Route to general webhook queue for logging / conversational handling
              await webhookQueue.add('inbound-message', {
                type: 'message',
                message,
                metadata: value.metadata,
                contacts: value.contacts,
                receivedAt: Date.now(),
              }, { jobId: msgJobId });

              logger.debug('[Webhook] Inbound message enqueued', {
                from: message.from,
                type: message.type,
                jobId: msgJobId,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    // Error here doesn't affect the 200 we already sent to Meta
    logger.error('[Webhook] Failed to enqueue webhook payload', {
      error: err.message,
      stack: err.stack,
    });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Detects opt-out intent in inbound text messages.
 * Covers Hebrew and English common opt-out phrases.
 *
 * @param {object} message - Meta message object
 * @returns {boolean}
 */
function isOptOutMessage(message) {
  if (message.type !== 'text') return false;
  const text = (message.text?.body || '').trim().toLowerCase();
  const optOutKeywords = [
    'stop', 'unsubscribe', 'cancel', 'opt out', 'optout',
    'הסר', 'בטל', 'הפסק', 'אל תשלח', 'הורד', 'לא מעוניין',
  ];
  return optOutKeywords.some(kw => text.includes(kw));
}

// ─── Raw Body Middleware ──────────────────────────────────────────────────────
/**
 * Meta's HMAC verification requires the raw, unmodified request body.
 * Express's json() middleware parses and discards the raw buffer.
 * We must capture it BEFORE json() runs, using this middleware.
 *
 * Apply this ONLY to the webhook route in server.js:
 *   app.use('/webhook/whatsapp', rawBodyMiddleware, webhookRouter);
 *
 * Do NOT use express.json() globally before this route.
 */
function rawBodyMiddleware(req, res, next) {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
}

module.exports = { webhookRouter: router, rawBodyMiddleware };
