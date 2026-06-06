'use strict';

/**
 * queues.js — BullMQ Queue definitions
 *
 * We define NAMED queues here and export them for use by:
 *  - Routes (to add jobs)
 *  - Workers (to process jobs)
 *  - Dashboard / monitoring (to inspect queue state)
 *
 * Queue names are constants to prevent typo-driven bugs.
 *
 * Architecture notes:
 *  - BROADCAST_QUEUE    : One job per campaign batch (50 contacts/job)
 *  - WEBHOOK_QUEUE      : Inbound Meta status callbacks (sent/delivered/read/failed)
 *  - OPTOUT_QUEUE       : Isolated queue for processing opt-out requests safely
 *
 * Each queue uses `queueRedis` (a dedicated ioredis connection, never shared with workers).
 */

const { Queue } = require('bullmq');
const { queueRedis } = require('./redis');
const logger = require('./logger');

// ─── Queue name constants (single source of truth) ───────────────────────────
const QUEUE_NAMES = {
  BROADCAST:  'wa:broadcast',
  WEBHOOK:    'wa:webhook-inbound',
  OPTOUT:     'wa:optout',
};

// ─── Default job options applied to all queues ───────────────────────────────
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,           // Retry up to 5 times before sending to Dead Letter
  backoff: {
    type: 'exponential', // Delays: 1s, 2s, 4s, 8s, 16s
    delay: 1000,
  },
  removeOnComplete: {
    age: 60 * 60 * 24,  // Keep completed jobs for 24h (for analytics polling)
    count: 1000,         // Keep last 1,000 completed jobs max
  },
  removeOnFail: {
    age: 60 * 60 * 24 * 7, // Keep failed jobs for 7 days (for investigation)
  },
};

// ─── Queue instantiation ──────────────────────────────────────────────────────

/**
 * broadcastQueue — Main outbound message queue.
 * Jobs added here contain a batch of up to 50 contacts + campaign metadata.
 *
 * Job data shape:
 * {
 *   campaignId: number,
 *   templateName: string,
 *   languageCode: string,
 *   contacts: Array<{ phone: string, variables: object }>,
 *   variableMap: object,
 * }
 */
const broadcastQueue = new Queue(QUEUE_NAMES.BROADCAST, {
  connection: queueRedis,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

/**
 * webhookQueue — Processes inbound webhook payloads from Meta.
 * The webhook route drops raw payloads here immediately and returns 200 OK.
 * The worker processes them asynchronously, updating message_logs in WP DB.
 *
 * Job data shape: raw Meta webhook payload (statuses array or messages array)
 */
const webhookQueue = new Queue(QUEUE_NAMES.WEBHOOK, {
  connection: queueRedis,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 3,
    backoff: { type: 'fixed', delay: 2000 },
  },
});

/**
 * optoutQueue — Processes opt-out requests in isolation.
 * Keeps sensitive user removals separate from bulk broadcast operations.
 *
 * Job data shape: { phone: string, wamid: string, timestamp: number }
 */
const optoutQueue = new Queue(QUEUE_NAMES.OPTOUT, {
  connection: queueRedis,
  defaultJobOptions: {
    attempts: 10,       // Opt-outs MUST succeed — high retry count
    backoff: { type: 'exponential', delay: 500 },
    priority: 1,        // BullMQ priority: 1 = highest
  },
});

// ─── Event listeners for operational visibility ───────────────────────────────
[broadcastQueue, webhookQueue, optoutQueue].forEach((q) => {
  q.on('error', (err) => logger.error(`[Queue:${q.name}] Queue error`, { error: err.message }));
});

logger.info('[Queues] BullMQ queues initialized', {
  queues: Object.values(QUEUE_NAMES),
});

module.exports = {
  broadcastQueue,
  webhookQueue,
  optoutQueue,
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
};
