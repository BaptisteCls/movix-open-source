/**
 * Redis connection and memory cache wrapper.
 * Extracted from server.js — centralizes Redis configuration.
 */

const Redis = require('ioredis');

// === REDIS CACHE POUR OPTIMISER LES PERFORMANCES ===
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT),
  password: process.env.REDIS_PASSWORD,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true
});

redis.on('connect', () => console.log('[Redis] Connecté'));
redis.on('error', (err) => console.error('[Redis] Erreur:', err.message));

// Wrapper autour de Redis pour garder l'interface memoryCache (get/set avec JSON auto)
const memoryCache = {
  async get(key) {
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : undefined;
    } catch { return undefined; }
  },
  async set(key, value, ttl = 300) {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttl);
    } catch { /* ignore */ }
  }
};

module.exports = { redis, memoryCache };
