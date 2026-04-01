/**
 * Movix Top 10 - Public endpoint
 * Returns the top 10 most watched movies and series by logged-in users
 * Based on aggregated data from wrapped_viewing_data table
 * Uses Redis for caching
 */

const express = require('express');
const router = express.Router();
const { fetchTmdbDetails } = require('./utils/tmdbCache');

const TMDB_API_URL = 'https://api.themoviedb.org/3';

let pool = null;
let redis = null;

const CACHE_REFRESH = 1800;  // 30 min — seuil de rafraîchissement en arrière-plan
const CACHE_TTL = 86400;     // 24h — TTL Redis réel (stale-while-revalidate)
const CACHE_PREFIX = 'top10:';

// Verrous en mémoire pour éviter les rafraîchissements simultanés
const refreshLocks = new Set();

/**
 * Initialize with MySQL pool and Redis instance
 */
function initTop10Routes(mysqlPool, redisInstance) {
    pool = mysqlPool;
    redis = redisInstance || null;
}

/**
 * Redis cache helpers — stale-while-revalidate
 * On stocke { data, updatedAt } avec un TTL long (24h).
 * Si updatedAt > 30min, on rafraîchit en arrière-plan.
 */
async function cacheGet(key) {
    if (!redis) return null;
    try {
        const raw = await redis.get(`${CACHE_PREFIX}${key}`);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        console.warn('[Top10] Redis GET error:', err.message);
        return null;
    }
}

async function cacheSet(key, value) {
    if (!redis) return;
    try {
        const wrapper = { data: value, updatedAt: Date.now() };
        await redis.set(`${CACHE_PREFIX}${key}`, JSON.stringify(wrapper), 'EX', CACHE_TTL);
    } catch (err) {
        console.warn('[Top10] Redis SET error:', err.message);
    }
}

function isStale(wrapper) {
    if (!wrapper || !wrapper.updatedAt) return true;
    return (Date.now() - wrapper.updatedAt) > CACHE_REFRESH * 1000;
}

/**
 * Fetch TMDB details for enrichment (via tmdbCache Redis centralisé)
 */
async function fetchTMDBDetails(contentId, contentType) {
    if (contentType === 'live-tv') return null;
    const mediaType = contentType === 'anime' ? 'tv' : contentType;

    const data = await fetchTmdbDetails(TMDB_API_URL, process.env.TMDB_API_KEY, contentId, mediaType, 'fr-FR');
    if (!data) return null;

    return {
        title: data.title || data.name,
        poster_path: data.poster_path,
        backdrop_path: data.backdrop_path,
        overview: data.overview,
        vote_average: data.vote_average || null,
        genres: (data.genres || []).map(g => typeof g === 'string' ? g : g.name),
        release_date: data.release_date || data.first_air_date || null,
        runtime: data.runtime || data.episode_run_time?.[0] || null,
    };
}


/**
 * GET /api/top10/movies
 * Public - no auth required
 * Returns top 10 most watched movies across all logged-in users
 */
router.get('/movies', async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({ success: false, error: 'Database not available' });
        }

        // Stale-while-revalidate : renvoyer le cache immédiatement, rafraîchir en arrière-plan
        const wrapper = await cacheGet('movies');
        if (wrapper && wrapper.data) {
            res.json(wrapper.data);
            // Rafraîchir en arrière-plan si périmé
            if (isStale(wrapper) && !refreshLocks.has('movies')) {
                refreshLocks.add('movies');
                refreshTop10('movies').finally(() => refreshLocks.delete('movies'));
            }
            return;
        }

        // Pas de cache du tout — requête synchrone
        const result = await buildTop10Movies();
        await cacheSet('movies', result);
        res.json(result);
    } catch (error) {
        console.error('[Top10] Error fetching movies:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /api/top10/tv
 * Public - no auth required
 * Returns top 10 most watched TV series across all logged-in users
 */
router.get('/tv', async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({ success: false, error: 'Database not available' });
        }

        const wrapper = await cacheGet('tv');
        if (wrapper && wrapper.data) {
            res.json(wrapper.data);
            if (isStale(wrapper) && !refreshLocks.has('tv')) {
                refreshLocks.add('tv');
                refreshTop10('tv').finally(() => refreshLocks.delete('tv'));
            }
            return;
        }

        const result = await buildTop10Tv();
        await cacheSet('tv', result);
        res.json(result);
    } catch (error) {
        console.error('[Top10] Error fetching TV:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /api/top10/anime
 * Public - no auth required
 * Returns top 10 most watched anime across all logged-in users
 */
router.get('/anime', async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({ success: false, error: 'Database not available' });
        }

        const wrapper = await cacheGet('anime');
        if (wrapper && wrapper.data) {
            res.json(wrapper.data);
            if (isStale(wrapper) && !refreshLocks.has('anime')) {
                refreshLocks.add('anime');
                refreshTop10('anime').finally(() => refreshLocks.delete('anime'));
            }
            return;
        }

        const result = await buildTop10Anime();
        await cacheSet('anime', result);
        res.json(result);
    } catch (error) {
        console.error('[Top10] Error fetching anime:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * GET /api/top10/stats
 * Public - global platform stats
 * Optional query param:
 * - type=movies|tv|anime to get stats per category
 */
router.get('/stats', async (req, res) => {
    try {
        if (!pool) {
            return res.status(503).json({ success: false, error: 'Database not available' });
        }

        const requestedType = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : null;
        const typeConfig = requestedType ? {
            movies: { contentType: 'movie', minDuration: 1200 },
            tv: { contentType: 'tv', minDuration: 300 },
            anime: { contentType: 'anime', minDuration: 300 },
        }[requestedType] : null;

        if (requestedType && !typeConfig) {
            return res.status(400).json({
                success: false,
                error: 'Invalid type. Allowed values: movies, tv, anime',
            });
        }

        const cacheKey = requestedType ? `stats:${requestedType}` : 'stats';
        const wrapper = await cacheGet(cacheKey);
        if (wrapper && wrapper.data) {
            res.json(wrapper.data);
            if (isStale(wrapper) && !refreshLocks.has(cacheKey)) {
                refreshLocks.add(cacheKey);
                refreshStats(requestedType, typeConfig).finally(() => refreshLocks.delete(cacheKey));
            }
            return;
        }

        let statsQuery = `
            SELECT 
                COUNT(DISTINCT user_id) AS total_active_users,
                COUNT(DISTINCT content_id) AS total_unique_content,
                ROUND(SUM(watch_duration) / 3600, 0) AS total_hours_watched,
                COUNT(*) AS total_sessions,
                ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes,
                MIN(created_at) AS data_from,
                MAX(created_at) AS data_to
            FROM wrapped_viewing_data
            WHERE watch_duration >= ?
        `;
        let statsParams = [300];

        // watch_duration is stored in SECONDS
        if (typeConfig) {
            statsQuery = `
                SELECT 
                    COUNT(DISTINCT user_id) AS total_active_users,
                    COUNT(DISTINCT content_id) AS total_unique_content,
                    ROUND(SUM(watch_duration) / 3600, 0) AS total_hours_watched,
                    COUNT(*) AS total_sessions,
                    ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes,
                    MIN(created_at) AS data_from,
                    MAX(created_at) AS data_to
                FROM wrapped_viewing_data
                WHERE content_type = ?
                  AND watch_duration >= ?
            `;
            statsParams = [typeConfig.contentType, typeConfig.minDuration];
        }

        const [stats] = await pool.execute(statsQuery, statsParams);

        const result = {
            success: true,
            type: requestedType || 'global',
            stats: {
                totalActiveUsers: parseInt(stats[0].total_active_users) || 0,
                totalUniqueContent: parseInt(stats[0].total_unique_content) || 0,
                totalHoursWatched: parseInt(stats[0].total_hours_watched) || 0,
                totalSessions: parseInt(stats[0].total_sessions) || 0,
                avgSessionMinutes: parseInt(stats[0].avg_session_minutes) || 0,
                dataFrom: stats[0].data_from ? new Date(stats[0].data_from).toISOString() : null,
                dataTo: stats[0].data_to ? new Date(stats[0].data_to).toISOString() : null,
            },
            updatedAt: new Date().toISOString(),
        };

        await cacheSet(cacheKey, result);
        res.json(result);
    } catch (error) {
        console.error('[Top10] Error fetching stats:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ---------------------------------------------------------------------------
// Fonctions de construction des top 10 (extraites des routes pour réutilisation)
// ---------------------------------------------------------------------------

async function buildTop10Movies() {
    const [rows] = await pool.execute(`
        SELECT
            content_id,
            MAX(content_title) AS content_title,
            COUNT(DISTINCT user_id) AS unique_viewers,
            ROUND(SUM(watch_duration) / 3600, 1) AS total_hours,
            COUNT(*) AS total_sessions,
            ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes
        FROM wrapped_viewing_data
        WHERE content_type = 'movie'
          AND watch_duration >= 1200
        GROUP BY content_id
        ORDER BY unique_viewers DESC, total_hours DESC
        LIMIT 10
    `);

    const enriched = await Promise.all(rows.map(async (row, index) => {
        const tmdb = await fetchTMDBDetails(row.content_id, 'movie');
        return {
            rank: index + 1,
            contentId: row.content_id,
            title: tmdb?.title || row.content_title || `Film #${row.content_id}`,
            posterPath: tmdb?.poster_path || null,
            backdropPath: tmdb?.backdrop_path || null,
            overview: tmdb?.overview || null,
            voteAverage: tmdb?.vote_average || null,
            genres: tmdb?.genres || [],
            releaseDate: tmdb?.release_date || null,
            uniqueViewers: parseInt(row.unique_viewers),
            totalHours: parseFloat(row.total_hours),
            totalSessions: parseInt(row.total_sessions),
            avgSessionMinutes: parseInt(row.avg_session_minutes),
        };
    }));

    return { success: true, type: 'movies', top10: enriched, updatedAt: new Date().toISOString() };
}

async function buildTop10Tv() {
    const [rows] = await pool.execute(`
        SELECT
            content_id,
            MAX(content_title) AS content_title,
            COUNT(DISTINCT user_id) AS unique_viewers,
            ROUND(SUM(watch_duration) / 3600, 1) AS total_hours,
            COUNT(*) AS total_sessions,
            ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes,
            COUNT(DISTINCT CONCAT(IFNULL(season_number, ''), '-', IFNULL(episode_number, ''))) AS episodes_watched
        FROM wrapped_viewing_data
        WHERE content_type = 'tv'
          AND watch_duration >= 300
        GROUP BY content_id
        ORDER BY unique_viewers DESC, total_hours DESC
        LIMIT 10
    `);

    const enriched = await Promise.all(rows.map(async (row, index) => {
        const tmdb = await fetchTMDBDetails(row.content_id, 'tv');
        return {
            rank: index + 1,
            contentId: row.content_id,
            title: tmdb?.title || row.content_title || `Série #${row.content_id}`,
            posterPath: tmdb?.poster_path || null,
            backdropPath: tmdb?.backdrop_path || null,
            overview: tmdb?.overview || null,
            voteAverage: tmdb?.vote_average || null,
            genres: tmdb?.genres || [],
            releaseDate: tmdb?.release_date || null,
            uniqueViewers: parseInt(row.unique_viewers),
            totalHours: parseFloat(row.total_hours),
            totalSessions: parseInt(row.total_sessions),
            avgSessionMinutes: parseInt(row.avg_session_minutes),
            episodesWatched: parseInt(row.episodes_watched),
        };
    }));

    return { success: true, type: 'tv', top10: enriched, updatedAt: new Date().toISOString() };
}

async function buildTop10Anime() {
    const [rows] = await pool.execute(`
        SELECT
            content_id,
            MAX(content_title) AS content_title,
            COUNT(DISTINCT user_id) AS unique_viewers,
            ROUND(SUM(watch_duration) / 3600, 1) AS total_hours,
            COUNT(*) AS total_sessions,
            ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes,
            COUNT(DISTINCT CONCAT(IFNULL(season_number, ''), '-', IFNULL(episode_number, ''))) AS episodes_watched
        FROM wrapped_viewing_data
        WHERE content_type = 'anime'
          AND watch_duration >= 300
        GROUP BY content_id
        ORDER BY unique_viewers DESC, total_hours DESC
        LIMIT 10
    `);

    const enriched = await Promise.all(rows.map(async (row, index) => {
        const tmdb = await fetchTMDBDetails(row.content_id, 'anime');
        return {
            rank: index + 1,
            contentId: row.content_id,
            title: tmdb?.title || row.content_title || `Anime #${row.content_id}`,
            posterPath: tmdb?.poster_path || null,
            backdropPath: tmdb?.backdrop_path || null,
            overview: tmdb?.overview || null,
            voteAverage: tmdb?.vote_average || null,
            genres: tmdb?.genres || [],
            releaseDate: tmdb?.release_date || null,
            uniqueViewers: parseInt(row.unique_viewers),
            totalHours: parseFloat(row.total_hours),
            totalSessions: parseInt(row.total_sessions),
            avgSessionMinutes: parseInt(row.avg_session_minutes),
            episodesWatched: parseInt(row.episodes_watched),
        };
    }));

    return { success: true, type: 'anime', top10: enriched, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Rafraîchissement en arrière-plan (stale-while-revalidate)
// ---------------------------------------------------------------------------

const builders = { movies: buildTop10Movies, tv: buildTop10Tv, anime: buildTop10Anime };

async function refreshTop10(category) {
    try {
        const builder = builders[category];
        if (!builder) return;
        const result = await builder();
        await cacheSet(category, result);
        console.log(`[Top10] Cache ${category} rafraîchi en arrière-plan`);
    } catch (err) {
        console.error(`[Top10] Erreur rafraîchissement ${category}:`, err.message);
    }
}

async function refreshStats(requestedType, typeConfig) {
    try {
        const cacheKey = requestedType ? `stats:${requestedType}` : 'stats';
        let statsQuery, statsParams;

        if (typeConfig) {
            statsQuery = `
                SELECT
                    COUNT(DISTINCT user_id) AS total_active_users,
                    COUNT(DISTINCT content_id) AS total_unique_content,
                    ROUND(SUM(watch_duration) / 3600, 0) AS total_hours_watched,
                    COUNT(*) AS total_sessions,
                    ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes,
                    MIN(created_at) AS data_from,
                    MAX(created_at) AS data_to
                FROM wrapped_viewing_data
                WHERE content_type = ?
                  AND watch_duration >= ?
            `;
            statsParams = [typeConfig.contentType, typeConfig.minDuration];
        } else {
            statsQuery = `
                SELECT
                    COUNT(DISTINCT user_id) AS total_active_users,
                    COUNT(DISTINCT content_id) AS total_unique_content,
                    ROUND(SUM(watch_duration) / 3600, 0) AS total_hours_watched,
                    COUNT(*) AS total_sessions,
                    ROUND(AVG(watch_duration) / 60, 0) AS avg_session_minutes,
                    MIN(created_at) AS data_from,
                    MAX(created_at) AS data_to
                FROM wrapped_viewing_data
                WHERE watch_duration >= ?
            `;
            statsParams = [300];
        }

        const [stats] = await pool.execute(statsQuery, statsParams);
        const result = {
            success: true,
            type: requestedType || 'global',
            stats: {
                totalActiveUsers: parseInt(stats[0].total_active_users) || 0,
                totalUniqueContent: parseInt(stats[0].total_unique_content) || 0,
                totalHoursWatched: parseInt(stats[0].total_hours_watched) || 0,
                totalSessions: parseInt(stats[0].total_sessions) || 0,
                avgSessionMinutes: parseInt(stats[0].avg_session_minutes) || 0,
                dataFrom: stats[0].data_from ? new Date(stats[0].data_from).toISOString() : null,
                dataTo: stats[0].data_to ? new Date(stats[0].data_to).toISOString() : null,
            },
            updatedAt: new Date().toISOString(),
        };
        await cacheSet(cacheKey, result);
        console.log(`[Top10] Cache stats ${cacheKey} rafraîchi en arrière-plan`);
    } catch (err) {
        console.error(`[Top10] Erreur rafraîchissement stats:`, err.message);
    }
}

module.exports = { router, initTop10Routes };
