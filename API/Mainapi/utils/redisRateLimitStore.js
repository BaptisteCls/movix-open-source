const { redis } = require('../config/redis');

function buildResetTime(ttlMs, windowMs) {
  const safeTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : windowMs;
  return new Date(Date.now() + safeTtlMs);
}

class RedisRateLimitStore {
  constructor(options = {}) {
    this.windowMs = Number(options.windowMs) || 60_000;
    this.prefix = String(options.prefix || 'rate-limit:');
    this.localKeys = false;
  }

  init(options) {
    if (options?.windowMs) {
      this.windowMs = Number(options.windowMs);
    }
  }

  getKey(key) {
    return `${this.prefix}${key}`;
  }

  async get(key) {
    const redisKey = this.getKey(key);

    try {
      const [rawHits, rawTtlMs] = await redis
        .multi()
        .get(redisKey)
        .pttl(redisKey)
        .exec();

      const totalHits = Number(rawHits?.[1] || 0);
      const ttlMs = Number(rawTtlMs?.[1] || 0);

      if (!Number.isFinite(totalHits) || totalHits <= 0) {
        return undefined;
      }

      return {
        totalHits,
        resetTime: buildResetTime(ttlMs, this.windowMs)
      };
    } catch {
      return undefined;
    }
  }

  async increment(key) {
    const redisKey = this.getKey(key);

    try {
      const [rawHits, rawTtlMs] = await redis
        .multi()
        .incr(redisKey)
        .pttl(redisKey)
        .exec();

      const totalHits = Number(rawHits?.[1] || 1);
      let ttlMs = Number(rawTtlMs?.[1] || 0);

      if (!Number.isFinite(ttlMs) || ttlMs <= 0 || totalHits === 1) {
        ttlMs = this.windowMs;
        await redis.pexpire(redisKey, this.windowMs);
      }

      return {
        totalHits,
        resetTime: buildResetTime(ttlMs, this.windowMs)
      };
    } catch {
      return {
        totalHits: 1,
        resetTime: buildResetTime(this.windowMs, this.windowMs)
      };
    }
  }

  async decrement(key) {
    const redisKey = this.getKey(key);

    try {
      const remaining = Number(await redis.decr(redisKey));
      if (Number.isFinite(remaining) && remaining <= 0) {
        await redis.del(redisKey);
      }
    } catch {
      // ignore
    }
  }

  async resetKey(key) {
    try {
      await redis.del(this.getKey(key));
    } catch {
      // ignore
    }
  }
}

function createRedisRateLimitStore(options) {
  return new RedisRateLimitStore(options);
}

module.exports = {
  RedisRateLimitStore,
  createRedisRateLimitStore
};
