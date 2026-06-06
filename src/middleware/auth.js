'use strict';

/**
 * auth.js — JWT Authentication Middleware
 *
 * Validates Bearer tokens on protected routes.
 * Tokens are issued by the WordPress site (using WP JWT Auth plugin)
 * and verified here using the shared WP_JWT_SECRET.
 *
 * Usage on a route:
 *   const { requireAuth } = require('../middleware/auth');
 *   router.post('/campaigns', requireAuth, campaignController.create);
 */

const logger = require('../config/logger');

/**
 * Lightweight JWT verification without jsonwebtoken dependency.
 * For production with complex claims, replace with the `jsonwebtoken` package.
 *
 * @param {string} token - Raw JWT string
 * @param {string} secret - Shared secret
 * @returns {object} Decoded payload
 */
function verifyJWT(token, secret) {
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error('Malformed JWT');
  }

  // Verify signature using Node's built-in crypto
  const crypto = require('crypto');
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  if (expectedSig !== signatureB64) {
    throw new Error('Invalid JWT signature');
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

  // Check expiry
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('JWT expired');
  }

  return payload;
}

/**
 * requireAuth middleware — attach to any route that must be protected.
 * Sets req.user to the decoded JWT payload on success.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Missing or malformed Authorization header. Expected: Bearer <token>',
    });
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyJWT(token, process.env.WP_JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    logger.warn('[Auth] JWT verification failed', { error: err.message, ip: req.ip });
    return res.status(401).json({ success: false, error: 'Unauthorized: ' + err.message });
  }
}

/**
 * verifyMetaWebhookSignature — validates HMAC-SHA256 from Meta.
 * Called in the webhook POST route BEFORE enqueuing any payload.
 *
 * Meta sends: X-Hub-Signature-256: sha256=<hex>
 *
 * @param {string} rawBody - Raw request body string (before JSON.parse)
 * @param {string} signature - Value of X-Hub-Signature-256 header
 * @returns {boolean}
 */
function verifyMetaWebhookSignature(rawBody, signature) {
  if (!signature || !signature.startsWith('sha256=')) return false;

  const crypto = require('crypto');
  const expected = crypto
    .createHmac('sha256', process.env.META_APP_SECRET)
    .update(rawBody)
    .digest('hex');

  const received = signature.slice(7); // Strip 'sha256=' prefix

  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = { requireAuth, verifyMetaWebhookSignature };
