'use strict';

/**
 * redis.js — Central Redis connection configuration
 */

const { Redis } = require('ioredis');

// תיקון: במקום לקרוס, נשתמש בערך ברירת מחדל אם המשתנה חסר
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

if (!redisUrl) {
  throw new Error('[Config] REDIS_URL environment variable is not set.');
}

/**
 * Creates a fresh ioredis connection
 */
function createRedisConnection(label = 'Redis') {
  const client = new Redis(redisUrl, {
    // Render's Redis uses TLS in production
    tls: redisUrl.startsWith('rediss://') ? {} : undefined,

    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: false,

    retryStrategy(times) {
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
const queueRedis = createRedisConnection('BullMQ-Queue');
const workerRedis = createRedisConnection('BullMQ-Worker');
const redisClient = createRedisConnection('Redis-Client');

module.exports = { queueRedis, workerRedis, redisClient };