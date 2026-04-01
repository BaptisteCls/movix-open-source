/**
 * Dragiv routes module.
 * Extracted from server.js -- handles Dragiv movie source search and retrieval
 * (films only).
 *
 * Mounted at /api/dragiv  (paths below are relative to that prefix).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const axios = require('axios');
const { CACHE_DIR, generateCacheKey } = require('../utils/cacheManager');
const { redis } = require('../config/redis');
const { fetchTmdbDetails } = require('../utils/tmdbCache');

// === DRAGIV CONFIGURATION ===
const DRAGIV_BASE = 'https://kimpav.com';
const DRAGIV_KEY = 'ph4p9rv4jpx7mg';

// Deduplication des requêtes Dragiv en cours
const ongoingDragivRequests = new Map();
const DRAGIV_REQUEST_TIMEOUT = 30000; // 30s timeout par requête
const DRAGIV_STALE_CLEANUP_MS = 10 * 60 * 1000; // 10 min max pour une entrée

const getOrCreateDragivRequest = async (cacheKey, requestFunction) => {
  if (ongoingDragivRequests.has(cacheKey)) {
    const existing = ongoingDragivRequests.get(cacheKey);
    let dedupTimer;
    return Promise.race([
      existing.promise.finally(() => clearTimeout(dedupTimer)),
      new Promise((_, reject) => { dedupTimer = setTimeout(() => reject(new Error('Dragiv dedup timeout')), DRAGIV_REQUEST_TIMEOUT); })
    ]);
  }

  const requestPromise = (async () => {
    let timeoutTimer;
    try {
      return await Promise.race([
        requestFunction().finally(() => clearTimeout(timeoutTimer)),
        new Promise((_, reject) => { timeoutTimer = setTimeout(() => reject(new Error('Dragiv request timeout')), DRAGIV_REQUEST_TIMEOUT); })
      ]);
    } finally {
      clearTimeout(timeoutTimer);
      ongoingDragivRequests.delete(cacheKey);
    }
  })();

  ongoingDragivRequests.set(cacheKey, { promise: requestPromise, createdAt: Date.now() });
  return requestPromise;
};

// Nettoyage périodique des requêtes Dragiv bloquées
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of ongoingDragivRequests) {
    if (now - entry.createdAt > DRAGIV_STALE_CLEANUP_MS) {
      ongoingDragivRequests.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[DRAGIV DEDUP] Nettoyage: ${cleaned} requêtes expirées supprimées`);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let getFromCacheNoExpiration;

/**
 * Inject runtime dependencies that still live in server.js.
 */
function configure(deps) {
  if (deps.getFromCacheNoExpiration) getFromCacheNoExpiration = deps.getFromCacheNoExpiration;
}

// ---------------------------------------------------------------------------
// parseDragivMovieList -- parse movie entries from Dragiv HTML
// ---------------------------------------------------------------------------
function parseDragivMovieList(html) {
  // Le HTML est structuré : <a href="/key/b/kimpav/ID">\n\n    Titre (Année) <font...>HD</font>\n</a>
  const movieRegex = /href="(\/ph4p9rv4jpx7mg\/b\/kimpav\/(\d+))"[^>]*>\s*([\s\S]*?)<\/a>/g;
  const matches = [...html.matchAll(movieRegex)];

  const movies = [];
  const seen = new Set();

  for (const match of matches) {
    const moviePath = match[1];
    const movieId = match[2];
    // Nettoyer le titre : retirer les balises HTML et les espaces superflus
    const rawTitle = match[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    if (!seen.has(movieId) && rawTitle.length > 0) {
      seen.add(movieId);
      movies.push({
        id: movieId,
        title: rawTitle,
        url: `${DRAGIV_BASE}${moviePath}`,
        path: moviePath
      });
    }
  }

  return movies;
}

// ---------------------------------------------------------------------------
// searchDragivMovies -- search movies on Dragiv via POST
// ---------------------------------------------------------------------------
async function searchDragivMovies(query) {
  const homeUrl = `${DRAGIV_BASE}/${DRAGIV_KEY}/home/kimpav`;

  const response = await axios.post(homeUrl, `searchword=${encodeURIComponent(query)}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': homeUrl,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': 'g=true'
    },
    maxRedirects: 5,
    timeout: 15000
  });

  return parseDragivMovieList(response.data);
}

// ---------------------------------------------------------------------------
// fetchDragivHomeMovies -- retrieve movie list from Dragiv homepage (fallback)
// ---------------------------------------------------------------------------
async function fetchDragivHomeMovies() {
  const homeUrl = `${DRAGIV_BASE}/${DRAGIV_KEY}/home/kimpav`;

  const response = await axios.get(homeUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': DRAGIV_BASE,
      'Cookie': 'g=true'
    },
    timeout: 15000
  });

  return parseDragivMovieList(response.data);
}

// ---------------------------------------------------------------------------
// fetchDragivMovieData -- retrieve sources for a Dragiv movie by internal ID
// ---------------------------------------------------------------------------
async function fetchDragivMovieData(movieId) {
  const movieUrl = `${DRAGIV_BASE}/${DRAGIV_KEY}/b/kimpav/${movieId}`;

  const response = await axios.get(movieUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `${DRAGIV_BASE}/${DRAGIV_KEY}/home/kimpav`,
      'Cookie': 'g=true'
    },
    timeout: 15000
  });

  const html = response.data;

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/^(Dragiv|Kimpav)\s*-\s*/i, '').trim() : 'Unknown';

  const iframeMatch = html.match(/<iframe[^>]+src="(https:\/\/sharecloudy\.com\/[^"]+)"/i);
  if (!iframeMatch) {
    return { success: false, error: 'No iframe found', id: movieId, title };
  }

  const iframeUrl = iframeMatch[1];

  const iframeResponse = await axios.get(iframeUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': movieUrl
    },
    timeout: 15000
  });

  const iframeHtml = iframeResponse.data;

  const m3u8Match = iframeHtml.match(/file:\s*"(https:\/\/[^"]+\.m3u8[^"]*)"/i);
  if (!m3u8Match) {
    return { success: false, error: 'No m3u8 found in iframe', id: movieId, title, iframeUrl };
  }

  const m3u8Url = m3u8Match[1];

  // Extraire les qualités disponibles
  const qualityRegex = /{\s*file:\s*"([^"]+\.m3u8[^"]*)"\s*,\s*label:\s*"([^"]+)"/g;
  const qualityMatches = [...iframeHtml.matchAll(qualityRegex)];

  const qualities = qualityMatches.length > 0
    ? qualityMatches.map(m => ({ url: m[1], quality: m[2] }))
    : [{ url: m3u8Url, quality: 'HD' }];

  return {
    success: true,
    id: movieId,
    title,
    movieUrl,
    iframeUrl,
    m3u8: m3u8Url,
    qualities,
    provider: 'sharecloudy.com',
    referer: iframeUrl,
    note: 'Le m3u8 nécessite le header Referer pour fonctionner'
  };
}

// ---------------------------------------------------------------------------
// calculateDragivMatchScore -- compute title match score using Jaccard similarity
// ---------------------------------------------------------------------------
function calculateDragivMatchScore(dragivTitle, searchTitle, tmdbTitle, tmdbOriginalTitle) {
  // Retirer les tags de qualité/statut des titres Dragiv (HD, VOSTFR, NEW, etc.)
  const cleanTags = (str) => str
    .replace(/\b(HD|VOSTFR|VF|NEW|CAM|TS|TC|DVDRIP|BDRIP|WEBRIP|HDTV)\b/gi, '')
    .replace(/\+\d+/g, '')
    .trim();

  const normalize = (str) => cleanTags(str).toLowerCase()
    .replace(/[:\-–—'"]/g, ' ')
    .replace(/[^\w\s\u00C0-\u024F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const removeYear = (str) => str.replace(/\(?\d{4}\)?/g, '').replace(/\s+/g, ' ').trim();
  // Ne pas traiter les années (4 chiffres >= 1900) comme des tokens de suite
  const isYear = (token) => /^\d{4}$/.test(token) && parseInt(token) >= 1900;
  const sequelTokenRegex = /^(\d+|i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i;
  const getSequelTokens = (str) => {
    if (!str) return new Set();
    return new Set(
      str
        .split(' ')
        .map(token => token.trim().toLowerCase())
        .filter(token => sequelTokenRegex.test(token) && !isYear(token))
    );
  };
  const hasSequelMismatch = (candidateTitleOnly, referenceTitleOnly) => {
    const candidateTokens = getSequelTokens(candidateTitleOnly);
    const referenceTokens = getSequelTokens(referenceTitleOnly);

    if (candidateTokens.size === 0 && referenceTokens.size === 0) return false;
    if (candidateTokens.size === 0 || referenceTokens.size === 0) return true;

    for (const token of candidateTokens) {
      if (referenceTokens.has(token)) return false;
    }
    return true;
  };

  const dragivNorm = normalize(dragivTitle);
  const searchNorm = normalize(searchTitle);
  const tmdbNorm = normalize(tmdbTitle);
  const tmdbOrigNorm = normalize(tmdbOriginalTitle || '');

  const dragivTitleOnly = removeYear(dragivNorm);
  const tmdbTitleOnly = removeYear(tmdbNorm);
  const tmdbOrigTitleOnly = removeYear(tmdbOrigNorm);

  // Bloque les faux positifs de suites: ex. "Zootopie" vs "Zootopie 2"
  const mismatchWithTmdb = hasSequelMismatch(dragivTitleOnly, tmdbTitleOnly);
  const mismatchWithTmdbOriginal = tmdbOrigTitleOnly.length > 0
    ? hasSequelMismatch(dragivTitleOnly, tmdbOrigTitleOnly)
    : true;

  if (mismatchWithTmdb && mismatchWithTmdbOriginal) return 0;

  // Match exact (titre complet ou sans année)
  if (dragivNorm === searchNorm || dragivNorm === tmdbNorm) return 1.0;
  if (tmdbOrigNorm.length > 0 && dragivNorm === tmdbOrigNorm) return 1.0;
  if (dragivTitleOnly.length > 0 && tmdbTitleOnly.length > 0 && dragivTitleOnly === tmdbTitleOnly) return 1.0;
  if (tmdbOrigTitleOnly.length > 0 && dragivTitleOnly === tmdbOrigTitleOnly) return 1.0;

  // Jaccard similarity sur les mots (plus robuste que substring includes)
  const getWords = (str) => {
    const words = str.split(' ').filter(w => w.length > 1);
    return new Set(words);
  };

  const jaccard = (setA, setB) => {
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersectionSize = 0;
    for (const item of setA) {
      if (setB.has(item)) intersectionSize++;
    }
    const unionSize = new Set([...setA, ...setB]).size;
    return intersectionSize / unionSize;
  };

  const dragivWords = getWords(dragivTitleOnly);
  const tmdbWords = getWords(tmdbTitleOnly);
  const tmdbOrigWords = tmdbOrigTitleOnly.length > 0 ? getWords(tmdbOrigTitleOnly) : new Set();

  let score = Math.max(
    jaccard(dragivWords, tmdbWords),
    tmdbOrigWords.size > 0 ? jaccard(dragivWords, tmdbOrigWords) : 0
  );

  // Bonus année uniquement si le titre a déjà un bon score
  if (score >= 0.5) {
    const yearMatch = dragivTitle.match(/\((\d{4})\)/);
    const searchYearMatch = searchTitle.match(/\((\d{4})\)/);
    if (yearMatch && searchYearMatch && yearMatch[1] === searchYearMatch[1]) {
      score = Math.min(score + 0.1, 1.0);
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// fetchDragivByTmdbId -- search Dragiv for a movie by TMDB ID
// ---------------------------------------------------------------------------
async function fetchDragivByTmdbId(tmdbId) {
  try {
    // 1. Récupérer les infos TMDB (cached via Redis)
    const tmdbMovie = await fetchTmdbDetails('https://api.themoviedb.org/3', process.env.TMDB_API_KEY, tmdbId, 'movie', 'fr-FR');

    if (!tmdbMovie || !tmdbMovie.title) {
      return { success: false, error: 'TMDB movie not found', tmdb_id: tmdbId };
    }

    const year = tmdbMovie.release_date ? tmdbMovie.release_date.split('-')[0] : null;
    const searchTitle = year ? `${tmdbMovie.title} (${year})` : tmdbMovie.title;

    // 2. Rechercher sur Dragiv par nom complet du film (POST search)
    let allMovies = await searchDragivMovies(tmdbMovie.title);

    // Fallback: si la recherche ne retourne rien, essayer avec le titre original
    if (allMovies.length === 0 && tmdbMovie.original_title && tmdbMovie.original_title !== tmdbMovie.title) {
      allMovies = await searchDragivMovies(tmdbMovie.original_title);
    }

    // Fallback ultime: homepage
    if (allMovies.length === 0) {
      allMovies = await fetchDragivHomeMovies();
    }

    // 3. Trouver le meilleur match
    let bestMatch = null;
    let bestScore = 0;

    for (const movie of allMovies) {
      const score = calculateDragivMatchScore(movie.title, searchTitle, tmdbMovie.title, tmdbMovie.original_title);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = movie;
      }
    }

    // 4. Si trouvé avec un bon score, récupérer les sources (seuil strict pour éviter faux positifs)
    if (bestMatch && bestScore >= 0.8) {
      const movieData = await fetchDragivMovieData(bestMatch.id);

      // Vérification post-fetch : le titre de la page Dragiv doit aussi correspondre au film TMDB
      if (movieData.success && movieData.title) {
        const postFetchScore = calculateDragivMatchScore(movieData.title, searchTitle, tmdbMovie.title, tmdbMovie.original_title);
        if (postFetchScore < 0.5) {
          return {
            success: false,
            error: 'Movie not found on Dragiv (post-fetch title mismatch)',
            tmdb_id: parseInt(tmdbId),
            searched_title: searchTitle,
            best_match: { title: bestMatch.title, score: bestScore },
            page_title: movieData.title,
            page_score: postFetchScore
          };
        }
      }

      if (movieData.success) {
        return {
          success: true,
          tmdb_id: parseInt(tmdbId),
          tmdb: {
            id: tmdbMovie.id,
            title: tmdbMovie.title,
            original_title: tmdbMovie.original_title,
            overview: tmdbMovie.overview,
            release_date: tmdbMovie.release_date,
            vote_average: tmdbMovie.vote_average,
            poster_path: tmdbMovie.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbMovie.poster_path}` : null,
            backdrop_path: tmdbMovie.backdrop_path ? `https://image.tmdb.org/t/p/original${tmdbMovie.backdrop_path}` : null,
            genres: tmdbMovie.genres || [],
            runtime: tmdbMovie.runtime
          },
          dragiv: {
            id: movieData.id,
            title: movieData.title,
            movieUrl: movieData.movieUrl,
            iframeUrl: movieData.iframeUrl,
            m3u8: movieData.m3u8,
            qualities: movieData.qualities,
            provider: movieData.provider,
            referer: movieData.referer
          },
          match_score: bestScore,
          source: 'dragiv'
        };
      }
    }

    // 5. Pas trouvé
    return {
      success: false,
      error: 'Movie not found on Dragiv',
      tmdb_id: parseInt(tmdbId),
      searched_title: searchTitle,
      best_match: bestMatch ? { title: bestMatch.title, score: bestScore } : null
    };

  } catch (error) {
    return { success: false, error: error.message, tmdb_id: tmdbId };
  }
}

// ---------------------------------------------------------------------------
// updateDragivCache -- background cache update
// ---------------------------------------------------------------------------
async function updateDragivCache(cacheKey, tmdbid) {
  try {
    const newData = await fetchDragivByTmdbId(tmdbid);
    if (newData && newData.success) {
      await fsp.writeFile(path.join(CACHE_DIR.DRAGIV, `${cacheKey}.json`), JSON.stringify(newData), 'utf-8');
      // cache updated
    }
  } catch (error) {
    // Ne pas toucher au cache existant en cas d'erreur
  }
}

// ---------------------------------------------------------------------------
// GET /movie/:tmdbid
// Chercher un film Dragiv par TMDB ID
// ---------------------------------------------------------------------------
router.get('/movie/:tmdbid', async (req, res) => {
  const { tmdbid } = req.params;
  const cacheKey = generateCacheKey(`dragiv_movie_${tmdbid}`);

  try {
    // 1. Try cache
    const cachedData = await getFromCacheNoExpiration(CACHE_DIR.DRAGIV, cacheKey);
    if (cachedData) {
      if (cachedData.notFound) {
        res.status(404).json({ error: 'Movie not found on Dragiv (Cached)' });
      } else {
        res.json(cachedData);
      }

      // Background update si ancien (20 min)
      const cacheFilePath = path.join(CACHE_DIR.DRAGIV, `${cacheKey}.json`);
      try {
        const stats = await fsp.stat(cacheFilePath);
        const age = Date.now() - stats.mtime.getTime();
        if (age > 20 * 60 * 1000) {
          updateDragivCache(cacheKey, tmdbid).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return;
    }

    // 2. Fetch fresh avec deduplication
    const data = await getOrCreateDragivRequest(cacheKey, () => fetchDragivByTmdbId(tmdbid));

    if (!data || !data.success) {
      const notFoundData = { notFound: true, tmdbId: tmdbid, timestamp: Date.now() };
      await fsp.writeFile(path.join(CACHE_DIR.DRAGIV, `${cacheKey}.json`), JSON.stringify(notFoundData), 'utf-8');
      return res.status(404).json({ error: 'Movie not found on Dragiv' });
    }

    await fsp.writeFile(path.join(CACHE_DIR.DRAGIV, `${cacheKey}.json`), JSON.stringify(data), 'utf-8');
    res.json(data);

  } catch (error) {
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// GET /movie/:tmdbid/clear-cache
// Vider le cache Dragiv d'un film
// ---------------------------------------------------------------------------
router.get('/movie/:tmdbid/clear-cache', async (req, res) => {
  const { tmdbid } = req.params;
  const cacheKey = generateCacheKey(`dragiv_movie_${tmdbid}`);
  const cacheFilePath = path.join(CACHE_DIR.DRAGIV, `${cacheKey}.json`);

  try {
    // Supprimer le fichier JSON + la clé Redis
    const memKey = `${CACHE_DIR.DRAGIV}:${cacheKey}`;
    await Promise.allSettled([
      fsp.unlink(cacheFilePath),
      redis.del(memKey)
    ]);
    res.json({ success: true, message: `Cache cleared for movie ${tmdbid}` });
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DRAGIV source loaded (films only)

module.exports = router;
module.exports.configure = configure;
module.exports.searchDragivMovies = searchDragivMovies;
module.exports.fetchDragivHomeMovies = fetchDragivHomeMovies;
module.exports.fetchDragivMovieData = fetchDragivMovieData;
module.exports.calculateDragivMatchScore = calculateDragivMatchScore;
module.exports.fetchDragivByTmdbId = fetchDragivByTmdbId;
module.exports.updateDragivCache = updateDragivCache;
