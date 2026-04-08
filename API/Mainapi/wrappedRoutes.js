/**
 * Movix Wrapped 2026 - Data Collection Routes
 * Collects viewing data and page visits for the annual Wrapped summary
 *
 * Performance notes:
 *  - Redis is used for generated-wrapped cache AND TMDB detail cache
 *  - All independent SQL queries run in Promise.all (parallel)
 *  - TMDB enrichment uses Redis-backed batch lookup
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { fetchTmdbDetails } = require('./utils/tmdbCache');

// Lazy import pour éviter les dépendances circulaires au démarrage
let _syncModule = null;
function getSyncModule() {
    if (!_syncModule) _syncModule = require('./routes/sync');
    return _syncModule;
}

// TMDB API Configuration
const TMDB_API_URL = 'https://api.themoviedb.org/3';

// Redis key prefixes & TTLs
const WRAPPED_CACHE_PREFIX = 'wrapped:gen:';        // generated wrapped result
const PERCENTILE_CACHE_PREFIX = 'wrapped:pctile:';  // percentile ranking (global, heavy query)
const WRAPPED_CACHE_TTL    = 10 * 60;               // 10 min (seconds)
const PERCENTILE_CACHE_TTL = 30 * 60;               // 30 min (seconds) - global data, doesn't change fast

// Same secret as server.js
const JWT_SECRET = process.env.JWT_SECRET;

// Set by server.js via initWrappedRoutes()
let pool  = null;
let redis = null;

/**
 * Initialize the router with MySQL pool and Redis client
 * @param {object} mysqlPool - MySQL connection pool
 * @param {object} redisClient - ioredis instance (optional but recommended)
 */
function initWrappedRoutes(mysqlPool, redisClient) {
    pool  = mysqlPool;
    redis = redisClient || null;
}

// ─── Helpers: Redis-safe get / set ───────────────────────────────────────────
function redisReady() {
    return redis && redis.status === 'ready';
}

async function redisGet(key) {
    if (!redisReady()) return null;
    try { return await redis.get(key); } catch { return null; }
}

async function redisSet(key, value, ttlSeconds) {
    if (!redisReady()) return;
    try { await redis.set(key, value, 'EX', ttlSeconds); } catch { /* ignore */ }
}

// ─── Rate limiting par profil (Redis-backed) ────────────────────────────────
const RATE_LIMIT_PREFIX = 'wrapped:rl:';

/**
 * Crée un middleware de rate limiting par profileId (fallback userId).
 * @param {string} endpoint - Nom de l'endpoint (pour la clé Redis)
 * @param {number} maxRequests - Nombre max de requêtes dans la fenêtre
 * @param {number} windowSeconds - Durée de la fenêtre en secondes
 * @param {function} extractId - Fonction (req) => identifiant pour le rate limit
 */
function rateLimitPerProfile(endpoint, maxRequests, windowSeconds, extractId) {
    return async (req, res, next) => {
        if (!redisReady()) return next(); // pas de Redis = pas de rate limit

        const id = extractId(req);
        if (!id) return next(); // pas d'identifiant = skip

        const key = `${RATE_LIMIT_PREFIX}${endpoint}:${id}`;
        try {
            const current = await redis.incr(key);
            if (current === 1) {
                await redis.expire(key, windowSeconds);
            }
            // Headers informatifs
            res.set('X-RateLimit-Limit', String(maxRequests));
            res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - current)));

            if (current > maxRequests) {
                const ttl = await redis.ttl(key);
                res.set('Retry-After', String(ttl > 0 ? ttl : windowSeconds));
                return res.status(429).json({
                    success: false,
                    error: 'Trop de requêtes. Réessaie dans quelques instants.'
                });
            }
            next();
        } catch {
            next(); // en cas d'erreur Redis, on laisse passer
        }
    };
}

// /track : le frontend envoie ~2 req/30s en usage normal, avec les changements
// de visibilité/contenu/épisode ça peut monter. 30 req/min est très confortable.
const trackRateLimit = rateLimitPerProfile('track', 30, 60, (req) => {
    return req.body?.profileId || req.user?.sub;
});

// /generate : requête lourde (SQL + TMDB). 6 req/min suffit largement
// (un refresh + quelques changements d'année).
const generateRateLimit = rateLimitPerProfile('generate', 6, 60, (req) => {
    return req.headers['x-profile-id'] || req.query.profileId || req.user?.sub;
});

const WRAPPED_UNLOCK_REQUIREMENTS = Object.freeze({
    minutes: 120,
    uniqueTitles: 3,
    sessions: 5,
    activeDays: 2
});

function buildWrappedProgress({ totalMinutes, uniqueTitles, totalSessions, totalActiveDays }) {
    const current = {
        minutes: Math.max(0, totalMinutes || 0),
        uniqueTitles: Math.max(0, uniqueTitles || 0),
        sessions: Math.max(0, totalSessions || 0),
        activeDays: Math.max(0, totalActiveDays || 0)
    };

    const missing = {
        minutes: Math.max(0, WRAPPED_UNLOCK_REQUIREMENTS.minutes - current.minutes),
        uniqueTitles: Math.max(0, WRAPPED_UNLOCK_REQUIREMENTS.uniqueTitles - current.uniqueTitles),
        sessions: Math.max(0, WRAPPED_UNLOCK_REQUIREMENTS.sessions - current.sessions),
        activeDays: Math.max(0, WRAPPED_UNLOCK_REQUIREMENTS.activeDays - current.activeDays)
    };

    const progressRatios = [
        Math.min(current.minutes / WRAPPED_UNLOCK_REQUIREMENTS.minutes, 1),
        Math.min(current.uniqueTitles / WRAPPED_UNLOCK_REQUIREMENTS.uniqueTitles, 1),
        Math.min(current.sessions / WRAPPED_UNLOCK_REQUIREMENTS.sessions, 1),
        Math.min(current.activeDays / WRAPPED_UNLOCK_REQUIREMENTS.activeDays, 1)
    ];

    return {
        isEligible: Object.values(missing).every((value) => value === 0),
        completionPercent: Math.round((progressRatios.reduce((sum, value) => sum + value, 0) / progressRatios.length) * 100),
        missingCriteriaCount: Object.values(missing).filter((value) => value > 0).length,
        requirements: { ...WRAPPED_UNLOCK_REQUIREMENTS },
        current,
        missing
    };
}

// ─── TMDB helpers (via tmdbCache centralisé) ────────────────────────────────

/**
 * Extrait les champs nécessaires à Wrapped depuis une réponse TMDB complète.
 */
function extractWrappedFields(data) {
    if (!data) return null;
    return {
        title: data.title || data.name,
        poster_path: data.poster_path,
        genres: (data.genres || []).map(g => typeof g === 'string' ? g : g.name),
        vote_average: data.vote_average || null,
        runtime: data.runtime || data.episode_run_time?.[0] || null
    };
}

/**
 * Fetch details from TMDB (via tmdbCache Redis centralisé)
 */
async function fetchTMDBDetails(contentId, contentType) {
    // Skip live-tv as it's not from TMDB
    if (contentType === 'live-tv') {
        return { title: `Live TV #${contentId}`, poster_path: null, genres: [] };
    }

    const mediaType = contentType === 'anime' ? 'tv' : contentType;
    const data = await fetchTmdbDetails(TMDB_API_URL, process.env.TMDB_API_KEY, contentId, mediaType, 'fr-FR');
    return extractWrappedFields(data);
}

/**
 * Enrich content array with TMDB data (parallel, Redis-cached)
 */
async function enrichWithTMDBData(contents) {
    return Promise.all(contents.map(async (content) => {
        if (content.content_title && content.poster_path) {
            return content; // Already has data
        }
        const details = await fetchTMDBDetails(content.content_id, content.content_type);
        return {
            ...content,
            content_title: details?.title || content.content_title || `${content.content_type} #${content.content_id}`,
            poster_path: details?.poster_path || content.poster_path || null,
            genres: details?.genres || [],
            vote_average: details?.vote_average || null
        };
    }));
}

/**
 * Middleware to verify JWT token
 */
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        // If no token, check if we can proceed without it (e.g. for simple tracking?)
        // But user asked for verification "like other routes", so we enforce it.
        // However, wrapped tracker might not have header set if useWrappedTracker uses standard fetch without setting headers.
        // Let's check useWrappedTracker.ts... It uses fetch without custom headers?
        // Wait, I need to check useWrappedTracker.ts. 
        // If useWrappedTracker doesn't send Authorization header, this will break tracking.
        return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ success: false, error: 'Invalid token.' });
    }
};

/**
 * Create required tables if they don't exist
 */
async function initTables() {
    if (!pool) {
        console.error('[Wrapped] Cannot init tables - no database pool');
        return;
    }

    try {
        // Create wrapped_viewing_data table
        await pool.execute(`
      CREATE TABLE IF NOT EXISTS wrapped_viewing_data (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        profile_id VARCHAR(255),
        content_type ENUM('movie', 'tv', 'anime', 'live-tv') NOT NULL,
        content_id VARCHAR(255) NOT NULL,
        content_title VARCHAR(255),
        season_number INT DEFAULT NULL,
        episode_number INT DEFAULT NULL,
        watch_duration INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        hour_of_day TINYINT DEFAULT NULL,
        month INT NOT NULL,
        year INT NOT NULL,
        INDEX idx_user_year (user_id, year),
        INDEX idx_content (content_type, content_id),
        INDEX idx_hour (user_id, year, hour_of_day)
      )
    `);

        // Create wrapped_pages_data table
        await pool.execute(`
      CREATE TABLE IF NOT EXISTS wrapped_pages_data (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        profile_id VARCHAR(255),
        page_name VARCHAR(100) NOT NULL,
        duration INT DEFAULT 0,
        meta_data JSON,
        month INT NOT NULL,
        year INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_page_stats (user_id, page_name, year)
      )
    `);

        // Migration: add hour_of_day column if it doesn't exist (for tables created before this column was added)
        try {
            await pool.execute(`
                ALTER TABLE wrapped_viewing_data ADD COLUMN hour_of_day TINYINT DEFAULT NULL AFTER created_at
            `);
            console.log('[Wrapped] Migration: added hour_of_day column');
        } catch (alterErr) {
            // ER_DUP_FIELDNAME (1060) means column already exists — that's fine
            if (alterErr.errno !== 1060) {
                console.warn('[Wrapped] Migration warning (hour_of_day):', alterErr.message);
            }
        }

        // Migration: add idx_hour index if it doesn't exist
        try {
            await pool.execute(`
                CREATE INDEX idx_hour ON wrapped_viewing_data (user_id, year, hour_of_day)
            `);
            console.log('[Wrapped] Migration: added idx_hour index');
        } catch (indexErr) {
            // ER_DUP_KEYNAME (1061) means index already exists — that's fine
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_hour):', indexErr.message);
            }
        }

        // Migration: add composite index for the track upsert SELECT (covers all lookup columns)
        try {
            await pool.execute(`
                CREATE INDEX idx_viewing_lookup ON wrapped_viewing_data 
                (user_id, profile_id, content_type, content_id, month, year, hour_of_day)
            `);
            console.log('[Wrapped] Migration: added idx_viewing_lookup index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_viewing_lookup):', indexErr.message);
            }
        }

        // Migration: add composite index for page data upsert SELECT
        try {
            await pool.execute(`
                CREATE INDEX idx_page_lookup ON wrapped_pages_data 
                (user_id, profile_id, page_name, month, year)
            `);
            console.log('[Wrapped] Migration: added idx_page_lookup index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_page_lookup):', indexErr.message);
            }
        }

        // Migration: index on (year) alone for the global percentile query
        try {
            await pool.execute(`CREATE INDEX idx_year ON wrapped_viewing_data (year)`);
            console.log('[Wrapped] Migration: added idx_year index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_year):', indexErr.message);
            }
        }

        // Migration: covering index for generate queries (user_id, year, watch_duration, content_id, content_type)
        try {
            await pool.execute(`
                CREATE INDEX idx_generate_cover ON wrapped_viewing_data 
                (user_id, year, profile_id, content_type, content_id, watch_duration)
            `);
            console.log('[Wrapped] Migration: added idx_generate_cover index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_generate_cover):', indexErr.message);
            }
        }

        // Migration: index for first/last watch ORDER BY created_at
        try {
            await pool.execute(`
                CREATE INDEX idx_user_year_created ON wrapped_viewing_data (user_id, year, created_at)
            `);
            console.log('[Wrapped] Migration: added idx_user_year_created index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_user_year_created):', indexErr.message);
            }
        }

        // Migration: index for pages generate (user_id, year, page_name, duration)
        try {
            await pool.execute(`
                CREATE INDEX idx_page_generate ON wrapped_pages_data (user_id, year, profile_id, page_name, duration)
            `);
            console.log('[Wrapped] Migration: added idx_page_generate index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_page_generate):', indexErr.message);
            }
        }

        // Migration: covering index for the global percentile GROUP BY query
        // Allows MySQL to compute SUM(watch_duration) GROUP BY user_id entirely from the index
        try {
            await pool.execute(`
                CREATE INDEX idx_percentile_cover ON wrapped_viewing_data (year, user_id, watch_duration)
            `);
            console.log('[Wrapped] Migration: added idx_percentile_cover index');
        } catch (indexErr) {
            if (indexErr.errno !== 1061) {
                console.warn('[Wrapped] Migration warning (idx_percentile_cover):', indexErr.message);
            }
        }

        console.log('[Wrapped] Tables initialized successfully');
    } catch (error) {
        console.error('[Wrapped] Error initializing tables:', error);
    }
}

/**
 * POST /api/wrapped/track
 * Batch endpoint to receive viewing/page data
 */
router.post('/track', verifyToken, trackRateLimit, async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({ success: false, error: 'Database not available' });
        }

        const {
            userId,
            profileId,
            type,
            month,
            year,
            duration,
            // Viewing-specific fields
            contentType,
            contentId,
            contentTitle,
            seasonNumber,
            episodeNumber,
            hourOfDay,
            // Page-specific fields
            pageName,
            meta,
        } = req.body;

        // Security: userId du body doit correspondre au JWT
        if (!req.user || !req.user.sub) {
            return res.status(401).json({ success: false, error: 'Token invalide' });
        }
        if (userId !== req.user.sub) {
            console.warn(`[Wrapped] User ID mismatch blocked: Body ${userId} vs Token ${req.user.sub}`);
            return res.status(403).json({ success: false, error: 'User ID mismatch' });
        }

        // Security: vérifier que le profileId appartient bien à cet utilisateur
        if (profileId) {
            try {
                const userType = req.user.userType || 'oauth';
                const { readUserData } = getSyncModule();
                const userData = await readUserData(userType, req.user.sub);
                const profiles = userData?.profiles || [];
                if (!profiles.some(p => p.id === profileId)) {
                    console.warn(`[Wrapped] Profile ownership denied: ${profileId} not owned by ${req.user.sub}`);
                    return res.status(403).json({ success: false, error: 'Profile does not belong to this user' });
                }
            } catch (err) {
                console.error(`[Wrapped] Error checking profile ownership:`, err.message);
                return res.status(500).json({ success: false, error: 'Could not verify profile ownership' });
            }
        }

        // Validate required fields
        if (!userId || !type || !month || !year || duration === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, type, month, year, duration'
            });
        }

        // Validate numeric ranges to prevent data pollution
        const parsedMonth = parseInt(month);
        const parsedYear = parseInt(year);
        const parsedDuration = parseInt(duration);
        const currentYear = new Date().getFullYear();

        if (isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
            return res.status(400).json({ success: false, error: 'Invalid month (1-12)' });
        }
        if (isNaN(parsedYear) || parsedYear < 2024 || parsedYear > currentYear) {
            return res.status(400).json({ success: false, error: `Invalid year (2024-${currentYear})` });
        }
        if (isNaN(parsedDuration) || parsedDuration < 0 || parsedDuration > 60) {
            return res.status(400).json({ success: false, error: 'Invalid duration (0-60 seconds)' });
        }
        if (!['viewing', 'page'].includes(type)) {
            return res.status(400).json({ success: false, error: 'Invalid type. Must be "viewing" or "page"' });
        }

        if (type === 'viewing') {
            // Validate viewing-specific fields
            if (!contentType || !contentId) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required fields for viewing: contentType, contentId'
                });
            }

            // Resolve hour: prefer client-sent hourOfDay, fallback to server hour
            const resolvedHour = hourOfDay !== undefined && hourOfDay !== null ? parseInt(hourOfDay) : new Date().getHours();

            // Try to update existing record for the same content in the same month AND same hour
            // Splitting by hour ensures accurate listening clock data
            const [existingRows] = await pool.execute(
                `SELECT id, watch_duration FROM wrapped_viewing_data 
         WHERE user_id = ? AND profile_id <=> ? AND content_type = ? AND content_id = ? 
         AND month = ? AND year = ? AND hour_of_day <=> ?
         AND season_number <=> ? AND episode_number <=> ?
         LIMIT 1`,
                [userId, profileId || null, contentType, contentId, month, year,
                    resolvedHour, seasonNumber || null, episodeNumber || null]
            );

            if (existingRows.length > 0) {
                // Update existing record
                const newDuration = existingRows[0].watch_duration + Math.floor(duration);
                await pool.execute(
                    `UPDATE wrapped_viewing_data SET watch_duration = ? WHERE id = ?`,
                    [newDuration, existingRows[0].id]
                );
            } else {
                // Insert new record
                await pool.execute(
                    `INSERT INTO wrapped_viewing_data 
           (user_id, profile_id, content_type, content_id, content_title, season_number, episode_number, watch_duration, hour_of_day, month, year)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [userId, profileId || null, contentType, contentId, contentTitle || null,
                        seasonNumber || null, episodeNumber || null, Math.floor(duration), 
                        resolvedHour, month, year]
                );
            }
        } else if (type === 'page') {
            // Validate page-specific fields
            if (!pageName) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing required field for page: pageName'
                });
            }

            // Try to update existing record for the same page in the same month
            const [existingRows] = await pool.execute(
                `SELECT id, duration FROM wrapped_pages_data 
         WHERE user_id = ? AND profile_id <=> ? AND page_name = ? AND month = ? AND year = ?
         LIMIT 1`,
                [userId, profileId || null, pageName, month, year]
            );

            if (existingRows.length > 0) {
                // Update existing record
                const newDuration = existingRows[0].duration + Math.floor(duration);
                await pool.execute(
                    `UPDATE wrapped_pages_data SET duration = ? WHERE id = ?`,
                    [newDuration, existingRows[0].id]
                );
            } else {
                // Insert new record
                await pool.execute(
                    `INSERT INTO wrapped_pages_data 
           (user_id, profile_id, page_name, duration, meta_data, month, year)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [userId, profileId || null, pageName, Math.floor(duration),
                        meta ? JSON.stringify(meta) : null, month, year]
                );
            }
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid type. Must be "viewing" or "page"'
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Wrapped] Error tracking data:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * Generate Wrapped summary using templates (like Spotify - no AI)
 * Header 'x-profile-id': Optional profile ID to filter stats
 *
 * PERFORMANCE: All independent SQL queries run in Promise.all,
 *   TMDB results are cached in Redis (24 h), generated wrapped in Redis (10 min).
 */
router.get('/generate/:year', verifyToken, generateRateLimit, async (req, res) => {
    const _t = { start: Date.now() };
    const { year } = req.params;
    const userId = req.user.sub;
    const profileId = req.headers['x-profile-id'] || req.query.profileId;

    console.log(`[Wrapped][PERF] ── Generate ${year} for user=${userId} profile=${profileId || 'all'} ──`);

    // Validate year parameter
    const parsedYear = parseInt(year);
    if (isNaN(parsedYear) || parsedYear < 2024 || parsedYear > new Date().getFullYear()) {
        return res.status(400).json({ success: false, error: 'Invalid year' });
    }

    if (!pool) {
        return res.status(500).json({ success: false, error: 'Database not initialized' });
    }

    // ── 0. Redis cache check (skip if ?fresh=1) ────────────────────────────────
    const cacheKey = `${WRAPPED_CACHE_PREFIX}${userId}-${profileId || 'all'}-${year}`;
    if (!req.query.fresh) {
        const cached = await redisGet(cacheKey);
        if (cached) {
            try {
                console.log(`[Wrapped][PERF] ⚡ Redis cache HIT — total ${Date.now() - _t.start}ms`);
                return res.json(JSON.parse(cached));
            } catch { /* regenerate */ }
        }
        console.log(`[Wrapped][PERF] Redis cache MISS (${Date.now() - _t.start}ms)`);
    } else {
        console.log(`[Wrapped][PERF] Cache skipped (?fresh=1)`);
    }

    try {
        // Base query conditions
        let whereClause = 'WHERE user_id = ? AND year = ?';
        let queryParams = [userId, year];
        if (profileId) {
            whereClause += ' AND profile_id = ?';
            queryParams.push(profileId);
        }

        // ── Helper: timed query ────────────────────────────────────────────────
        const _sqlTimings = {};
        async function timedQuery(label, queryFn) {
            const t0 = Date.now();
            const result = await queryFn();
            _sqlTimings[label] = Date.now() - t0;
            return result;
        }

        // ── Helper: fetch percentile (Redis cache or SQL fallback) ──────────────
        async function fetchPercentile() {
            const pctCacheKey = `${PERCENTILE_CACHE_PREFIX}${year}`;
            const cachedPct = await redisGet(pctCacheKey);
            if (cachedPct) {
                try {
                    const rankings = JSON.parse(cachedPct);
                    const totalUsers = rankings.length;
                    const userRank = rankings.findIndex(u => u.user_id === userId) + 1;
                    const pct = totalUsers > 1 ? Math.round(((totalUsers - userRank) / totalUsers) * 100) : 99;
                    _sqlTimings['percentile'] = 0;
                    console.log(`[Wrapped][PERF] 📊 Percentile: Redis HIT — rank ${userRank}/${totalUsers} = top ${100 - pct}%`);
                    return pct;
                } catch { /* fallback to SQL */ }
            }
            // Expensive SQL — runs once per 30 min then cached for all users/workers
            const pctT0 = Date.now();
            const [allUsersStats] = await pool.execute(`
                SELECT user_id, ROUND(SUM(watch_duration) / 60) as total
                FROM wrapped_viewing_data WHERE year = ?
                GROUP BY user_id ORDER BY total DESC
            `, [year]);
            _sqlTimings['percentile'] = Date.now() - pctT0;
            console.log(`[Wrapped][PERF] 📊 Percentile: SQL in ${_sqlTimings['percentile']}ms (${allUsersStats.length} users)`);
            redisSet(pctCacheKey, JSON.stringify(allUsersStats), PERCENTILE_CACHE_TTL);
            const totalUsers = allUsersStats.length;
            const userRank = allUsersStats.findIndex(u => u.user_id === userId) + 1;
            return totalUsers > 1 ? Math.round(((totalUsers - userRank) / totalUsers) * 100) : 99;
        }

        // ── 1. Fire ALL queries in parallel (user-scoped + percentile) ──────────
        _t.sqlStart = Date.now();
        const [
            [viewingStats],
            [typeStats],
            [topContentAll],
            [monthlyStats],
            [topPages],
            [hourlyStats],
            [dailyActivity],
            [firstWatch],
            [lastWatch],
            percentile
        ] = await Promise.all([
            // 1. Viewing Stats
            timedQuery('viewingStats', () => pool.execute(`
                SELECT 
                    ROUND(SUM(watch_duration) / 60) as total_duration,
                    COUNT(DISTINCT content_id) as unique_titles,
                    COUNT(*) as total_sessions
                FROM wrapped_viewing_data ${whereClause}
            `, queryParams)),

            // 2. Distribution by Type
            timedQuery('typeStats', () => pool.execute(`
                SELECT content_type, ROUND(SUM(watch_duration) / 60) as duration, COUNT(DISTINCT content_id) as count
                FROM wrapped_viewing_data ${whereClause}
                GROUP BY content_type ORDER BY duration DESC
            `, queryParams)),

            // 3. Top Content (Top 10 — replaces old top5 + top10-genres queries)
            timedQuery('topContent', () => pool.execute(`
                SELECT
                    COALESCE(MAX(NULLIF(content_title, '')), MAX(content_title)) as content_title,
                    content_id,
                    content_type,
                    ROUND(SUM(watch_duration) / 60) as duration
                FROM wrapped_viewing_data ${whereClause}
                GROUP BY content_id, content_type
                ORDER BY duration DESC LIMIT 10
            `, queryParams)),

            // 4. Monthly breakdown
            timedQuery('monthlyStats', () => pool.execute(`
                SELECT month, ROUND(SUM(watch_duration) / 60) as duration
                FROM wrapped_viewing_data ${whereClause}
                GROUP BY month ORDER BY duration DESC
            `, queryParams)),

            // 5. Top Pages
            timedQuery('topPages', () => pool.execute(`
                SELECT page_name, ROUND(SUM(duration) / 60) as duration
                FROM wrapped_pages_data ${whereClause}
                GROUP BY page_name ORDER BY duration DESC LIMIT 5
            `, queryParams)),

            // 6. Time-of-day distribution
            timedQuery('hourlyStats', () => pool.execute(`
                SELECT hour_of_day, ROUND(SUM(watch_duration) / 60) as duration, COUNT(*) as sessions
                FROM wrapped_viewing_data ${whereClause}
                AND hour_of_day IS NOT NULL
                GROUP BY hour_of_day ORDER BY hour_of_day
            `, queryParams)),

            // 7. Watching streaks (consecutive days)
            timedQuery('dailyActivity', () => pool.execute(`
                SELECT DISTINCT DATE(created_at) as watch_date
                FROM wrapped_viewing_data ${whereClause}
                ORDER BY watch_date
            `, queryParams)),

            // 8a. First watch of the year
            timedQuery('firstWatch', () => pool.execute(`
                SELECT content_title, content_type, content_id, created_at
                FROM wrapped_viewing_data ${whereClause}
                ORDER BY created_at ASC LIMIT 1
            `, queryParams)),

            // 8b. Last watch of the year
            timedQuery('lastWatch', () => pool.execute(`
                SELECT content_title, content_type, content_id, created_at
                FROM wrapped_viewing_data ${whereClause}
                ORDER BY created_at DESC LIMIT 1
            `, queryParams)),

            // 10. Percentile (Redis-cached 30min, SQL fallback)
            fetchPercentile()
        ]);

        // Derive top5 and top10-for-genres from the single top10 result
        const topContent = topContentAll.slice(0, 5);
        const topContentForGenres = topContentAll; // all 10

        _t.sqlEnd = Date.now();
        const timingsStr = Object.entries(_sqlTimings).map(([k, v]) => `${k}=${v}ms`).join(' | ');
        console.log(`[Wrapped][PERF] 🗄️  SQL+Percentile (10 parallel): ${_t.sqlEnd - _t.sqlStart}ms — ${timingsStr}`);

        const totalMinutes = parseInt(viewingStats[0].total_duration) || 0;
        const uniqueTitles = parseInt(viewingStats[0].unique_titles) || 0;
        const totalSessions = parseInt(viewingStats[0].total_sessions) || 0;
        const totalActiveDays = dailyActivity.length;
        const progress = buildWrappedProgress({ totalMinutes, uniqueTitles, totalSessions, totalActiveDays });

        if (!progress.isEligible) {
            console.log(`[Wrapped][PERF] Not enough data yet â€” total ${Date.now() - _t.start}ms`);
            return res.json({
                success: true,
                wrapped: null,
                progress,
                message: "Pas encore assez de donnÃ©es pour dÃ©bloquer ce Wrapped."
            });
            console.log(`[Wrapped][PERF] No data — total ${Date.now() - _t.start}ms`);
            return res.json({ success: true, wrapped: null, message: "Pas encore de données pour cette année." });
        }

        // ── 2. TMDB enrichment (parallel, Redis-cached) ────────────────────────
        _t.tmdbStart = Date.now();

        // Deduplicate: merge top5 + top10-genres + first/last into a single unique set
        const allContentToEnrich = new Map(); // key: "type:id" -> content row
        [...topContent, ...topContentForGenres].forEach(c => {
            const k = `${c.content_type}:${c.content_id}`;
            if (!allContentToEnrich.has(k)) allContentToEnrich.set(k, c);
        });
        const firstWatchData = firstWatch[0] || null;
        const lastWatchData  = lastWatch[0] || null;
        if (firstWatchData && !firstWatchData.content_title) {
            const k = `${firstWatchData.content_type}:${firstWatchData.content_id}`;
            if (!allContentToEnrich.has(k)) allContentToEnrich.set(k, firstWatchData);
        }
        if (lastWatchData && !lastWatchData.content_title) {
            const k = `${lastWatchData.content_type}:${lastWatchData.content_id}`;
            if (!allContentToEnrich.has(k)) allContentToEnrich.set(k, lastWatchData);
        }

        console.log(`[Wrapped][PERF] 🎯 TMDB: ${allContentToEnrich.size} unique items to enrich (deduped from ${topContent.length + topContentForGenres.length + (firstWatchData ? 1 : 0) + (lastWatchData ? 1 : 0)})`);

        // ── Batch TMDB: single MGET for all Redis cache keys, then API-fetch misses ──
        const tmdbCache = new Map(); // key -> details
        const itemsNeedingFetch = []; // [{key, content}] — items not already complete

        // Separate already-complete items from those needing TMDB lookup
        for (const [key, content] of allContentToEnrich) {
            if (content.content_title && content.poster_path) {
                tmdbCache.set(key, { title: content.content_title, poster_path: content.poster_path, genres: content.genres || [], vote_average: content.vote_average || null });
            } else {
                itemsNeedingFetch.push({ key, content });
            }
        }

        if (itemsNeedingFetch.length > 0 && redisReady()) {
            // Build Redis keys for MGET (même pattern que tmdbCache.js)
            const redisKeys = itemsNeedingFetch.map(({ content }) => {
                const mediaType = content.content_type === 'anime' ? 'tv' : content.content_type;
                return `tmdb:details:${mediaType}:${content.content_id}:fr-FR`;
            });

            try {
                const tMget = Date.now();
                const mgetResults = await redis.mget(...redisKeys);
                console.log(`[Wrapped][TMDB] ⚡ MGET ${redisKeys.length} keys in ${Date.now() - tMget}ms`);

                const apiMisses = []; // items not found in Redis
                for (let i = 0; i < itemsNeedingFetch.length; i++) {
                    const { key, content } = itemsNeedingFetch[i];
                    if (mgetResults[i]) {
                        try {
                            tmdbCache.set(key, extractWrappedFields(JSON.parse(mgetResults[i])));
                            continue;
                        } catch { /* treat as miss */ }
                    }
                    apiMisses.push({ key, content });
                }

                // Fetch remaining misses from TMDB API in parallel
                if (apiMisses.length > 0) {
                    console.log(`[Wrapped][TMDB] 🌐 Fetching ${apiMisses.length} items from API (${apiMisses.length} Redis misses)`);
                    await Promise.all(apiMisses.map(async ({ key, content }) => {
                        const details = await fetchTMDBDetails(content.content_id, content.content_type);
                        if (details) tmdbCache.set(key, details);
                    }));
                }
            } catch (mgetErr) {
                // Fallback: parallel individual fetches
                console.warn('[Wrapped][TMDB] MGET failed, falling back to individual fetches:', mgetErr.message);
                await Promise.all(itemsNeedingFetch.map(async ({ key, content }) => {
                    const details = await fetchTMDBDetails(content.content_id, content.content_type);
                    if (details) tmdbCache.set(key, details);
                }));
            }
        } else if (itemsNeedingFetch.length > 0) {
            // No Redis: parallel individual fetches
            await Promise.all(itemsNeedingFetch.map(async ({ key, content }) => {
                const details = await fetchTMDBDetails(content.content_id, content.content_type);
                if (details) tmdbCache.set(key, details);
            }));
        }

        _t.tmdbEnd = Date.now();
        console.log(`[Wrapped][PERF] 🎬 TMDB enrichment: ${_t.tmdbEnd - _t.tmdbStart}ms (${tmdbCache.size} resolved)`);

        // Apply TMDB data back to arrays using the cache
        function applyTMDB(arr) {
            return arr.map(c => {
                const k = `${c.content_type}:${c.content_id}`;
                const d = tmdbCache.get(k);
                if (!d) return { ...c, content_title: c.content_title || `${c.content_type} #${c.content_id}`, poster_path: c.poster_path || null, genres: [], vote_average: null };
                return { ...c, content_title: d.title || c.content_title, poster_path: d.poster_path || c.poster_path || null, genres: d.genres || [], vote_average: d.vote_average || null };
            });
        }
        const enrichedTopContent = applyTMDB(topContent);
        const enrichedForGenres  = applyTMDB(topContentForGenres);

        // Apply to first/last watch
        if (firstWatchData && !firstWatchData.content_title) {
            const d = tmdbCache.get(`${firstWatchData.content_type}:${firstWatchData.content_id}`);
            if (d) firstWatchData.content_title = d.title;
        }
        if (lastWatchData && !lastWatchData.content_title) {
            const d = tmdbCache.get(`${lastWatchData.content_type}:${lastWatchData.content_id}`);
            if (d) lastWatchData.content_title = d.title;
        }

        // ── 3. Compute derived stats (pure JS, no I/O) ─────────────────────────
        _t.computeStart = Date.now();

        // Listening clock: peak hour
        const hourlyMap = new Array(24).fill(0);
        hourlyStats.forEach(h => { hourlyMap[h.hour_of_day] = parseInt(h.duration); });
        const peakHour = hourlyMap.indexOf(Math.max(...hourlyMap));
        const nightOwlMinutes = hourlyMap.slice(22, 24).reduce((a, b) => a + b, 0) + hourlyMap.slice(0, 5).reduce((a, b) => a + b, 0);
        const earlyBirdMinutes = hourlyMap.slice(5, 10).reduce((a, b) => a + b, 0);
        const isNightOwl = nightOwlMinutes > totalMinutes * 0.3;
        const isEarlyBird = earlyBirdMinutes > totalMinutes * 0.3;

        // Watching streaks
        let longestStreak = 0, currentStreak = 0;
        for (let i = 0; i < dailyActivity.length; i++) {
            if (i === 0) { currentStreak = 1; }
            else {
                const prev = new Date(dailyActivity[i - 1].watch_date);
                const curr = new Date(dailyActivity[i].watch_date);
                const diffDays = Math.round((curr - prev) / (1000 * 60 * 60 * 24));
                currentStreak = diffDays === 1 ? currentStreak + 1 : 1;
            }
            longestStreak = Math.max(longestStreak, currentStreak);
        }

        // Genre analysis
        const genreMinutes = {};
        enrichedForGenres.forEach(item => {
            const mins = parseInt(item.duration);
            (item.genres || []).forEach(genre => {
                genreMinutes[genre] = (genreMinutes[genre] || 0) + mins;
            });
        });
        const topGenres = Object.entries(genreMinutes)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, minutes]) => ({ name, minutes, percent: Math.round((minutes / totalMinutes) * 100) }));

        // Monthly graph (all 12 months)
        const monthMap = {};
        monthlyStats.forEach(m => { monthMap[m.month] = parseInt(m.duration); });
        const monthlyGraph = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, minutes: monthMap[i + 1] || 0 }));

        // Session stats
        const avgSessionMinutes = Math.round(totalMinutes / Math.max(totalSessions, 1));

        // Base stats
        const totalHours = Math.round(totalMinutes / 60);
        const totalDays = parseFloat((totalMinutes / 60 / 24).toFixed(1));
        const totalDurationLabel = formatDuration(totalMinutes);

        // Dominant type
        const dominantType = typeStats[0] || { content_type: 'movie', duration: 0, count: 0 };
        const dominantPercent = totalMinutes > 0 ? Math.round((parseInt(dominantType.duration) / totalMinutes) * 100) : 0;

        // Top content
        const topShow = enrichedTopContent[0] || null;
        const topShowMinutes = topShow ? parseInt(topShow.duration) : 0;
        const topShowHours = Math.round(topShowMinutes / 60);
        const topShowDurationLabel = formatDuration(topShowMinutes);
        const topShowTitle = topShow ? topShow.content_title : null;
        const topShowType = topShow ? topShow.content_type : null;

        const secondShow = enrichedTopContent[1] || null;
        const secondShowTitle = secondShow ? secondShow.content_title : null;

        // Peak / lowest month
        const peakMonth = monthlyStats[0] || { month: 1, duration: 0 };
        const lowestMonth = monthlyStats[monthlyStats.length - 1] || peakMonth;
        const monthNames = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

        // Diversity / loyalty / binge
        const diversityScore = totalHours > 0 ? (uniqueTitles / totalHours) : 0;
        const isExplorer = diversityScore > 0.5;
        const isLoyal = diversityScore < 0.1 && uniqueTitles < 20;
        const isBinger = topShowHours > totalHours * 0.3;

        // Type percents
        const animeStats = typeStats.find(t => t.content_type === 'anime');
        const movieStats = typeStats.find(t => t.content_type === 'movie');
        const tvStats    = typeStats.find(t => t.content_type === 'tv');

        const animePercent = animeStats ? Math.round((parseInt(animeStats.duration) / totalMinutes) * 100) : 0;
        const moviePercent = movieStats ? Math.round((parseInt(movieStats.duration) / totalMinutes) * 100) : 0;
        const tvPercent    = tvStats    ? Math.round((parseInt(tvStats.duration)    / totalMinutes) * 100) : 0;

        _t.computeEnd = Date.now();
        console.log(`[Wrapped][PERF] 🧮 Compute stats: ${_t.computeEnd - _t.computeStart}ms`);

        // ── 4. Persona + slides (pure CPU) ──────────────────────────────────────

        const persona = determinePersona({
            totalHours, uniqueTitles, dominantPercent, dominantType,
            animePercent, moviePercent, tvPercent, isExplorer, isLoyal, isBinger,
            topShowType, topShowHours, isNightOwl
        });

        const slides = generateSlides({
            totalMinutes, totalHours, totalDays, totalDurationLabel, uniqueTitles,
            topShowTitle, topShowHours, topShowMinutes, topShowDurationLabel, topShowType,
            secondShowTitle, secondShow,
            dominantType, dominantPercent,
            peakMonth, lowestMonth, monthNames,
            animePercent, moviePercent, tvPercent,
            isExplorer, isLoyal, isBinger,
            enrichedTopContent, typeStats, persona,
            year,
            percentile, peakHour, isNightOwl, isEarlyBird,
            longestStreak, totalActiveDays,
            firstWatchData, lastWatchData,
            topGenres, avgSessionMinutes
        });

        _t.slidesEnd = Date.now();
        console.log(`[Wrapped][PERF] 🎨 Persona + slides: ${_t.slidesEnd - _t.computeEnd}ms`);

        // ── 5. Build response ───────────────────────────────────────────────────

        const wrapped = {
            year: parseInt(year),
            persona,
            slides,
            stats: {
                totalMinutes, totalHours, totalDays, uniqueTitles,
                totalSessions,
                avgSessionMinutes, totalActiveDays, longestStreak, percentile
            },
            topContent: enrichedTopContent.map((c, i) => {
                const mins = parseInt(c.duration);
                return {
                    rank: i + 1,
                    title: c.content_title,
                    type: c.content_type,
                    minutes: mins,
                    hours: Math.round(mins / 60),
                    durationLabel: formatDurationShort(mins),
                    tmdbId: c.content_type !== 'live-tv' ? parseInt(c.content_id) : null,
                    poster_path: c.poster_path,
                    genres: c.genres || []
                };
            }),
            byType: typeStats.map(t => ({
                type: t.content_type,
                minutes: parseInt(t.duration),
                count: parseInt(t.count),
                percent: Math.round((parseInt(t.duration) / totalMinutes) * 100)
            })),
            topGenres,
            peakMonth: { month: peakMonth.month, name: monthNames[peakMonth.month], minutes: parseInt(peakMonth.duration) },
            monthlyGraph,
            listeningClock: hourlyMap.map((minutes, hour) => ({ hour, minutes })),
            peakHour,
            firstWatch: firstWatchData ? {
                title: firstWatchData.content_title, type: firstWatchData.content_type,
                date: firstWatchData.created_at,
                tmdbId: firstWatchData.content_type !== 'live-tv' ? parseInt(firstWatchData.content_id) : null
            } : null,
            lastWatch: lastWatchData ? {
                title: lastWatchData.content_title, type: lastWatchData.content_type,
                date: lastWatchData.created_at,
                tmdbId: lastWatchData.content_type !== 'live-tv' ? parseInt(lastWatchData.content_id) : null
            } : null,
            topPages: topPages.map(p => ({ page: p.page_name, minutes: parseInt(p.duration) }))
        };

        // ── 6. Store in Redis cache (fire-and-forget) ───────────────────────────
        const responsePayload = { success: true, wrapped, progress };
        redisSet(cacheKey, JSON.stringify(responsePayload), WRAPPED_CACHE_TTL);

        const totalTime = Date.now() - _t.start;
        console.log(`[Wrapped][PERF] ── DONE in ${totalTime}ms ── Breakdown: SQL+Pctile(parallel)=${_t.sqlEnd - _t.sqlStart}ms | TMDB=${_t.tmdbEnd - _t.tmdbStart}ms | Compute=${_t.computeEnd - _t.computeStart}ms | Slides=${_t.slidesEnd - _t.computeEnd}ms | Build+Send=${Date.now() - _t.slidesEnd}ms`);

        res.json(responsePayload);

    } catch (error) {
        console.error('[Wrapped] Error generating wrapped:', error);
        res.status(500).json({ success: false, error: 'Generation failed' });
    }
});

// ============================================
// === FONCTIONS DE GÉNÉRATION TEMPLATES ===
// ============================================

/**
 * Détermine la personnalité de visionnage de l'utilisateur
 * Basé sur des règles de classification (comme le ML de Spotify)
 */
function determinePersona(data) {
    const {
        totalHours, uniqueTitles, dominantPercent, dominantType,
        animePercent, moviePercent, tvPercent, isExplorer, isLoyal, isBinger,
        topShowType, topShowHours, isNightOwl
    } = data;

    // Personas par priorité (le premier qui matche gagne)
    const personas = [
        // --- PERSONAS EXTRÊMES (basés sur l'intensité) ---
        {
            condition: totalHours > 1000,
            persona: {
                id: 'legend',
                title: 'La Légende Vivante',
                emoji: '👑',
                subtitle: 'Tu as littéralement vécu sur Movix cette année',
                description: 'Plus de 1000 heures. On devrait te payer à ce stade.',
                color: '#FFD700'
            }
        },
        {
            condition: totalHours > 500,
            persona: {
                id: 'marathon',
                title: 'Le Marathonien Ultime',
                emoji: '🏃‍♂️',
                subtitle: 'Ton canapé a une empreinte permanente de toi',
                description: 'Tu as transformé le binge-watching en sport olympique.',
                color: '#FF6B35'
            }
        },
        // --- NIGHT OWL ---
        {
            condition: isNightOwl && totalHours > 100,
            persona: {
                id: 'night-owl',
                title: 'L\'Oiseau de Nuit',
                emoji: '🦉',
                subtitle: 'La nuit, tous les écrans sont gris... sauf le tien',
                description: 'Tu fais tes meilleures sessions entre minuit et 5h.',
                color: '#1A237E'
            }
        },
        // --- PERSONAS PAR TYPE DOMINANT ---
        {
            condition: animePercent > 80,
            persona: {
                id: 'weeb-supreme',
                title: 'Weeb Suprême',
                emoji: '⛩️',
                subtitle: 'Tu penses en sous-titres à ce stade',
                description: 'Plus de 80% d\'anime. Tu es officiellement plus japonais que français.',
                color: '#E91E63'
            }
        },
        {
            condition: animePercent > 50,
            persona: {
                id: 'otaku',
                title: 'L\'Otaku Assumé',
                emoji: '🍜',
                subtitle: 'Ton cœur bat au rythme des openings',
                description: 'Les animes ne sont pas une phase, c\'est un mode de vie.',
                color: '#9C27B0'
            }
        },
        {
            condition: moviePercent > 70 && uniqueTitles > 50,
            persona: {
                id: 'critic',
                title: 'Le Critique',
                emoji: '🎬',
                subtitle: 'Tu as un avis sur tout, et il est probablement juste',
                description: 'Tu pourrais écrire pour les Cahiers du Cinéma.',
                color: '#2196F3'
            }
        },
        {
            condition: moviePercent > 70,
            persona: {
                id: 'cinephile',
                title: 'Le Cinéphile',
                emoji: '🎥',
                subtitle: 'Le 7ème art coule dans tes veines',
                description: 'Les films, c\'est ta religion.',
                color: '#3F51B5'
            }
        },
        {
            condition: tvPercent > 70 && isBinger,
            persona: {
                id: 'binger',
                title: 'Le Binge-Watcher Pro',
                emoji: '📺',
                subtitle: '"Encore un épisode" est ton mantra',
                description: 'Tu ne regardes pas les séries, tu les dévores.',
                color: '#4CAF50'
            }
        },
        {
            condition: tvPercent > 50,
            persona: {
                id: 'series-addict',
                title: 'L\'Accro aux Séries',
                emoji: '📡',
                subtitle: 'Tu connais plus de personnages fictifs que de vraies personnes',
                description: 'Les séries sont ta deuxième famille.',
                color: '#009688'
            }
        },
        // --- PERSONAS PAR COMPORTEMENT ---
        {
            condition: isExplorer && uniqueTitles > 100,
            persona: {
                id: 'explorer-elite',
                title: 'L\'Explorateur d\'Élite',
                emoji: '🧭',
                subtitle: 'Tu as vu des trucs dont personne n\'a entendu parler',
                description: 'Plus de 100 titres ! Tu es la définition de la curiosité.',
                color: '#FF9800'
            }
        },
        {
            condition: isExplorer,
            persona: {
                id: 'explorer',
                title: 'L\'Explorateur',
                emoji: '🔍',
                subtitle: 'Toujours en quête de la prochaine pépite',
                description: 'Tu préfères découvrir que revoir.',
                color: '#FFC107'
            }
        },
        {
            condition: isLoyal && topShowHours > 50,
            persona: {
                id: 'superfan',
                title: 'Le Superfan',
                emoji: '💜',
                subtitle: 'Tu as trouvé TON truc et tu t\'y tiens',
                description: 'La loyauté, c\'est ta plus grande qualité.',
                color: '#673AB7'
            }
        },
        {
            condition: isLoyal,
            persona: {
                id: 'comfort-watcher',
                title: 'L\'Amateur de Confort',
                emoji: '🛋️',
                subtitle: 'Pourquoi changer une équipe qui gagne ?',
                description: 'Tu remates tes classiques, et c\'est très bien comme ça.',
                color: '#795548'
            }
        }
    ];

    // Chercher le premier persona qui matche
    for (const p of personas) {
        if (p.condition === true) {
            return p.persona;
        }
    }

    // Persona par défaut basé sur le type dominant
    const defaultPersonas = {
        'anime': {
            id: 'anime-fan',
            title: 'L\'Anime Fan',
            emoji: '✨',
            subtitle: 'Tu apprécies l\'art de l\'animation japonaise',
            description: 'Un équilibre sain d\'anime dans ta vie.',
            color: '#E91E63'
        },
        'movie': {
            id: 'movie-lover',
            title: 'L\'Amoureux du Cinéma',
            emoji: '🍿',
            subtitle: 'Rien ne vaut un bon film',
            description: 'Tu sais apprécier une bonne histoire.',
            color: '#2196F3'
        },
        'tv': {
            id: 'tv-enthusiast',
            title: 'L\'Enthousiaste des Séries',
            emoji: '📺',
            subtitle: 'Les séries font partie de ta routine',
            description: 'Un épisode par jour éloigne le médecin.',
            color: '#4CAF50'
        },
        'live-tv': {
            id: 'live-watcher',
            title: 'Le Téléspectateur',
            emoji: '📡',
            subtitle: 'Tu restes connecté à l\'actualité',
            description: 'La TV en direct, c\'est ton truc.',
            color: '#607D8B'
        }
    };

    return defaultPersonas[dominantType.content_type] || defaultPersonas['movie'];
}

/**
 * Formate une durée en minutes : affiche les heures si >= 60 min, sinon les minutes
 * @param {number} minutes
 * @returns {string} e.g. "12 heures" ou "45 minutes"
 */
function formatDuration(minutes) {
    if (minutes >= 60) {
        const h = Math.round(minutes / 60);
        return `${h} heure${h > 1 ? 's' : ''}`;
    }
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

/**
 * Version courte : "12h" ou "45min"
 */
function formatDurationShort(minutes) {
    if (minutes >= 60) {
        return `${Math.round(minutes / 60)}h`;
    }
    return `${minutes}min`;
}

/**
 * Génère les slides du Wrapped avec des templates "à trous"
 * Écrit comme un copywriter Spotify le ferait
 */
function generateSlides(data) {
    const {
        totalMinutes, totalHours, totalDays, totalDurationLabel, uniqueTitles,
        topShowTitle, topShowHours, topShowMinutes, topShowDurationLabel, topShowType,
        secondShowTitle, secondShow,
        dominantType, dominantPercent,
        peakMonth, lowestMonth, monthNames,
        animePercent, moviePercent, tvPercent,
        isExplorer, isLoyal, isBinger,
        enrichedTopContent, typeStats, persona,
        year,
        // New data
        percentile, peakHour, isNightOwl, isEarlyBird,
        longestStreak, totalActiveDays,
        firstWatchData, lastWatchData,
        topGenres, avgSessionMinutes
    } = data;

    const slides = [];

    // === SLIDE 1: INTRO / HOOK ===
    const introTemplates = [
        {
            condition: totalHours > 200,
            title: `${year}, c'était intense.`,
            subtitle: 'Genre, vraiment intense.',
            text: `Tu as passé ${totalDurationLabel} sur Movix. C'est ${totalDays} jours complets. On espère que t'avais des snacks.`,
            highlight: `${totalDays} jours`
        },
        {
            condition: totalHours > 100,
            title: `${year} ? Tu l'as bien remplie.`,
            subtitle: 'Et ton historique aussi.',
            text: `${totalDurationLabel} de contenu. C'est plus que certains jobs à temps partiel.`,
            highlight: `${formatDurationShort(totalMinutes)}`
        },
        {
            condition: totalHours > 50,
            title: `Pas mal, ${year}.`,
            subtitle: 'Pas mal du tout.',
            text: `${totalDurationLabel} de streaming. Tu sais ce que tu veux.`,
            highlight: `${formatDurationShort(totalMinutes)}`
        },
        {
            condition: true,
            title: `${year} s'est bien passée.`,
            subtitle: 'On a les preuves.',
            text: `${totalDurationLabel} ensemble cette année. C'est un bon début.`,
            highlight: `${formatDurationShort(totalMinutes)}`
        }
    ];
    slides.push({ type: 'intro', ...introTemplates.find(t => t.condition) });

    // === SLIDE 2: TOP 1 ===
    if (topShowTitle) {
        const top1Templates = [
            {
                condition: topShowHours > 100,
                title: `"${topShowTitle}"`,
                subtitle: 'Ton obsession de l\'année',
                text: `${topShowDurationLabel} dessus. À ce stade, tu pourrais écrire la suite toi-même.`,
                highlight: `#1`,
                subtext: 'C\'est un peu gênant, mais on adore.'
            },
            {
                condition: topShowHours > 50,
                title: `"${topShowTitle}"`,
                subtitle: 'Ton coup de cœur absolu',
                text: `${topShowDurationLabel}. Tu l'as regardé, rerererereregardé, et tu recommencerais.`,
                highlight: `#1`,
                subtext: 'Fan numéro 1 ? C\'est toi.'
            },
            {
                condition: topShowHours > 20,
                title: `"${topShowTitle}"`,
                subtitle: 'Ta grande histoire d\'amour',
                text: `${topShowDurationLabel} ensemble. C'est plus que certaines relations.`,
                highlight: `#1`,
                subtext: 'Et on ne juge pas.'
            },
            {
                condition: true,
                title: `"${topShowTitle}"`,
                subtitle: 'Ton préféré de l\'année',
                text: `${topShowDurationLabel} passées dessus. Un classique dans ton cœur.`,
                highlight: `#1`,
                subtext: ''
            }
        ];
        slides.push({ type: 'top1', ...top1Templates.find(t => t.condition) });
    }

    // === SLIDE 3: TOP 5 ===
    if (enrichedTopContent.length >= 3) {
        const top5Text = enrichedTopContent.slice(0, 5).map((c, i) => 
            `${i + 1}. ${c.content_title}`
        ).join('\n');
        
        slides.push({
            type: 'top5',
            title: 'Ton Top 5',
            subtitle: 'Ceux qui ont marqué ton année',
            text: top5Text,
            highlight: `${uniqueTitles} titres au total`,
            subtext: uniqueTitles > 50 ? 'Tu es incollable.' : ''
        });
    }

    // === SLIDE 4: PERSONNALITÉ / VIBE ===
    const typeLabel = {
        'anime': 'les animes',
        'movie': 'les films',
        'tv': 'les séries',
        'live-tv': 'la TV en direct'
    };

    const vibeTemplates = [
        {
            condition: dominantPercent > 80,
            title: persona.title,
            subtitle: persona.subtitle,
            text: `${dominantPercent}% de ton temps sur ${typeLabel[dominantType.content_type]}. Tu sais ce que tu aimes, et tu assumes.`,
            highlight: persona.emoji,
            subtext: persona.description
        },
        {
            condition: dominantPercent > 50,
            title: persona.title,
            subtitle: persona.subtitle,
            text: `Ta vibe ? Principalement ${typeLabel[dominantType.content_type]}, avec une touche de variété.`,
            highlight: persona.emoji,
            subtext: persona.description
        },
        {
            condition: true,
            title: persona.title,
            subtitle: persona.subtitle,
            text: `Tu es éclectique. Un peu de tout, c'est ton style.`,
            highlight: persona.emoji,
            subtext: persona.description
        }
    ];
    slides.push({ type: 'persona', ...vibeTemplates.find(t => t.condition) });

    // === SLIDE 5: MOIS LE PLUS ACTIF ===
    const peakMonthMinutes = parseInt(peakMonth.duration);
    const peakMonthHours = Math.round(peakMonthMinutes / 60);
    const peakMonthDurationLabel = formatDuration(peakMonthMinutes);
    
    const monthTemplates = [
        {
            condition: peakMonthHours > 50,
            title: monthNames[peakMonth.month],
            subtitle: 'Ton mois de folie',
            text: `${peakMonthDurationLabel} en un seul mois. Il s'est passé quoi ? Rupture ? Vacances ? Les deux ?`,
            highlight: `🔥`,
            subtext: 'On ne juge pas, on constate.'
        },
        {
            condition: peakMonthHours > 20,
            title: monthNames[peakMonth.month],
            subtitle: 'Ton mois le plus actif',
            text: `${peakMonthDurationLabel}. Tu étais dans ta bulle, et c'était bien.`,
            highlight: `📅`,
            subtext: ''
        },
        {
            condition: true,
            title: monthNames[peakMonth.month],
            subtitle: 'Là où tout s\'est joué',
            text: `Ton pic de l'année. ${peakMonthDurationLabel} de pur bonheur.`,
            highlight: `✨`,
            subtext: ''
        }
    ];
    slides.push({ type: 'peak-month', ...monthTemplates.find(t => t.condition) });

    // === SLIDE 6: TOP GENRES ===
    if (topGenres && topGenres.length >= 2) {
        const topGenreNames = topGenres.slice(0, 3).map(g => g.name).join(', ');
        slides.push({
            type: 'top-genres',
            title: 'Tes genres préférés',
            subtitle: topGenreNames,
            text: topGenres.length >= 3
                ? `${topGenres[0].name} domine avec ${topGenres[0].percent}% de ton temps. Suivi par ${topGenres[1].name} et ${topGenres[2].name}.`
                : `${topGenres[0].name} domine avec ${topGenres[0].percent}% de ton temps.`,
            highlight: '🎭',
            subtext: topGenres.length > 5 ? `Et aussi : ${topGenres.slice(5).map(g => g.name).join(', ')}` : ''
        });
    }

    // === SLIDE 7: LISTENING CLOCK (Quand tu regardes) ===
    const hourLabel = (h) => `${h}h`;
    const clockTemplates = [
        {
            condition: isNightOwl,
            title: 'Le mode nocturne',
            subtitle: `Tu es le plus actif vers ${hourLabel(peakHour)}`,
            text: 'Pendant que le monde dort, toi tu mates. Tes yeux rouges ne mentent pas.',
            highlight: '🌙',
            subtext: 'Les meilleures sessions, c\'est la nuit.'
        },
        {
            condition: isEarlyBird,
            title: 'Lève-tôt, regarde tôt',
            subtitle: `Ton pic d'activité : ${hourLabel(peakHour)}`,
            text: 'Tu lances un épisode avant même que le café soit prêt. Respect.',
            highlight: '🌅',
            subtext: ''
        },
        {
            condition: true,
            title: `${hourLabel(peakHour)}, ton heure de pointe`,
            subtitle: 'Ton horloge de visionnage',
            text: `C'est à ${hourLabel(peakHour)} que tu lances le plus souvent Movix. On connaît tes habitudes maintenant.`,
            highlight: '⏰',
            subtext: ''
        }
    ];
    slides.push({ type: 'listening-clock', ...clockTemplates.find(t => t.condition) });

    // === SLIDE 8: STREAK ===
    if (longestStreak >= 3) {
        const streakTemplates = [
            {
                condition: longestStreak >= 30,
                title: `${longestStreak} jours de suite`,
                subtitle: 'Un mois complet non-stop',
                text: `Ta plus longue série de visionnage : ${longestStreak} jours consécutifs. On appelle ça de la détermination.`,
                highlight: '🔥',
                subtext: `Sur ${totalActiveDays} jours actifs cette année.`
            },
            {
                condition: longestStreak >= 14,
                title: `${longestStreak} jours d'affilée`,
                subtitle: 'Streak impressionnant',
                text: `Deux semaines sans lâcher Movix. Tu as une discipline de fer (pour le streaming en tout cas).`,
                highlight: '⚡',
                subtext: `${totalActiveDays} jours d'activité au total.`
            },
            {
                condition: longestStreak >= 7,
                title: `${longestStreak} jours non-stop`,
                subtitle: 'Une semaine de dédi',
                text: `Ta meilleure série : ${longestStreak} jours sans interruption. C'est de la constance.`,
                highlight: '💪',
                subtext: ''
            },
            {
                condition: true,
                title: `${longestStreak} jours de streak`,
                subtitle: 'Ta meilleure série',
                text: `${longestStreak} jours de visionnage consécutifs. Pas mal comme streak.`,
                highlight: '🎯',
                subtext: ''
            }
        ];
        slides.push({ type: 'streak', ...streakTemplates.find(t => t.condition) });
    }

    // === SLIDE 9: FUN FACT ===
    const funFacts = [];
    
    if (totalHours > 24) {
        const equivalent = Math.floor(totalHours / 2); // Un film moyen = 2h
        funFacts.push({
            title: 'En d\'autres termes...',
            subtitle: '',
            text: `Tu aurais pu regarder ${equivalent} films de suite. Ou dormir ${totalDays} jours. Tu as fait un choix.`,
            highlight: '🤔',
            subtext: 'Le bon choix.'
        });
    } else if (totalMinutes > 30) {
        funFacts.push({
            title: 'En d\'autres termes...',
            subtitle: '',
            text: `${totalDurationLabel} de streaming. C'est déjà un bon début pour cette année.`,
            highlight: '🤔',
            subtext: 'Et ce n\'est que le début.'
        });
    }
    
    if (isExplorer && uniqueTitles > 30) {
        funFacts.push({
            title: 'L\'algorithme t\'adore',
            subtitle: '',
            text: `${uniqueTitles} titres différents. Tu rends notre job de recommandation vraiment difficile (et intéressant).`,
            highlight: '🧠',
            subtext: ''
        });
    }

    if (isBinger && topShowTitle) {
        const percentOfTotal = totalMinutes > 0 ? Math.round((topShowMinutes / totalMinutes) * 100) : 0;
        funFacts.push({
            title: 'Confession time',
            subtitle: '',
            text: `"${topShowTitle}" représente ${percentOfTotal}% de ton temps total. C'est de l'engagement.`,
            highlight: '💍',
            subtext: 'Ou de l\'obsession. Mais qui compte ?'
        });
    }

    // Percentile fun fact
    if (percentile >= 90) {
        funFacts.push({
            title: `Top ${100 - percentile}% des viewers`,
            subtitle: 'Tu es dans l\'élite',
            text: `Tu regardes plus que ${percentile}% des utilisateurs Movix. On devrait te donner un badge.`,
            highlight: '🏆',
            subtext: ''
        });
    }

    // Session length fun fact
    if (avgSessionMinutes > 90) {
        funFacts.push({
            title: 'Sessions marathon',
            subtitle: '',
            text: `En moyenne, tes sessions durent ${avgSessionMinutes} minutes. Tu ne fais pas les choses à moitié.`,
            highlight: '🍿',
            subtext: 'Netflix and actually chill.'
        });
    }

    // First watch of the year fun fact
    if (firstWatchData) {
        const firstDate = new Date(firstWatchData.created_at);
        const dayOfYear = Math.ceil((firstDate - new Date(firstDate.getFullYear(), 0, 1)) / (1000 * 60 * 60 * 24));
        if (dayOfYear <= 3) {
            funFacts.push({
                title: 'Pas de temps à perdre',
                subtitle: '',
                text: `Ton premier visionnage de ${year} ? "${firstWatchData.content_title}", dès le ${dayOfYear === 1 ? '1er' : dayOfYear + 'ème'} janvier. Tu n'as pas attendu longtemps.`,
                highlight: '🎆',
                subtext: ''
            });
        }
    }

    if (funFacts.length > 0) {
        // Pick 1-2 fun facts
        const shuffled = funFacts.sort(() => 0.5 - Math.random());
        slides.push({ type: 'fun-fact', ...shuffled[0] });
        if (shuffled.length > 1 && totalHours > 50) {
            slides.push({ type: 'fun-fact', ...shuffled[1] });
        }
    }

    // === SLIDE 10: DETAILED STATS ===
    slides.push({
        type: 'detailed-stats',
        title: 'Tes Statistiques',
        subtitle: 'En détail',
        text: 'Le résumé complet de ton année.',
        highlight: '📊',
        subtext: ''
    });

    // === SLIDE 8: CLOSING ===
    slides.push({
        type: 'closing',
        title: `C'était ${year}.`,
        subtitle: 'Avec toi.',
        text: `${totalDurationLabel}. ${uniqueTitles} titres. 1 seul toi. Merci d'avoir passé cette année sur Movix.`,
        highlight: '💜',
        subtext: 'À l\'année prochaine ?'
    });

    return slides;
}

module.exports = { router, initWrappedRoutes, initTables };
