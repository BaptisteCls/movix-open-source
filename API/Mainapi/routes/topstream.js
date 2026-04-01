/**
 * Top-Stream routes module.
 * Scrapes top-stream.plus for movie/series search and embed extraction.
 *
 * Mounted at /api/topstream  (paths below are relative to that prefix).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const axios = require('axios');
const cheerio = require('cheerio');
const { generateCacheKey } = require('../utils/cacheManager');
const { fetchTmdbDetails } = require('../utils/tmdbCache');

const TOPSTREAM_BASE_URL = 'https://top-stream.plus';
const BYPASS403_SERVER_URL = process.env.BYPASS403_SERVER_URL || '';

const topstreamHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': TOPSTREAM_BASE_URL,
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1'
};

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let TMDB_API_KEY;
let TMDB_API_URL;
let getFromCacheNoExpiration;
let saveToCache;
let shouldUpdateCache24h;

function configure(deps) {
  if (deps.TMDB_API_KEY) TMDB_API_KEY = deps.TMDB_API_KEY;
  if (deps.TMDB_API_URL) TMDB_API_URL = deps.TMDB_API_URL;
  if (deps.getFromCacheNoExpiration) getFromCacheNoExpiration = deps.getFromCacheNoExpiration;
  if (deps.saveToCache) saveToCache = deps.saveToCache;
  if (deps.shouldUpdateCache24h) shouldUpdateCache24h = deps.shouldUpdateCache24h;
}

// ---------------------------------------------------------------------------
// Helper: build proxied embed URL
// ---------------------------------------------------------------------------
function proxyEmbedUrl(originalLink) {
  const topstreamMatch = originalLink.match(/https?:\/\/(?:www\.)?top-stream\.plus(\/embed\/\d+)/);
  if (topstreamMatch && BYPASS403_SERVER_URL) {
    return `${BYPASS403_SERVER_URL}/proxy/https://top-stream.plus${topstreamMatch[1]}`;
  }
  return originalLink;
}

// ---------------------------------------------------------------------------
// Helper: fetch a page from top-stream
// ---------------------------------------------------------------------------
async function fetchPage(url) {
  const response = await axios.get(url, {
    headers: topstreamHeaders,
    timeout: 15000,
    decompress: true
  });
  if (response.status === 403) {
    console.error('[TOPSTREAM] 403 Forbidden:', url);
  }
  return response.data;
}

// ---------------------------------------------------------------------------
// Helper: resolve TMDB ID to title
// ---------------------------------------------------------------------------
async function getTmdbTitle(tmdbId, mediaType) {
  const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
  const data = await fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, tmdbId, endpoint, 'fr-FR');
  if (!data) return { title: '', originalTitle: '', year: '' };
  const title = data.title || data.name || '';
  const originalTitle = data.original_title || data.original_name || '';
  const year = (data.release_date || data.first_air_date || '').substring(0, 4);
  return { title, originalTitle, year };
}

// ---------------------------------------------------------------------------
// searchTopStream -- search for movies/series
// ---------------------------------------------------------------------------
async function searchTopStream(query) {
  const searchUrl = `${TOPSTREAM_BASE_URL}/search/${encodeURIComponent(query)}`;
  const html = await fetchPage(searchUrl);
  const $ = cheerio.load(html);

  const results = [];

  $('div.relative.group.overflow-hidden').each((_, el) => {
    const card = $(el);
    const link = card.find('a').first();
    const href = link.attr('href') || '';

    let type = 'movie';
    let slug = '';
    if (href.includes('/movie/')) {
      type = 'movie';
      slug = href.split('/movie/').pop();
    } else if (href.includes('/tv-show/')) {
      type = 'tv';
      slug = href.split('/tv-show/').pop();
    } else {
      return;
    }

    const img = card.find('img').first();
    const image = img.attr('src') || img.attr('data-src') || '';
    const title = img.attr('alt') || '';

    const ratingEl = card.find('.absolute.right-3.top-3 span.text-xs');
    const rating = ratingEl.text().trim() || null;

    const infoDiv = card.find('.pt-4');
    const allSpans = infoDiv.find('span');

    let duration = null;
    let year = null;
    let genre = null;
    let typeLabel = null;

    allSpans.each((_, span) => {
      const text = $(span).text().trim();
      if (text.match(/\d+h\d+|min/)) {
        duration = text;
      } else if (text.match(/^\d{4}$/)) {
        year = parseInt(text);
      } else if ($(span).hasClass('text-xxs')) {
        typeLabel = text;
      } else if (!duration && !year && text.length > 0) {
        if (!genre) genre = text;
      }
    });

    const h3Title = infoDiv.find('h3').text().trim() || title;

    results.push({
      title: h3Title,
      slug,
      type,
      image,
      rating: rating ? parseFloat(rating) : null,
      year,
      duration,
      genre,
      typeLabel
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// getTopStreamEmbed -- extract embed URL from movie or episode page
// ---------------------------------------------------------------------------
async function getTopStreamEmbed(pageUrl) {
  const html = await fetchPage(pageUrl);
  const $ = cheerio.load(html);

  const videos = [];
  let watchComponentFound = false;
  let cover = null;

  $('*').each((_, el) => {
    if (watchComponentFound) return;
    const snapshot = $(el).attr('wire:snapshot');
    if (!snapshot) return;

    try {
      const data = JSON.parse(snapshot);
      if (data.memo && data.memo.name === 'watch-component') {
        watchComponentFound = true;
        cover = data.data?.cover || null;

        const videosData = data.data?.videos;
        if (Array.isArray(videosData)) {
          const extractLinks = (obj) => {
            if (!obj) return;
            if (Array.isArray(obj)) {
              obj.forEach(item => extractLinks(item));
            } else if (typeof obj === 'object' && obj.link) {
              videos.push({
                label: obj.label || 'Stream',
                type: obj.type || 'mp4',
                link: proxyEmbedUrl(obj.link)
              });
            }
          };
          extractLinks(videosData);
        }
      }
    } catch (err) {
      // skip
    }
  });

  return { videos, cover };
}

// ---------------------------------------------------------------------------
// findAndGetEmbed -- search TopStream by title, find best match, get embed
// ---------------------------------------------------------------------------
async function findAndGetEmbed(tmdbId, mediaType, season, episode) {
  const { title, originalTitle, year } = await getTmdbTitle(tmdbId, mediaType);
  if (!title && !originalTitle) return null;

  const searchType = mediaType === 'tv' ? 'tv' : 'movie';
  let results = await searchTopStream(title);
  let matchResults = results.filter(r => r.type === searchType);

  if (matchResults.length === 0 && originalTitle && originalTitle !== title) {
    results = await searchTopStream(originalTitle);
    matchResults = results.filter(r => r.type === searchType);
  }

  if (matchResults.length === 0) return null;

  let bestMatch = matchResults[0];
  if (year) {
    const yearNum = parseInt(year);
    const yearMatch = matchResults.find(r => r.year === yearNum);
    if (yearMatch) bestMatch = yearMatch;
  }

  let pageUrl;
  if (mediaType === 'tv') {
    pageUrl = `${TOPSTREAM_BASE_URL}/episode/${bestMatch.slug}/${season}-${episode}`;
  } else {
    pageUrl = `${TOPSTREAM_BASE_URL}/movie/${bestMatch.slug}`;
  }

  const embedResult = await getTopStreamEmbed(pageUrl);
  return {
    ...embedResult,
    slug: bestMatch.slug,
    matchedTitle: bestMatch.title,
    matchedYear: bestMatch.year
  };
}

// ---------------------------------------------------------------------------
// GET /film/:tmdbId
// ---------------------------------------------------------------------------
router.get('/film/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const cacheKey = generateCacheKey(`topstream_film_${tmdbId}`);
  const cacheDir = path.join(__dirname, '..', 'cache', 'topstream');

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    if (cachedData) {
      res.json(cachedData);
      const shouldUpdate = await shouldUpdateCache24h(cacheDir, cacheKey);
      if (shouldUpdate) {
        (async () => {
          try {
            const result = await findAndGetEmbed(tmdbId, 'movie');
            if (result) {
              await saveToCache(cacheDir, cacheKey, { success: true, tmdbId, type: 'movie', ...result });
            }
          } catch (err) {
            if (err.response?.status === 403) console.error('[TOPSTREAM] 403 background film update:', tmdbId);
          }
        })();
      }
      return;
    }

    const result = await findAndGetEmbed(tmdbId, 'movie');

    if (!result || result.videos.length === 0) {
      const data = { success: false, tmdbId, error: 'Film non trouvé sur TopStream' };
      await saveToCache(cacheDir, cacheKey, data);
      return res.status(404).json(data);
    }

    const data = { success: true, tmdbId, type: 'movie', ...result };
    await saveToCache(cacheDir, cacheKey, data);
    res.json(data);

  } catch (error) {
    if (error.response?.status === 403) console.error('[TOPSTREAM] 403 Forbidden film:', tmdbId);
    else console.error('[TOPSTREAM] Film error:', tmdbId, error.message);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération du film', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /tv/:tmdbId?season=X&episode=Y
// ---------------------------------------------------------------------------
router.get('/tv/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const season = parseInt(req.query.season);
  const episode = parseInt(req.query.episode);

  if (!season || !episode) {
    return res.status(400).json({ success: false, error: 'Les paramètres ?season= et ?episode= sont requis.' });
  }

  const cacheKey = generateCacheKey(`topstream_tv_${tmdbId}_${season}_${episode}`);
  const cacheDir = path.join(__dirname, '..', 'cache', 'topstream');

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    if (cachedData) {
      res.json(cachedData);
      const shouldUpdate = await shouldUpdateCache24h(cacheDir, cacheKey);
      if (shouldUpdate) {
        (async () => {
          try {
            const result = await findAndGetEmbed(tmdbId, 'tv', season, episode);
            if (result) {
              await saveToCache(cacheDir, cacheKey, { success: true, tmdbId, type: 'tv', season, episode, ...result });
            }
          } catch (err) {
            if (err.response?.status === 403) console.error('[TOPSTREAM] 403 background TV update:', tmdbId, 'S' + season + 'E' + episode);
          }
        })();
      }
      return;
    }

    const result = await findAndGetEmbed(tmdbId, 'tv', season, episode);

    if (!result || result.videos.length === 0) {
      const data = { success: false, tmdbId, season, episode, error: 'Épisode non trouvé sur TopStream' };
      await saveToCache(cacheDir, cacheKey, data);
      return res.status(404).json(data);
    }

    const data = { success: true, tmdbId, type: 'tv', season, episode, ...result };
    await saveToCache(cacheDir, cacheKey, data);
    res.json(data);

  } catch (error) {
    if (error.response?.status === 403) console.error('[TOPSTREAM] 403 Forbidden TV:', tmdbId, 'S' + season + 'E' + episode);
    else console.error('[TOPSTREAM] TV error:', tmdbId, error.message);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération de l\'épisode', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /search?q=... (conservé pour usage direct)
// ---------------------------------------------------------------------------
router.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ success: false, error: 'Le paramètre ?q= est requis.' });
  }

  const cacheKey = generateCacheKey(`topstream_search_${query.toLowerCase().trim()}`);
  const cacheDir = path.join(__dirname, '..', 'cache', 'topstream');

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    if (cachedData) {
      res.json(cachedData);
      const shouldUpdate = await shouldUpdateCache24h(cacheDir, cacheKey);
      if (shouldUpdate) {
        (async () => {
          try {
            const results = await searchTopStream(query);
            await saveToCache(cacheDir, cacheKey, { success: true, results });
          } catch (err) {
            if (err.response?.status === 403) console.error('[TOPSTREAM] 403 background search:', query);
          }
        })();
      }
      return;
    }

    const results = await searchTopStream(query);
    const data = { success: true, results };
    await saveToCache(cacheDir, cacheKey, data);
    res.json(data);

  } catch (error) {
    if (error.response?.status === 403) console.error('[TOPSTREAM] 403 Forbidden search:', query);
    else console.error('[TOPSTREAM] Search error:', query, error.message);
    res.status(500).json({ success: false, error: 'Erreur lors de la recherche', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /movie/:slug (conservé pour usage direct par slug)
// ---------------------------------------------------------------------------
router.get('/movie/:slug', async (req, res) => {
  const { slug } = req.params;
  const cacheKey = generateCacheKey(`topstream_movie_${slug}`);
  const cacheDir = path.join(__dirname, '..', 'cache', 'topstream');

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    if (cachedData) {
      res.json(cachedData);
      const shouldUpdate = await shouldUpdateCache24h(cacheDir, cacheKey);
      if (shouldUpdate) {
        (async () => {
          try {
            const result = await getTopStreamEmbed(`${TOPSTREAM_BASE_URL}/movie/${slug}`);
            await saveToCache(cacheDir, cacheKey, { success: true, slug, type: 'movie', ...result });
          } catch (err) {
            if (err.response?.status === 403) console.error('[TOPSTREAM] 403 background movie:', slug);
          }
        })();
      }
      return;
    }

    const result = await getTopStreamEmbed(`${TOPSTREAM_BASE_URL}/movie/${slug}`);
    const data = { success: true, slug, type: 'movie', ...result };
    await saveToCache(cacheDir, cacheKey, data);
    res.json(data);

  } catch (error) {
    if (error.response?.status === 403) console.error('[TOPSTREAM] 403 Forbidden movie:', slug);
    else console.error('[TOPSTREAM] Movie error:', slug, error.message);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération du film', details: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /episode/:slug/:season-:episode (conservé pour usage direct par slug)
// ---------------------------------------------------------------------------
router.get('/episode/:slug/:seasonEpisode', async (req, res) => {
  const { slug, seasonEpisode } = req.params;

  const match = seasonEpisode.match(/^(\d+)-(\d+)$/);
  if (!match) {
    return res.status(400).json({ success: false, error: 'Format invalide. Utilisez :season-:episode (ex: 5-1).' });
  }

  const season = parseInt(match[1]);
  const episode = parseInt(match[2]);
  const cacheKey = generateCacheKey(`topstream_episode_${slug}_${season}_${episode}`);
  const cacheDir = path.join(__dirname, '..', 'cache', 'topstream');

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    if (cachedData) {
      res.json(cachedData);
      const shouldUpdate = await shouldUpdateCache24h(cacheDir, cacheKey);
      if (shouldUpdate) {
        (async () => {
          try {
            const result = await getTopStreamEmbed(`${TOPSTREAM_BASE_URL}/episode/${slug}/${season}-${episode}`);
            await saveToCache(cacheDir, cacheKey, { success: true, slug, type: 'tv', season, episode, ...result });
          } catch (err) {
            if (err.response?.status === 403) console.error('[TOPSTREAM] 403 background episode:', slug, 'S' + season + 'E' + episode);
          }
        })();
      }
      return;
    }

    const result = await getTopStreamEmbed(`${TOPSTREAM_BASE_URL}/episode/${slug}/${season}-${episode}`);
    const data = { success: true, slug, type: 'tv', season, episode, ...result };
    await saveToCache(cacheDir, cacheKey, data);
    res.json(data);

  } catch (error) {
    if (error.response?.status === 403) console.error('[TOPSTREAM] 403 Forbidden episode:', slug, 'S' + season + 'E' + episode);
    else console.error('[TOPSTREAM] Episode error:', slug, error.message);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération de l\'épisode', details: error.message });
  }
});

module.exports = router;
module.exports.configure = configure;
