'use strict';

/**
 * queues.js — BullMQ Queue definitions
 */

const { Queue } = require('bullmq');
const { queueRedis } = require('../config/redis');
const logger = require('../config/logger');

// Queue name constants - No colons allowed
const QUEUE_NAMES = {
  BROADCAST:  'wa-broadcast',
  WEBHOOK:    'wa-webhook-inbound',
  OPTOUT:     'wa-optout',
};

// Default job options applied to all queues
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
  removeOnComplete: {
    age: 60 * 60 * 24,
    count: 1000,
  },
  removeOnFail: {
    age: 60 * 60 * 24 * 7,
  },
};

// Queue instantiation
const broadcastQueue = new Queue(QUEUE_NAMES.BROADCAST, {
  connection: queueRedis,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

const webhookQueue = new Queue(QUEUE_NAMES.WEBHOOK, {
  connection: queueRedis,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 3,
    backoff: { type: 'fixed', delay: 2000 },
  },
});

const optoutQueue = new Queue(QUEUE_NAMES.OPTOUT, {
  connection: queueRedis,
  defaultJobOptions: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 500 },
    priority: 1,
  },
});

// Event listeners for operational visibility
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