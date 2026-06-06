'use strict';

/**
 * broadcastWorker.js — BullMQ Worker for outbound WhatsApp message delivery
 *
 * This file is the heart of the broadcasting engine. It runs as a SEPARATE process
 * from the Express server (started with: node src/workers/broadcastWorker.js).
 *
 * On Render, deploy this as a separate "Background Worker" service pointing to this file.
 * It shares the same Redis instance as the API server.
 *
 * Processing flow per job (batch of 50 contacts):
 *  1. Extract campaign + contacts from job data
 *  2. Check phone quality rating (pause if RED)
 *  3. For each contact: send via Meta API with 12ms delay between sends
 *  4. Collect results (success wamids + failures)
 *  5. POST results back to WP site to update wa_message_logs
 *  6. Job complete (BullMQ marks it completed or failed for retry)
 *
 * Rate limiting strategy:
 *  - 12ms delay between each individual send = ~83 msg/sec (safely under 80/sec limit)
 *  - BullMQ limiter: max 5 concurrent jobs
 *  - On 429: job throws → BullMQ retries with exponential backoff
 */

require('dotenv').config();

const { Worker, RateLimiterError } = require('bullmq');
const axios = require('axios');
const { workerRedis } = require('../config/redis');
const { QUEUE_NAMES } = require('../queues/queues');
const { sendTemplateMessage, getPhoneNumberQuality } = require('../services/metaApiService');
const logger = require('../config/logger');

// ─── Configuration ────────────────────────────────────────────────────────────
const INTER_MESSAGE_DELAY_MS = 12;  // ~83 msg/sec, safely under 80/sec limit
const WP_SITE_URL = process.env.WP_SITE_URL;
const WP_JWT_SECRET = process.env.WP_JWT_SECRET;

// ─── Helper: delay execution ──────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Helper: POST results to WordPress ───────────────────────────────────────
/**
 * Reports batch delivery results back to the WordPress DB.
 * WP plugin exposes a REST endpoint: POST /wp-json/wa-broadcast/v1/logs/batch
 *
 * @param {number} campaignId
 * @param {Array} results - Array of { phone, wamid, status, errorCode }
 */
async function reportResultsToWordPress(campaignId, results) {
  if (!WP_SITE_URL) {
    logger.warn('[Worker] WP_SITE_URL not set — skipping result reporting');
    return;
  }

  try {
    await axios.post(
      `${WP_SITE_URL}/wp-json/wa-broadcast/v1/logs/batch`,
      { campaignId, results },
      {
        headers: {
          'Authorization': `Bearer ${generateInternalJWT(WP_JWT_SECRET)}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    logger.debug('[Worker] Results reported to WP', { campaignId, count: results.length });
  } catch (err) {
    // Non-fatal — log but don't fail the job; message was already sent to recipient
    logger.error('[Worker] Failed to report results to WP', {
      campaignId,
      error: err.message,
      status: err.response?.status,
    });
  }
}

/**
 * Generates a minimal JWT for internal service-to-service calls.
 * In production, replace with a proper JWT library.
 */
function generateInternalJWT(secret) {
  const crypto = require('crypto');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'wa-broadcast-worker',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300, // 5 min expiry
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// ─── Main job processor ───────────────────────────────────────────────────────
/**
 * processJob — processes one broadcast batch job.
 *
 * @param {Job} job - BullMQ job object
 * @param {object} job.data.campaignId - WP campaign ID
 * @param {object} job.data.templateName - Meta template name
 * @param {object} job.data.languageCode - Template language
 * @param {Array}  job.data.contacts - Array of { phone, variables }
 * @param {number} job.data.batchIndex - Batch sequence number
 * @param {number} job.data.totalBatches - Total batches in campaign
 */
async function processJob(job) {
  const { campaignId, templateName, languageCode, contacts, batchIndex, totalBatches } = job.data;

  logger.info('[Worker] Processing batch', {
    jobId: job.id,
    campaignId,
    batchIndex,
    totalBatches,
    contacts: contacts.length,
  });

  // --- Quality gate: pause if phone number quality is RED ---
  try {
    const quality = await getPhoneNumberQuality();
    if (quality.qualityRating === 'RED') {
      logger.error('[Worker] Phone quality is RED — pausing campaign', { campaignId });
      // Throw to trigger retry — quality usually recovers within hours
      throw new Error('PHONE_QUALITY_RED: Broadcasting paused due to low quality rating');
    }
  } catch (qualityErr) {
    if (qualityErr.message.startsWith('PHONE_QUALITY_RED')) throw qualityErr;
    // If quality check itself fails (network issue), log and continue
    logger.warn('[Worker] Could not check phone quality — proceeding', { error: qualityErr.message });
  }

  // --- Send messages with inter-message delay ---
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];

    // Build template components from contact variables
    // Meta components format: [{ type: 'body', parameters: [{ type: 'text', text: 'value' }] }]
    const components = buildTemplateComponents(contact.variables);

    try {
      const { wamid } = await sendTemplateMessage({
        to: contact.phone,
        templateName,
        languageCode,
        components,
      });

      results.push({ phone: contact.phone, wamid, status: 'sent' });
      successCount++;

    } catch (err) {
      failureCount++;

      if (err.isPermanentFailure) {
        // Permanent errors (invalid number, opt-out) — log and skip, don't retry entire job
        results.push({
          phone: contact.phone,
          status: 'failed',
          errorCode: String(err.metaCode),
          errorMessage: err.message,
        });
        logger.warn('[Worker] Permanent failure for contact', {
          phone: contact.phone,
          metaCode: err.metaCode,
        });
      } else if (err.isRateLimit) {
        // 429: abort entire batch — BullMQ will retry with backoff
        logger.warn('[Worker] Rate limit hit — throwing for BullMQ retry', {
          campaignId,
          batchIndex,
          contactIndex: i,
        });
        throw err; // Triggers exponential backoff retry
      } else {
        // Transient error — record and continue to next contact
        results.push({
          phone: contact.phone,
          status: 'failed',
          errorCode: String(err.httpStatus || 'UNKNOWN'),
          errorMessage: err.message,
        });
        logger.warn('[Worker] Transient failure for contact', {
          phone: contact.phone,
          error: err.message,
        });
      }
    }

    // Update BullMQ job progress (visible in monitoring dashboards)
    await job.updateProgress(Math.round(((i + 1) / contacts.length) * 100));

    // Inter-message delay — throttle to stay under Meta rate limit
    if (i < contacts.length - 1) {
      await sleep(INTER_MESSAGE_DELAY_MS);
    }
  }

  // --- Report results back to WordPress ---
  await reportResultsToWordPress(campaignId, results);

  const summary = {
    campaignId,
    batchIndex,
    totalBatches,
    successCount,
    failureCount,
    total: contacts.length,
  };

  logger.info('[Worker] Batch completed', summary);
  return summary;
}

/**
 * Converts a contact's variables object into Meta template components format.
 *
 * Input:  { "1": "לירון", "2": "₪299", "3": "30 ביוני" }
 * Output: [{ type: 'body', parameters: [
 *            { type: 'text', text: 'לירון' },
 *            { type: 'text', text: '₪299' },
 *            { type: 'text', text: '30 ביוני' }
 *          ]}]
 *
 * @param {object} variables - Key-value map of template variable positions
 * @returns {Array} Meta components array
 */
function buildTemplateComponents(variables) {
  if (!variables || Object.keys(variables).length === 0) return [];

  const parameters = Object.keys(variables)
    .sort((a, b) => parseInt(a) - parseInt(b)) // Ensure correct order: 1, 2, 3...
    .map(key => ({ type: 'text', text: String(variables[key]) }));

  return [{ type: 'body', parameters }];
}

// ─── Worker instantiation ─────────────────────────────────────────────────────
const worker = new Worker(
  QUEUE_NAMES.BROADCAST,
  processJob,
  {
    connection: workerRedis,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),

    // BullMQ rate limiter: process max 80 jobs per second across ALL workers
    // Each job sends 50 messages, so this is a second-level throttle
    limiter: {
      max: 80,
      duration: 1000, // ms
    },
  }
);

// ─── Worker event listeners ───────────────────────────────────────────────────
worker.on('completed', (job, result) => {
  logger.info('[Worker] Job completed', {
    jobId: job.id,
    campaignId: result.campaignId,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
});

worker.on('failed', (job, err) => {
  logger.error('[Worker] Job failed', {
    jobId: job?.id,
    campaignId: job?.data?.campaignId,
    attempt: job?.attemptsMade,
    maxAttempts: job?.opts?.attempts,
    error: err.message,
  });
});

worker.on('stalled', (jobId) => {
  logger.warn('[Worker] Job stalled (worker may have crashed)', { jobId });
});

worker.on('error', (err) => {
  logger.error('[Worker] Worker-level error', { error: err.message });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`[Worker] ${signal} received — shutting down gracefully...`);
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

logger.info('[Worker] Broadcast worker started', {
  queue: QUEUE_NAMES.BROADCAST,
  concurrency: worker.opts.concurrency,
});
