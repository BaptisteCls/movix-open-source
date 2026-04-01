/**
 * Express application setup.
 * Extracted from server.js -- creates the app, mounts middleware and routes.
 * Does NOT start the server (that remains in server.js).
 */

const express = require('express');
const http = require('http');
const https = require('https');
const compression = require('compression');

// Middleware modules
const corsMiddleware = require('./middleware/cors');
const { securityHeaders, keepAliveHeaders, domainRestriction, jsonParseErrorHandler } = require('./middleware/security');

// Config
const { redis } = require('./config/redis');

// Utility modules
const {
  getFromCacheWithExpiration,
  getFromCacheNoExpiration,
  saveToCache,
  touchCacheEntry,
  shouldUpdateCache,
  shouldUpdateCacheFrenchStream,
  shouldUpdateCacheLecteurVideo,
  shouldUpdateCache24h,
  CACHE_DIR
} = require('./utils/cacheManager');

const { limitConcurrency3, limitConcurrency10 } = require('./utils/concurrency');

const {
  CPASMAL_BASE_URL,
  makeRequestWithCorsFallback
} = require('./utils/proxyManager');

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const axiosHelpers = require('./utils/axiosHelpers');

// === Darkino session & headers setup ===
const darkiHeaders = {
  'accept': 'application/json',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'fr-FR,fr;q=0.6',
  'cache-control': 'no-cache',
  'cookie': process.env.DARKIWORLD_COOKIES || '',
  'pragma': 'no-cache',
  'priority': 'u=1, i',
  'sec-ch-ua': '"Brave";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'sec-gpc': '1',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'x-xsrf-token': process.env.DARKIWORLD_XSRF_TOKEN || ''
};

const cookieJar = new tough.CookieJar();

// Pre-fill cookie jar with Darkino session cookies from env
if (process.env.DARKIWORLD_REMEMBER_TOKEN) {
  cookieJar.setCookieSync(`remember_web_3dc7a913ef5fd4b890ecabe3487085573e16cf82=${process.env.DARKIWORLD_REMEMBER_TOKEN}`, 'https://darkiworld2026.com');
}
cookieJar.setCookieSync('SERVERID=S1', 'https://darkiworld2026.com');
if (process.env.DARKIWORLD_XSRF_COOKIE) {
  cookieJar.setCookieSync(`XSRF-TOKEN=${process.env.DARKIWORLD_XSRF_COOKIE}`, 'https://darkiworld2026.com');
}
if (process.env.DARKIWORLD_SESSION) {
  cookieJar.setCookieSync(`darkiworld_session=${process.env.DARKIWORLD_SESSION}`, 'https://darkiworld2026.com');
}

// Periodic cleanup of Darkino cookie jar to prevent unbounded memory growth (every 30 min)
setInterval(() => {
  try {
    cookieJar.removeAllCookiesSync();
    // Re-add essential cookies from env
    if (process.env.DARKIWORLD_REMEMBER_TOKEN) {
      cookieJar.setCookieSync(`remember_web_3dc7a913ef5fd4b890ecabe3487085573e16cf82=${process.env.DARKIWORLD_REMEMBER_TOKEN}`, 'https://darkiworld2026.com');
    }
    cookieJar.setCookieSync('SERVERID=S1', 'https://darkiworld2026.com');
    if (process.env.DARKIWORLD_XSRF_COOKIE) {
      cookieJar.setCookieSync(`XSRF-TOKEN=${process.env.DARKIWORLD_XSRF_COOKIE}`, 'https://darkiworld2026.com');
    }
    if (process.env.DARKIWORLD_SESSION) {
      cookieJar.setCookieSync(`darkiworld_session=${process.env.DARKIWORLD_SESSION}`, 'https://darkiworld2026.com');
    }
  } catch (err) {
    console.error('[COOKIE JAR] Cleanup error:', err.message);
  }
}, 30 * 60 * 1000).unref();

// Coflix config
const COFLIX_BASE_URL = 'https://coflix.space';
const coflixHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Referer': 'https://coflix.space'
};

// === Axios instances for each source ===
const axiosCoflix = axios.create({
  baseURL: COFLIX_BASE_URL,
  timeout: 15000,
  headers: coflixHeaders,
  decompress: true
});

const axiosAnimeSama = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  },
  decompress: true
});

const FSTREAM_BASE_URL_VAL = 'https://french-stream.one/';
const axiosFStream = axios.create({
  baseURL: FSTREAM_BASE_URL_VAL,
  timeout: 6000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Sec-GPC': '1',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Brave";v="144"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Referer': 'https://french-stream.one/'
  },
  decompress: true
});

// Darkino session refresh
let lastDarkinoHomeRequest = 0;
const DARKINO_SESSION_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

const refreshDarkinoSessionIfNeeded = async () => {
  const now = Date.now();
  if (now - lastDarkinoHomeRequest > DARKINO_SESSION_REFRESH_INTERVAL) {
    try {
      await axiosHelpers.axiosDarkinoRequest({ method: 'get', url: '/' });
      lastDarkinoHomeRequest = now;
      console.log('[DARKINO] Session refreshed');
    } catch (error) {
      if (!error.response || (error.response.status !== 500 && error.response.status !== 403)) {
        console.error('[DARKINO] Failed to refresh session:', error.message);
      }
    }
  }
};

// Configure axiosHelpers with darkino session deps + axios instances
axiosHelpers.configure({
  darkiHeaders,
  cookieJar,
  coflixHeaders,
  COFLIX_BASE_URL,
  axiosCoflix,
  axiosAnimeSama,
  axiosFStream,
  ANIME_SAMA_URL: 'https://anime-sama.to/',
  FSTREAM_BASE_URL: FSTREAM_BASE_URL_VAL
});

// === Initialize global agent keep-alive with socket limits ===
http.globalAgent.keepAlive = true;
http.globalAgent.maxSockets = 128;      // Prevent unbounded socket accumulation
http.globalAgent.maxFreeSockets = 32;
https.globalAgent.keepAlive = true;
https.globalAgent.maxSockets = 128;
https.globalAgent.maxFreeSockets = 32;

// === Create Express app ===
const app = express();

// === Mount middleware in correct order ===

// 1. Enable gzip compression for all responses
app.use(compression({
  level: 1, // Balanced compression level (1-9, higher = more compression, slower)
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress if client doesn't accept it
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// 2. Cors Configuration (Restricted in production)
app.use(corsMiddleware);

// 3. Security headers (minimal set -- replaces Helmet)
app.use(securityHeaders);

// 4. Keep-Alive headers
app.use(keepAliveHeaders);

// 5. Domain restriction middleware
app.use(domainRestriction);

// 6. Body parsing
app.use(express.json({ limit: '30mb' })); // Reduced from 1000mb to prevent abuse

// 7. JSON parse error handler (must come right after json parser)
app.use(jsonParseErrorHandler);

app.use(express.urlencoded({ extended: true, limit: '5mb' })); // Reduced from 1000mb to prevent abuse

// ==========================================================================
// Configure route modules with dependencies from extracted utilities
// ==========================================================================

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const DARKINO_MAINTENANCE = false;
const DARKINOS_CACHE_DIR = require('path').join(__dirname, 'cache', 'darkinos');
const DOWNLOAD_CACHE_DIR = require('path').join(__dirname, 'cache', 'darkinodownloadlink');
const ANIME_SAMA_URL = 'https://anime-sama.to/';

// Shared deps object for common dependencies
const commonDeps = {
  TMDB_API_KEY,
  TMDB_API_URL,
  DARKINO_MAINTENANCE,
  DARKINOS_CACHE_DIR,
  getFromCacheNoExpiration,
  getFromCacheWithExpiration,
  saveToCache,
  shouldUpdateCache,
  shouldUpdateCacheFrenchStream,
  shouldUpdateCacheLecteurVideo,
  shouldUpdateCache24h,
  limitConcurrency3,
  axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest
};

// --- Configure cpasmal ---
const cpasmalRouter = require('./routes/cpasmal');
cpasmalRouter.configure({
  CPASMAL_BASE_URL,
  TMDB_API_URL,
  TMDB_API_KEY,
  axiosCpasmalRequest: require('./utils/proxyManager').axiosCpasmalRequest,
  DARKINO_PROXIES: require('./utils/proxyManager').DARKINO_PROXIES,
  getDarkinoHttpProxyAgent: require('./utils/proxyManager').getDarkinoHttpProxyAgent,
  getFromCacheNoExpiration,
  shouldUpdateCache
});

// --- Configure coflix (helper, not a router) ---
const coflix = require('./routes/coflix');
coflix.configure({
  axiosCoflixRequest: axiosHelpers.axiosCoflixRequest,
  axiosLecteurVideoRequest: axiosHelpers.axiosLecteurVideoRequest,
  makeCoflixRequest: require('./utils/proxyManager').makeCoflixRequest,
  coflixHeaders,
  getFromCacheNoExpiration,
  saveToCache,
  formatCoflixError: axiosHelpers.formatCoflixError
});

// --- Configure frenchstream (helper, not a router) ---
const frenchstream = require('./routes/frenchstream');
frenchstream.configure({
  makeRequestWithCorsFallback,
  axiosFrenchStreamRequest: axiosHelpers.axiosFrenchStreamRequest
  // findTvSeriesOnTMDB will be injected after tmdb is configured
});

// --- Configure animeSama ---
const animeSamaRouter = require('./routes/animeSama');
animeSamaRouter.configure({
  ANIME_SAMA_URL,
  axiosAnimeSama,
  axiosAnimeSamaRequest: axiosHelpers.axiosAnimeSamaRequest,
  getFromCacheNoExpiration,
  saveToCache,
  mergeStreamingLinks: axiosHelpers.mergeStreamingLinks,
  cleanupOldCacheFiles: axiosHelpers.cleanupOldCacheFiles,
  migrateOldCacheFiles: axiosHelpers.migrateOldCacheFiles,
  limitConcurrency10
});

// --- Configure tmdb ---
const tmdbRouter = require('./routes/tmdb');
tmdbRouter.configure({
  TMDB_API_KEY,
  TMDB_API_URL,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCacheFrenchStream,
  shouldUpdateCacheLecteurVideo,
  limitConcurrency3,
  // Coflix helpers
  searchCoflixByTitle: coflix.searchCoflixByTitle,
  getMovieDataFromCoflix: coflix.getMovieDataFromCoflix,
  getTvDataFromCoflix: coflix.getTvDataFromCoflix,
  filterEmmmmbedReaders: coflix.filterEmmmmbedReaders,
  // FrenchStream helpers
  getFrenchStreamMovie: frenchstream.getFrenchStreamMovie,
  getFrenchStreamSeries: frenchstream.getFrenchStreamSeries,
  getFrenchStreamSeriesDetails: frenchstream.getFrenchStreamSeriesDetails,
  extractSeriesInfo: frenchstream.extractSeriesInfo,
  mergeSeriesParts: frenchstream.mergeSeriesParts,
  cleanTvCacheData: frenchstream.cleanTvCacheData
});

// Now inject findTvSeriesOnTMDB back into frenchstream (circular dep)
frenchstream.configure({
  findTvSeriesOnTMDB: tmdbRouter.findTvSeriesOnTMDB
});

// --- Configure search ---
const searchRouter = require('./routes/search');
searchRouter.configure({
  DARKINO_MAINTENANCE,
  DARKINOS_CACHE_DIR,
  axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest,
  getFromCacheNoExpiration,
  saveToCache,
  touchCacheEntry,
  shouldUpdateCache
});

// --- Configure download ---
const downloadRouter = require('./routes/download');
downloadRouter.configure({
  DARKINO_MAINTENANCE,
  DARKINOS_CACHE_DIR,
  darkiHeaders,
  darkiworld_premium: false,
  axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCache,
  refreshDarkinoSessionIfNeeded
});

// --- Configure darkiworld ---
const darkiworldRouter = require('./routes/darkiworld');
darkiworldRouter.configure({
  DARKINO_MAINTENANCE,
  DOWNLOAD_CACHE_DIR,
  darkiHeaders,
  axiosDarkinoRequest: axiosHelpers.axiosDarkinoRequest,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCache,
  shouldUpdateCache24h,
  refreshDarkinoSessionIfNeeded
});

// --- Configure voirdrama ---
const voirdramaRouter = require('./routes/voirdrama');
voirdramaRouter.configure({
  TMDB_API_KEY,
  TMDB_API_URL,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCache24h
});

// --- Configure francetv ---
const francetvRouter = require('./routes/francetv');
francetvRouter.configure({
  getFromCacheWithExpiration,
  saveToCache
});

const {
  router: vipDonationsRouter,
  ensureVipDonationsTables
} = require('./routes/vipDonations');

// ==========================================================================
// Mount all route modules
// ==========================================================================

// Pre-existing routes (already extracted before this modularization)
app.use('/api/comments', require('./commentsRoutes'));
app.use('/api/likes', require('./likesRoutes'));
app.use('/api/shared-lists', require('./sharedListsRoutes'));
app.use('/api/livetv', require('./liveTvRoutes'));

// New modular routes
app.use('/api/cpasmal', cpasmalRouter);
app.use('/anime', animeSamaRouter);
app.use('/api', tmdbRouter);
app.use('/', searchRouter);
app.use('/api', downloadRouter);
app.use('/api/fstream', require('./routes/fstream'));
app.use('/api/wiflix', require('./routes/wiflix'));
app.use('/api', require('./routes/sync'));
app.use('/api/profiles', require('./routes/profiles'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api', require('./routes/debrid'));
app.use('/proxy', require('./routes/proxy'));
app.use('/api', require('./routes/admin'));
app.use('/api', vipDonationsRouter);
app.use('/api/darkiworld', darkiworldRouter);
app.use('/api/drama', voirdramaRouter);
app.use('/api/ftv', francetvRouter);
const purstreamRouter = require('./routes/purstream');
purstreamRouter.configure({
  TMDB_API_KEY,
  TMDB_API_URL,
  PROXY_SERVER_URL: process.env.PROXY_SERVER_URL,
  verifyAccessKey: require('./checkVip').verifyAccessKey,
  getFromCacheNoExpiration,
  saveToCache,
  shouldUpdateCache
});
app.use('/api/purstream', purstreamRouter);

// ==========================================================================
// MySQL pool initialization — pool unique via mysqlPool.js
// ==========================================================================

const { initPool, getPool } = require('./mysqlPool');
const { ensureAccountLinksStorage } = require('./utils/accountLinks');
const { ensureCloneLinksStorage } = require('./utils/cloneLinks');

(async () => {
  try {
    const pool = await initPool();
    console.log('MySQL unified pool initialized successfully');

    // Créer la table user_sessions si elle n'existe pas
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        user_type ENUM('oauth', 'bip39') NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_sessions_user (user_id, user_type),
        INDEX idx_user_sessions_accessed (accessed_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Table user_sessions initialized successfully');

    await ensureAccountLinksStorage();
    console.log('Table account_links initialized successfully');

    await ensureCloneLinksStorage();
    console.log('Table clone_links initialized successfully');

    await ensureVipDonationsTables(pool);
    console.log('VIP donations tables initialized successfully');

    // Initialize Wishboard routes
    const { createWishboardRouter } = require('./wishboardRoutes');
    const wishboardRouter = createWishboardRouter(pool, redis);
    app.use('/api/wishboard', wishboardRouter);
    app.use('/api/admin/wishboard', wishboardRouter);
    console.log('Wishboard routes initialized successfully');

    // Initialize Link Submissions routes (user-submitted streaming links)
    const { createLinkSubmissionsRouter } = require('./linkSubmissionsRoutes');
    const linkSubmissionsRouter = createLinkSubmissionsRouter(pool, redis);
    app.use('/api/link-submissions', linkSubmissionsRouter);
    // Create link_submissions table if not exists
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS link_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        profile_id VARCHAR(255) NOT NULL,
        tmdb_id INT NOT NULL,
        media_type ENUM('movie', 'tv') NOT NULL,
        season_number INT DEFAULT NULL,
        episode_number INT DEFAULT NULL,
        url VARCHAR(2048) NOT NULL,
        source_name VARCHAR(100) DEFAULT NULL,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        rejection_reason TEXT DEFAULT NULL,
        reviewed_by VARCHAR(255) DEFAULT NULL,
        reviewed_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ls_status (status),
        INDEX idx_ls_profile (profile_id),
        INDEX idx_ls_tmdb (tmdb_id, media_type),
        INDEX idx_ls_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Link Submissions routes initialized successfully');

    // Initialize Top 10 routes (public ranking)
    const { router: top10Router, initTop10Routes } = require('./top10Routes');
    initTop10Routes(pool, redis);
    app.use('/api/top10', top10Router);
    console.log('Top 10 routes initialized successfully');

    // Initialize Wrapped routes (Movix Wrapped 2026 data collection)
    const { router: wrappedRouter, initWrappedRoutes, initTables: initWrappedTables } = require('./wrappedRoutes');
    initWrappedRoutes(pool, redis);
    await initWrappedTables();
    app.use('/api/wrapped', wrappedRouter);
    console.log('Wrapped routes initialized successfully');
  } catch (error) {
    console.error('MySQL connection error:', error.message);
  }
})();

// === Pool getter for other modules ===
function getAppPool() {
  return getPool();
}

// === Unified error handler ===
app.use((err, req, res, next) => {
  if (err.message !== 'Not allowed by CORS') {
    console.error('Erreur globale:', err);
  }
  res.status(500).json({
    error: 'Erreur serveur interne',
    message: err.message,
    path: req.path
  });
});

module.exports = { app, getAppPool };
