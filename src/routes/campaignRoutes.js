'use strict';

/**
 * campaignRoutes.js — Campaign & Broadcast Management API
 *
 * These routes are called by the WordPress Hebrew dashboard.
 * All routes require a valid JWT (issued by WordPress).
 *
 * Route summary:
 *  POST   /api/campaigns            → Create and enqueue a new broadcast campaign
 *  GET    /api/campaigns/:id/stats  → Poll live campaign delivery statistics
 *  DELETE /api/campaigns/:id        → Cancel a pending/active campaign
 *  GET    /api/templates/sync       → Sync approved templates from Meta to caller
 *  GET    /api/health/queue         → Queue depth & worker status (internal monitoring)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { broadcastQueue } = require('../queues/queues');
const { getApprovedTemplates, getPhoneNumberQuality } = require('../services/metaApiService');
const logger = require('../config/logger');

const router = express.Router();

// Apply auth middleware to all routes in this file
router.use(requireAuth);

// ─── POST /api/campaigns ─────────────────────────────────────────────────────
/**
 * Creates a broadcast campaign and splits contacts into batches,
 * each added as a separate BullMQ job.
 *
 * Expected request body (from WP dashboard):
 * {
 *   campaignId: number,          // WP DB campaign ID
 *   templateName: string,        // Meta-approved template name
 *   languageCode: string,        // e.g. "he"
 *   contacts: Array<{
 *     phone: string,             // E.164 format
 *     variables: object          // { "1": "שם לקוח", "2": "סכום" }
 *   }>,
 *   scheduledAt: string|null,    // ISO 8601 datetime or null for immediate
 * }
 */
router.post('/campaigns', async (req, res) => {
  const { campaignId, templateName, languageCode, contacts, scheduledAt } = req.body;

  // --- Validation ---
  if (!campaignId || !templateName || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: campaignId, templateName, contacts[]',
    });
  }

  // Phone format validation (basic E.164 check)
  const invalidPhones = contacts.filter(c => !/^\d{10,15}$/.test(c.phone));
  if (invalidPhones.length > 0) {
    return res.status(400).json({
      success: false,
      error: `${invalidPhones.length} contacts have invalid phone format (expected E.164 without +)`,
      sample: invalidPhones.slice(0, 3).map(c => c.phone),
    });
  }

  // --- Split into batches of 50 ---
  const BATCH_SIZE = 50;
  const batches = [];
  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    batches.push(contacts.slice(i, i + BATCH_SIZE));
  }

  // --- Calculate delay for scheduled sends ---
  let delay = 0;
  if (scheduledAt) {
    const scheduledTime = new Date(scheduledAt).getTime();
    delay = Math.max(0, scheduledTime - Date.now());
  }

  // --- Enqueue all batches ---
  try {
    const jobs = await Promise.all(
      batches.map((batch, index) =>
        broadcastQueue.add(
          `campaign-${campaignId}-batch-${index}`,
          {
            campaignId,
            templateName,
            languageCode: languageCode || 'he',
            contacts: batch,
            batchIndex: index,
            totalBatches: batches.length,
          },
          {
            delay,
            jobId: `campaign-${campaignId}-batch-${index}-${uuidv4()}`,
          }
        )
      )
    );

    logger.info('[Campaigns] Campaign enqueued', {
      campaignId,
      totalContacts: contacts.length,
      totalBatches: batches.length,
      scheduledAt: scheduledAt || 'immediate',
      jobIds: jobs.map(j => j.id),
    });

    return res.status(202).json({
      success: true,
      campaignId,
      totalContacts: contacts.length,
      totalBatches: batches.length,
      estimatedStartAt: scheduledAt || new Date().toISOString(),
      message: 'Campaign accepted and queued for delivery',
    });

  } catch (err) {
    logger.error('[Campaigns] Failed to enqueue campaign', {
      campaignId,
      error: err.message,
    });
    return res.status(500).json({ success: false, error: 'Queue unavailable. Please retry.' });
  }
});

// ─── GET /api/campaigns/:id/stats ────────────────────────────────────────────
/**
 * Returns real-time delivery stats for a campaign by polling BullMQ job states.
 * The WP dashboard polls this every 5 seconds during active sends.
 *
 * Response shape matches the wa_message_logs table aggregate WP stores.
 */
router.get('/campaigns/:id/stats', async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);

  if (isNaN(campaignId)) {
    return res.status(400).json({ success: false, error: 'Invalid campaign ID' });
  }

  try {
    // Get all jobs for this campaign from the queue
    const [waiting, active, completed, failed] = await Promise.all([
      broadcastQueue.getJobCountByTypes('waiting', 'delayed'),
      broadcastQueue.getJobCountByTypes('active'),
      broadcastQueue.getJobCountByTypes('completed'),
      broadcastQueue.getJobCountByTypes('failed'),
    ]);

    // In production, augment this with a DB query to wa_message_logs for
    // per-message sent/delivered/read counts
    return res.json({
      success: true,
      campaignId,
      queue: { waiting, active, completed, failed },
      // These would come from WP DB in production:
      // delivery: { sent, delivered, read, failed }
    });

  } catch (err) {
    logger.error('[Campaigns] Failed to fetch stats', { campaignId, error: err.message });
    return res.status(500).json({ success: false, error: 'Stats unavailable' });
  }
});

// ─── DELETE /api/campaigns/:id ───────────────────────────────────────────────
/**
 * Cancels all pending (waiting/delayed) jobs for a campaign.
 * Active jobs (currently sending) cannot be stopped mid-batch.
 */
router.delete('/campaigns/:id', async (req, res) => {
  const campaignId = parseInt(req.params.id, 10);

  if (isNaN(campaignId)) {
    return res.status(400).json({ success: false, error: 'Invalid campaign ID' });
  }

  try {
    // Get all waiting jobs and remove those matching this campaign
    const waitingJobs = await broadcastQueue.getJobs(['waiting', 'delayed']);
    const campaignJobs = waitingJobs.filter(j =>
      j.data?.campaignId === campaignId
    );

    await Promise.all(campaignJobs.map(j => j.remove()));

    logger.info('[Campaigns] Campaign cancelled', {
      campaignId,
      jobsRemoved: campaignJobs.length,
    });

    return res.json({
      success: true,
      campaignId,
      jobsRemoved: campaignJobs.length,
      message: `Cancelled ${campaignJobs.length} pending batches`,
    });

  } catch (err) {
    logger.error('[Campaigns] Failed to cancel campaign', { campaignId, error: err.message });
    return res.status(500).json({ success: false, error: 'Cancellation failed' });
  }
});

// ─── GET /api/templates/sync ─────────────────────────────────────────────────
/**
 * Fetches all APPROVED templates from Meta and returns them to the WP dashboard.
 * WP then stores them in wa_templates for template selector UI.
 */
router.get('/templates/sync', async (req, res) => {
  try {
    const templates = await getApprovedTemplates();
    logger.info('[Templates] Sync requested', { count: templates.length });
    return res.json({ success: true, templates, syncedAt: new Date().toISOString() });
  } catch (err) {
    logger.error('[Templates] Sync failed', { error: err.message });
    return res.status(502).json({ success: false, error: 'Failed to fetch templates from Meta API' });
  }
});

// ─── GET /api/health/queue ───────────────────────────────────────────────────
/**
 * Internal monitoring endpoint — returns queue depth and phone quality.
 * Used by Render health checks and internal dashboards.
 */
router.get('/health/queue', async (req, res) => {
  try {
    const [counts, quality] = await Promise.all([
      broadcastQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      getPhoneNumberQuality().catch(() => ({ qualityRating: 'UNKNOWN' })),
    ]);

    const isHealthy = quality.qualityRating !== 'RED';

    return res.status(isHealthy ? 200 : 503).json({
      success: isHealthy,
      queue: counts,
      phoneQuality: quality,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({ success: false, error: err.message });
  }
});

module.exports = router;
