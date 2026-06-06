'use strict';

/**
 * redis.js — Central Redis connection configuration
 *
 * We maintain TWO separate connection objects:
 *  1. `redisConnection`  → used by BullMQ Queue & Worker (requires ioredis instance)
 *  2. `redisClient`      → used for direct key/value ops (rate counters, idempotency keys)
 *
 * Render's Key Value service exposes a standard Redis URL.
 * ioredis parses it automatically when passed as a string.
 *
 * IMPORTANT: BullMQ requires a dedicated ioredis connection per Queue/Worker.
 * Never share a single ioredis instance across Queue and Worker — it causes
 * blocking command conflicts (BRPOP vs normal commands).
 */

const { Redis } = require('ioredis');

if (!process.env.REDIS_URL) {
  throw new Error('[Config] REDIS_URL environment variable is not set.');
}

/**
 * Creates a fresh ioredis connection with shared resilience settings.
 * Called separately for Queue, Worker, and direct client to avoid conflicts.
 *
 * @param {string} label - Identifier for log output (e.g. 'BullMQ-Queue')
 * @returns {Redis} Configured ioredis instance
 */
function createRedisConnection(label = 'Redis') {
  const client = new Redis(process.env.REDIS_URL, {
    // Render's Redis uses TLS in production — enable when REDIS_URL starts with rediss://
    tls: process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,

    maxRetriesPerRequest: null,   // Required by BullMQ — disables the retry limit
    enableReadyCheck: false,       // BullMQ recommendation for stability
    lazyConnect: false,            // Connect immediately on creation

    retryStrategy(times) {
      // Exponential backoff: 50ms, 100ms, 200ms... capped at 10 seconds
      const delay = Math.min(50 * Math.pow(2, times), 10000);
      console.warn(`[${label}] Reconnecting to Redis (attempt ${times}) in ${delay}ms...`);
      return delay;
    },
  });

  client.on('connect', () => console.log(`[${label}] Connected to Redis.`));
  client.on('ready',   () => console.log(`[${label}] Redis ready.`));
  client.on('error',   (err) => console.error(`[${label}] Redis error:`, err.message));
  client.on('close',   () => console.warn(`[${label}] Redis connection closed.`));

  return client;
}

// --- Exported connections ---

/** Used by BullMQ Queue instances */
const queueRedis = createRedisConnection('BullMQ-Queue');

/** Used by BullMQ Worker instances */
const workerRedis = createRedisConnection('BullMQ-Worker');

/** Used for direct Redis commands (idempotency, rate-limit counters) */
const redisClient = createRedisConnection('Redis-Client');

module.exports = { queueRedis, workerRedis, redisClient };
