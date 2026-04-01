/**
 * Download routes module.
 * Extracted from server.js -- handles film/series download link retrieval,
 * m3u8 extraction, Darkibox premium, cache deletion, and anime cache.
 *
 * Mounted at /api  (paths below are relative to that prefix).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const axios = require('axios');
const { generateCacheKey, ANIME_SAMA_CACHE_DIR, getCacheRefreshInfo } = require('../utils/cacheManager');

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let DARKINO_MAINTENANCE;
let DARKINOS_CACHE_DIR;
let darkiworld_premium = false;
let darkiHeaders;
let axiosDarkinoRequest;
let getFromCacheNoExpiration;
let saveToCache;
let shouldUpdateCache;
let refreshDarkinoSessionIfNeeded;

/**
 * Inject runtime dependencies that still live in app.js.
 */
function configure(deps) {
  if (deps.DARKINO_MAINTENANCE !== undefined) DARKINO_MAINTENANCE = deps.DARKINO_MAINTENANCE;
  if (deps.DARKINOS_CACHE_DIR) DARKINOS_CACHE_DIR = deps.DARKINOS_CACHE_DIR;
  if (deps.darkiworld_premium !== undefined) darkiworld_premium = deps.darkiworld_premium;
  if (deps.darkiHeaders) darkiHeaders = deps.darkiHeaders;
  if (deps.axiosDarkinoRequest) axiosDarkinoRequest = deps.axiosDarkinoRequest;
  if (deps.getFromCacheNoExpiration) getFromCacheNoExpiration = deps.getFromCacheNoExpiration;
  if (deps.saveToCache) saveToCache = deps.saveToCache;
  if (deps.shouldUpdateCache) shouldUpdateCache = deps.shouldUpdateCache;
  if (deps.refreshDarkinoSessionIfNeeded) refreshDarkinoSessionIfNeeded = deps.refreshDarkinoSessionIfNeeded;
}

// ---------------------------------------------------------------------------
// Utility functions (were inline in server.js)
// ---------------------------------------------------------------------------

const truncateForLog = (value, maxLength = 240) => {
  if (typeof value !== 'string') return value;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
};

const buildLogContext = (context = {}) => {
  const parts = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? parts.join(' ') : 'no-context';
};

const summarizeErrorForLog = (error) => {
  const responseBody = error?.response?.data;
  return {
    message: error?.message,
    code: error?.code,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    responseSnippet: typeof responseBody === 'string'
      ? truncateForLog(responseBody, 500)
      : responseBody && typeof responseBody === 'object'
        ? truncateForLog(JSON.stringify(responseBody), 500)
        : undefined
  };
};

const summarizeSourceForLog = (source) => {
  if (!source) return null;
  return {
    src: truncateForLog(source.src),
    language: source.language,
    quality: source.quality,
    sub: source.sub,
    hasM3u8: !!source.m3u8
  };
};

const summarizeSourcesForLog = (sources = [], limit = 5) =>
  sources.slice(0, limit).map(summarizeSourceForLog);

const validateM3u8Url = async (m3u8Url, _useProxy = false, logContext = {}) => {
  if (!m3u8Url) return { isValid: false, quality: null };
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      timeout: 2000,
      validateStatus: (status) => status === 200,
      decompress: true
    });
    const contentType = response.headers['content-type'];
    const isValidContent = contentType && (
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      contentType.includes('audio/mpegurl') ||
      contentType.includes('text/plain')
    );
    const isValidM3u8 = response.data && typeof response.data === 'string' &&
      (response.data.includes('#EXTM3U') || response.data.includes('#EXT-X-VERSION'));
    const isValid = isValidContent || isValidM3u8;
    let quality = null;
    if (isValid && response.data && typeof response.data === 'string') {
      const content = response.data;
      const resolutionMatch = content.match(/RESOLUTION=(\d+x\d+)/i);
      if (resolutionMatch) {
        const [width, height] = resolutionMatch[1].split('x').map(Number);
        if (width >= 3840 || height >= 2160) quality = '4K';
        else if (width >= 1920 || height >= 1080) quality = '1080p';
        else if (width >= 1280 || height >= 720) quality = '720p';
        else if (width >= 854 || height >= 480) quality = '480p';
        else if (width >= 640 || height >= 360) quality = '360p';
        else quality = `${height}p`;
      } else {
        const qualityMatch = content.match(/(\d+p|4k|hd|sd)/gi);
        if (qualityMatch) {
          const qs = qualityMatch[0].toLowerCase();
          if (qs.includes('4k')) quality = '4K';
          else if (qs.includes('1080p') || qs.includes('hd')) quality = '1080p';
          else if (qs.includes('720p')) quality = '720p';
          else if (qs.includes('480p')) quality = '480p';
          else if (qs.includes('360p')) quality = '360p';
          else quality = qs.toUpperCase();
        }
      }
    }
    return { isValid, quality };
  } catch (_error) {
    return { isValid: false, quality: null };
  }
};

const extractM3u8Url = async (darkiboxUrl, logContext = {}) => {
  let timeoutId;
  try {
    const axiosPromise = axios.get(darkiboxUrl);
    const timeoutPromise = new Promise((_, reject) =>
      { timeoutId = setTimeout(() => reject(new Error('Request timed out (manual)')), 4500); }
    );
    const response = await Promise.race([axiosPromise, timeoutPromise]);
    const htmlContent = response.data;
    const playerConfigMatch = htmlContent.match(/sources:\s*\[\s*{\s*src:\s*"([^"]+)"/);
    if (playerConfigMatch && playerConfigMatch[1]) {
      const m3u8Url = playerConfigMatch[1];
      const validation = await validateM3u8Url(m3u8Url, false, {
        ...logContext,
        sourceUrl: truncateForLog(darkiboxUrl, 160)
      });
      if (validation.isValid) {
        return { url: m3u8Url, quality: validation.quality };
      }
      return null;
    }
    return null;
  } catch (_error) {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const deduplicateSourcesWithPreference = (sources = []) => {
  const normalizeLang = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
  const mergeMissingFields = (main, other) => {
    const merged = { ...main };
    for (const field of ['language', 'quality', 'sub', 'provider', 'm3u8', 'src']) {
      if ((merged[field] === undefined || merged[field] === null || merged[field] === '') && other[field]) {
        merged[field] = other[field];
      }
    }
    return merged;
  };
  const choosePreferred = (current, candidate) => {
    if (!current) return { ...candidate };
    if (!candidate) return { ...current };
    const currentLang = normalizeLang(current.language);
    const candidateLang = normalizeLang(candidate.language);
    let winner = current, loser = candidate;
    if (!current.m3u8 && candidate.m3u8) { winner = candidate; loser = current; }
    else if (current.m3u8 && !candidate.m3u8) { winner = current; loser = candidate; }
    else if (candidateLang === 'multi' && currentLang !== 'multi') { winner = candidate; loser = current; }
    else if (currentLang === 'multi' && candidateLang !== 'multi') { winner = current; loser = candidate; }
    else if (!current.language && candidate.language) { winner = candidate; loser = current; }
    return mergeMissingFields(winner, loser);
  };
  const byKey = new Map();
  for (const source of sources) {
    if (!source) continue;
    const key = source.m3u8 || source.src;
    if (!key) continue;
    byKey.set(key, choosePreferred(byKey.get(key), source));
  }
  return [...byKey.values()];
};

// ---------------------------------------------------------------------------
// findDarkiboxEntriesForEpisode  -- paginate Darkibox API to find entries
// ---------------------------------------------------------------------------
async function findDarkiboxEntriesForEpisode({ titleId, seasonId, episodeId, perPage = 100, maxPages = 10 }) {
  // Rafraichir les cookies avant de commencer la pagination
  try {
    await refreshDarkinoSessionIfNeeded();
  } catch (e) {
    console.warn('Erreur lors du rafraichissement des cookies Darkino:', e.message);
  }
  let page = 1;
  let foundEntries = [];
  let shouldContinue = true;
  while (shouldContinue && page <= maxPages) {
    const url = `/api/v1/liens?perPage=${perPage}&page=${page}&title_id=${titleId}&loader=linksdl&season=${seasonId}&filters=&paginate=preferLengthAware`;
    try {
      const resp = await axiosDarkinoRequest({
        method: 'get',
        url: url,
        headers: darkiHeaders
      });
      const data = resp.data?.pagination?.data || [];
      // Cherche les entrees correspondant a l'episode
      const matching = data.filter(entry =>
        entry.host && entry.host.id_host === 2 && entry.host.name === 'darkibox' &&
        (entry.episode_id == episodeId || entry.episode == episodeId || entry.episode_number == episodeId)
      );
      if (matching.length > 0) {
        foundEntries = matching;
        break;
      }
      // Pagination intelligente
      const nextPage = resp.data?.pagination?.next_page;
      if (!nextPage) {
        shouldContinue = false;
      } else {
        page = nextPage;
      }
    } catch (error) {
      console.error(`[DARKIBOX] Erreur lors de la recherche des liens (page ${page}) ${buildLogContext({ titleId, seasonId, episodeId })}`, summarizeErrorForLog(error));
      shouldContinue = false;
    }
  }
  return foundEntries;
}

// ===========================================================================
// ROUTES  (mounted at /api, so paths are relative)
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /films/download/:id  -- retrieve download links for a film
// ---------------------------------------------------------------------------
router.get('/films/download/:id', async (req, res) => {
  if (DARKINO_MAINTENANCE) {
    return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
  }
  try {
    const { id } = req.params;
    const cacheKey = generateCacheKey(`films_download_${id}`);
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    const M3U8_CACHE_EXPIRY = 8 * 60 * 60 * 1000; // 8 hours in milliseconds

    let dataReturned = false;
    if (cachedData && cachedData.sources !== undefined) {
      const now = Date.now();
      const needM3u8Refresh = !cachedData.m3u8Timestamp || (now - cachedData.m3u8Timestamp > M3U8_CACHE_EXPIRY);
      let sourcesWithM3u8;
      if (!needM3u8Refresh && cachedData.sourcesWithM3u8) {
        sourcesWithM3u8 = cachedData.sourcesWithM3u8;
        const validSources = sourcesWithM3u8.filter(source => source.m3u8);
        if (validSources.length === 0) {
          // Aucun m3u8 valide dans le cache, on force la re-extraction
          sourcesWithM3u8 = await Promise.all(
            cachedData.sources.map(async (source, idx) => {
              const m3u8Result = await extractM3u8Url(source.src);
              if (m3u8Result) {
                return {
                  ...source,
                  m3u8: m3u8Result.url,
                  quality: m3u8Result.quality || source.quality
                };
              }
              return { ...source, m3u8: null };
            })
          );
          const newCacheData = {
            ...cachedData,
            sourcesWithM3u8: sourcesWithM3u8,
            m3u8Timestamp: Date.now()
          };
          await saveToCache(DARKINOS_CACHE_DIR, cacheKey, newCacheData);
        }
      } else {
        sourcesWithM3u8 = await Promise.all(
          cachedData.sources.map(async (source, idx) => {
            const m3u8Result = await extractM3u8Url(source.src);
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          })
        );
        const newCacheData = {
          ...cachedData,
          sourcesWithM3u8: sourcesWithM3u8,
          m3u8Timestamp: Date.now()
        };
        await saveToCache(DARKINOS_CACHE_DIR, cacheKey, newCacheData);
      }
      const dedupedSources = deduplicateSourcesWithPreference(sourcesWithM3u8);
      // Filtrer les sources avec m3u8: null avant de retourner
      const filteredSources = dedupedSources.filter(source => source.m3u8);
      // Retourner les sources dedupliquees et filtrees
      res.status(200).json({ sources: filteredSources });
      dataReturned = true;
      (async () => {
        try {
          const shouldUpdate_ = await shouldUpdateCache(DARKINOS_CACHE_DIR, cacheKey);
          if (!shouldUpdate_) {
            return;
          }

          await refreshDarkinoSessionIfNeeded();
          const response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/titles/${id}/download` });
          let freshSources = response.data.alternative_videos || [];
          if (response.data.video) {
            freshSources.unshift(response.data.video);
          }
          if (freshSources.length > 0) {
            const basicSources = freshSources.map(source => ({
              src: source.src,
              language: source.language,
              quality: source.quality,
              sub: source.sub
            }));
            const currentCacheData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey) || {};
            if (JSON.stringify(basicSources) !== JSON.stringify(currentCacheData.sources)) {
              await saveToCache(DARKINOS_CACHE_DIR, cacheKey, { sources: basicSources });
            }
          }
        } catch (refreshError) {
        }
      })();
      return;
    }
    // Si pas de cache valide, comportement normal (requete Darkino)
    const maxRetries = 3;
    let retryCount = 0;
    let response;
    let success = false;
    await refreshDarkinoSessionIfNeeded();
    while (!success && retryCount < maxRetries) {
      try {
        response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/titles/${id}/download` });
        success = true;
      } catch (error) {
        if (error.response?.data?.message === "Il y a eu un probleme. Veuillez reessayer plus tard.") {
          throw error;
        }

        // Arreter immediatement sur les erreurs 500/403
        if (error.response && (error.response.status === 500 || error.response.status === 403)) {
          throw error;
        }

        retryCount++;
        if (retryCount >= maxRetries) {
          throw error;
        }
        if (!error.response) {
          const delay = Math.min(2000 * Math.pow(1.5, retryCount), 5000) + (Math.random() * 500);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }
    let sources = response.data.alternative_videos || [];
    if (response.data.video) {
      sources.unshift(response.data.video);
    }
    const basicSources = sources.map(source => ({
      src: source.src,
      language: source.language,
      quality: source.quality,
      sub: source.sub
    }));

    // --- DARKIBOX ENHANCEMENT START ---
    if (darkiworld_premium) {
      try {
        // 1. Fetch all links for the film
        const darkiboxLiensResp = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/liens?perPage=100&title_id=${id}&loader=linksdl&season=1&filters=&paginate=preferLengthAware` });
        const darkiboxEntries = (darkiboxLiensResp.data?.pagination?.data || []).filter(
          entry => entry.host && entry.host.id_host === 2 && entry.host.name === 'darkibox'
        );
        const darkiboxIds = darkiboxEntries.map(entry => entry.id);
        if (darkiboxIds.length > 0) {
          // 2. POST to download-premium with all darkibox IDs
          const darkiboxDownloadResp = await axiosDarkinoRequest({ method: 'post', url: `/api/v1/download-premium/${darkiboxIds.join(',')}` });
          const darkiboxLinks = (darkiboxDownloadResp.data?.liens || []).filter(l => l.lien && l.lien.includes('darkibox.com'));
          // 3. For each link, extract m3u8
          const darkiboxSources = await Promise.all(darkiboxLinks.map(async (lienObj) => {
            let idMatch = lienObj.lien.match(/(?:\/d\/|\/)([a-z0-9]{12,})/i);
            let darkiboxId = idMatch ? idMatch[1] : null;
            let m3u8Url = null;
            let embedUrl = null;
            if (darkiboxId) {
              embedUrl = `https://darkibox.com/embed-${darkiboxId}.html`;
              const m3u8Result = await extractM3u8Url(embedUrl);
              m3u8Url = m3u8Result?.url || null;
            }
            const meta = darkiboxEntries.find(e => e.id === lienObj.id);
            return m3u8Url ? {
              src: embedUrl,
              m3u8: m3u8Url,
              language: (meta?.langues_compact && meta.langues_compact.length > 0) ? meta.langues_compact.map(l => l.name).join(', ') : undefined,
              quality: meta?.qual?.qual,
              sub: (meta?.subs_compact && meta.subs_compact.length > 0) ? meta.subs_compact.map(s => s.name).join(', ') : undefined,
              provider: 'darkibox'
            } : null;
          }));
          const validDarkiboxSources = darkiboxSources.filter(Boolean);
          for (const src of validDarkiboxSources) {
            if (!basicSources.some(s => s.src === src.src)) {
              basicSources.push(src);
            }
          }
        }
      } catch (err) {
        console.error('[DARKIBOX] Error enhancing darkibox links:', err.message);
      }
    }
    // --- DARKIBOX ENHANCEMENT END ---

    // Extract and cache m3u8 URLs
    let sourcesWithM3u8 = await Promise.all(
      basicSources.map(async (source, idx) => {
        if (source.m3u8) {
          const validation = await validateM3u8Url(source.m3u8, false);
          if (validation.isValid) {
            return {
              ...source,
              m3u8: source.m3u8,
              quality: validation.quality || source.quality
            };
          } else {
            return { ...source, m3u8: null };
          }
        } else {
          const m3u8Result = await extractM3u8Url(source.src);
          if (m3u8Result) {
            return {
              ...source,
              m3u8: m3u8Result.url,
              quality: m3u8Result.quality || source.quality
            };
          }
          return { ...source, m3u8: null };
        }
      })
    );
    // Retry extraction if no valid sources (up to 2 more times)
    let validSources = sourcesWithM3u8.filter(source => source.m3u8);
    let m3u8RetryCount = 0;
    while (validSources.length === 0 && m3u8RetryCount < 2) {
      m3u8RetryCount++;
      await new Promise(r => setTimeout(r, 500));
      sourcesWithM3u8 = await Promise.all(
        basicSources.map(async (source, idx) => {
          if (source.m3u8) {
            const validation = await validateM3u8Url(source.m3u8, false);
            if (validation.isValid) {
              return {
                ...source,
                m3u8: source.m3u8,
                quality: validation.quality || source.quality
              };
            } else {
              return { ...source, m3u8: null };
            }
          } else {
            const m3u8Result = await extractM3u8Url(source.src);
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          }
        })
      );
      validSources = sourcesWithM3u8.filter(source => source.m3u8);
    }
    const dedupedSources = deduplicateSourcesWithPreference(sourcesWithM3u8);
    // Save both the basic sources and the sources with m3u8
    await saveToCache(DARKINOS_CACHE_DIR, cacheKey, {
      sources: basicSources,
      sourcesWithM3u8: sourcesWithM3u8,
      m3u8Timestamp: Date.now()
    });
    // Filtrer les sources avec m3u8: null avant de retourner
    const filteredSources = dedupedSources.filter(source => source.m3u8);
    res.status(200).json({ sources: filteredSources });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la recuperation des liens de telechargement' });
  }
});

// ---------------------------------------------------------------------------
// GET /series/download/:titleId/season/:seasonId/episode/:episodeId
// ---------------------------------------------------------------------------
router.get('/series/download/:titleId/season/:seasonId/episode/:episodeId', async (req, res) => {
  if (DARKINO_MAINTENANCE) {
    return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
  }
  const { titleId, seasonId, episodeId } = req.params;
  const cacheKey = generateCacheKey(`series_download_${titleId}_${seasonId}_${episodeId}`);
  const requestContext = {
    route: 'series_download',
    titleId,
    seasonId,
    episodeId,
    cacheKey
  };
  try {
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    const M3U8_CACHE_EXPIRY = 8 * 60 * 60 * 1000;

    let dataReturned = false;
    if (cachedData && cachedData.sources !== undefined) {
      const now = Date.now();
      const needM3u8Refresh = !cachedData.m3u8Timestamp ||
        (now - cachedData.m3u8Timestamp > M3U8_CACHE_EXPIRY);

      let sourcesWithM3u8;
      let validSources = [];

      if (!needM3u8Refresh && cachedData.sourcesWithM3u8) {
        sourcesWithM3u8 = cachedData.sourcesWithM3u8;
        validSources = sourcesWithM3u8.filter(source => source.m3u8);
      }

      if (needM3u8Refresh || validSources.length === 0) {
        sourcesWithM3u8 = await Promise.all(
          cachedData.sources.map(async (source, sourceIndex) => {
            const m3u8Result = await extractM3u8Url(source.src, {
              ...requestContext,
              phase: 'cache_reextract',
              sourceIndex
            });
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          })
        );

        const newCacheData = {
          ...cachedData,
          sourcesWithM3u8: sourcesWithM3u8,
          m3u8Timestamp: Date.now()
        };
        await saveToCache(DARKINOS_CACHE_DIR, cacheKey, newCacheData);
        validSources = sourcesWithM3u8.filter(source => source.m3u8);
      }

      const dedupedSources = deduplicateSourcesWithPreference(validSources);
      const filteredSources = dedupedSources.filter(source => source.m3u8);
      const cachedSourceCount = Array.isArray(cachedData.sources) ? cachedData.sources.length : 0;
      const cachedSourcesWithM3u8Count = Array.isArray(cachedData.sourcesWithM3u8) ? cachedData.sourcesWithM3u8.length : 0;
      const cacheRefreshInfo = await getCacheRefreshInfo(DARKINOS_CACHE_DIR, cacheKey);
      const shouldRefreshCacheNow = cacheRefreshInfo.shouldRefreshNow;
      const refreshSummary = shouldRefreshCacheNow
        ? 'refresh possible immediatement'
        : `refresh possible dans ${cacheRefreshInfo.refreshInMinutes} min (${cacheRefreshInfo.refreshAvailableAt})`;
      const shouldForceLiveRefetch = filteredSources.length === 0;
      if (!shouldForceLiveRefetch) {
        res.status(200).json({ sources: filteredSources });
        dataReturned = true;

        (async () => {
          try {
            if (!shouldRefreshCacheNow) {
              return;
            }

            await refreshDarkinoSessionIfNeeded();
            const response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/titles/${titleId}/season/${seasonId}/episode/${episodeId}/download`, headers: darkiHeaders });
            let freshSources = response.data.alternative_videos || [];
            if (response.data.video) {
              freshSources.unshift(response.data.video);
            }
            // Filtrer les sources pour l'episode demande
            freshSources = freshSources.filter(source => {
              return !source.episode || source.episode.toString() === episodeId.toString();
            });
            if (freshSources.length > 0) {
              const basicSources = freshSources.map(source => ({
                src: source.src,
                language: source.language,
                quality: source.quality,
                sub: source.sub
              }));

              const currentCacheData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey) || {};
              if (JSON.stringify(basicSources) !== JSON.stringify(currentCacheData.sources)) {
                await saveToCache(DARKINOS_CACHE_DIR, cacheKey, { sources: basicSources });
              }
            }
          } catch (_refreshError) {
          }
        })();
        return;
      }
    }
    // Si pas de cache valide, comportement normal (requete Darkino)
    const maxRetries = 3;
    let retryCount = 0;
    let response;
    let success = false;
    await refreshDarkinoSessionIfNeeded();
    while (!success && retryCount < maxRetries) {
      try {
        response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/titles/${titleId}/season/${seasonId}/episode/${episodeId}/download`, headers: darkiHeaders });
        success = true;
      } catch (error) {
        if (error.response?.data?.message === "Il y a eu un probleme. Veuillez reessayer plus tard.") {
          throw error;
        }

        // Arreter immediatement sur les erreurs 500/403
        if (error.response && (error.response.status === 500 || error.response.status === 403)) {
          throw error;
        }

        retryCount++;
        if (retryCount >= maxRetries) {
          throw error;
        }
        const delay = Math.min(2000 * Math.pow(2, retryCount), 30000) + (Math.random() * 1000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    let sources = response.data.alternative_videos || [];
    if (response.data.video) {
      sources.unshift(response.data.video);
    }
    // Filtrer les sources pour l'episode demande
    sources = sources.filter(source => {
      return !source.episode || source.episode.toString() === episodeId.toString();
    });
    const basicSources = sources.map(source => ({
      src: source.src,
      language: source.language,
      quality: source.quality,
      sub: source.sub
    }));
    // --- DARKIBOX ENHANCEMENT START ---
    if (darkiworld_premium) {
      try {
        const darkiboxEntries = await findDarkiboxEntriesForEpisode({ titleId, seasonId, episodeId, perPage: 100, maxPages: 10 });
        const darkiboxIds = darkiboxEntries.map(entry => entry.id);
        if (darkiboxIds.length > 0) {
          const darkiboxDownloadResp = await axiosDarkinoRequest({ method: 'post', url: `/api/v1/download-premium/${darkiboxIds.join(',')}` });
          const darkiboxLinks = (darkiboxDownloadResp.data?.liens || []).filter(l => l.lien && l.lien.includes('darkibox.com'));
          const darkiboxSources = await Promise.all(darkiboxLinks.map(async (lienObj) => {
            let idMatch = lienObj.lien.match(/(?:\/d\/|\/)([a-z0-9]{12,})/i);
            let darkiboxId = idMatch ? idMatch[1] : null;
            let m3u8Url = null;
            let embedUrl = null;
            if (darkiboxId) {
              embedUrl = `https://darkibox.com/embed-${darkiboxId}.html`;
              const m3u8Result = await extractM3u8Url(embedUrl);
              m3u8Url = m3u8Result?.url || null;
            }
            const meta = darkiboxEntries.find(e => e.id === lienObj.id);
            return m3u8Url ? {
              src: embedUrl,
              m3u8: m3u8Url,
              language: (meta?.langues_compact && meta.langues_compact.length > 0) ? meta.langues_compact.map(l => l.name).join(', ') : undefined,
              quality: meta?.qual?.qual,
              sub: (meta?.subs_compact && meta.subs_compact.length > 0) ? meta.subs_compact.map(s => s.name).join(', ') : undefined,
              provider: 'darkibox'
            } : null;
          }));
          const validDarkiboxSources = darkiboxSources.filter(Boolean);
          for (const src of validDarkiboxSources) {
            if (!basicSources.some(s => s.src === src.src)) {
              basicSources.push(src);
            }
          }
        }
      } catch (err) {
        console.error('[DARKIBOX] Error enhancing darkibox links (series):', err.message);
      }
    }
    // --- DARKIBOX ENHANCEMENT END ---

    // Extract and cache m3u8 URLs
    let sourcesWithM3u8 = await Promise.all(
      basicSources.map(async (source, sourceIndex) => {
        if (source.m3u8) {
          const validation = await validateM3u8Url(source.m3u8, false, {
            ...requestContext,
            phase: 'initial_validation',
            sourceIndex
          });
          if (validation.isValid) {
            return {
              ...source,
              m3u8: source.m3u8,
              quality: validation.quality || source.quality
            };
          } else {
            return { ...source, m3u8: null };
          }
        } else {
          const m3u8Result = await extractM3u8Url(source.src, {
            ...requestContext,
            phase: 'initial_extract',
            sourceIndex
          });
          if (m3u8Result) {
            return {
              ...source,
              m3u8: m3u8Result.url,
              quality: m3u8Result.quality || source.quality
            };
          }
          return { ...source, m3u8: null };
        }
      })
    );
    // Retry extraction if no valid sources (up to 2 more times)
    let validSources = sourcesWithM3u8.filter(source => source.m3u8);
    let m3u8RetryCount = 0;
    while (validSources.length === 0 && m3u8RetryCount < 2) {
      m3u8RetryCount++;
      await new Promise(r => setTimeout(r, 500));
      sourcesWithM3u8 = await Promise.all(
        basicSources.map(async (source, sourceIndex) => {
          if (source.m3u8) {
            const validation = await validateM3u8Url(source.m3u8, false, {
              ...requestContext,
              phase: `retry_validation_${m3u8RetryCount}`,
              sourceIndex
            });
            if (validation.isValid) {
              return {
                ...source,
                m3u8: source.m3u8,
                quality: validation.quality || source.quality
              };
            } else {
              return { ...source, m3u8: null };
            }
          } else {
            const m3u8Result = await extractM3u8Url(source.src, {
              ...requestContext,
              phase: `retry_extract_${m3u8RetryCount}`,
              sourceIndex
            });
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          }
        })
      );
      validSources = sourcesWithM3u8.filter(source => source.m3u8);
    }
    // Deduplication des sources par m3u8 (prioritaire) puis src
    const seenM3u8 = new Set();
    const seenSrc = new Set();
    const dedupedSources = [];
    for (const source of sourcesWithM3u8) {
      const key = source.m3u8 || source.src;
      if (!key) continue;
      if (!seenM3u8.has(key)) {
        seenM3u8.add(key);
        dedupedSources.push(source);
      }
    }
    // Deduplication supplementaire sur src
    const finalSources = [];
    for (const source of dedupedSources) {
      if (!seenSrc.has(source.src)) {
        seenSrc.add(source.src);
        finalSources.push(source);
      }
    }
    // Save both the basic sources and the sources with m3u8
    await saveToCache(DARKINOS_CACHE_DIR, cacheKey, {
      sources: basicSources,
      sourcesWithM3u8: sourcesWithM3u8,
      m3u8Timestamp: Date.now()
    });
    // Filtrer les sources avec m3u8: null avant de retourner
    const filteredSources = finalSources.filter(source => source.m3u8 !== null);
    res.status(200).json({ sources: filteredSources });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la recuperation des liens de telechargement' });
  }
});

// ---------------------------------------------------------------------------
// GET /darkino/download-premium/:id
// ---------------------------------------------------------------------------
router.get('/darkino/download-premium/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axiosDarkinoRequest({ method: 'post', url: `/api/v1/download-premium/${id}` });
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Erreur lors de la requete download-premium:', error.response?.status || error.message);
    if (error.response) {
      res.status(error.response.status).json({ error: error.response.data || 'Erreur lors de la requete download-premium' });
    } else {
      res.status(500).json({ error: 'Erreur lors de la requete download-premium' });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /titles/:id/download  -- download links via title ID
// ---------------------------------------------------------------------------
router.get('/titles/:id/download', async (req, res) => {
  if (DARKINO_MAINTENANCE) {
    return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
  }
  try {
    const { id } = req.params;

    // Generate cache key
    const cacheKey = generateCacheKey(`titles_download_${id}`);

    // Check if results are in cache
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    const M3U8_CACHE_EXPIRY = 8 * 60 * 60 * 1000;

    let dataReturned = false;
    if (cachedData && cachedData.sources !== undefined) {
      const now = Date.now();
      const needM3u8Refresh = !cachedData.m3u8Timestamp || (now - cachedData.m3u8Timestamp > M3U8_CACHE_EXPIRY);
      let sourcesWithM3u8 = cachedData.sourcesWithM3u8 || [];

      if (needM3u8Refresh) {
        sourcesWithM3u8 = await Promise.all(
          cachedData.sources.map(async (source) => {
            const m3u8Result = await extractM3u8Url(source.src);
            if (m3u8Result) {
              return {
                ...source,
                m3u8: m3u8Result.url,
                quality: m3u8Result.quality || source.quality
              };
            }
            return { ...source, m3u8: null };
          })
        );
        // Mise a jour du cache avec les URLs m3u8 rafraichies
        await saveToCache(DARKINOS_CACHE_DIR, cacheKey, {
          sources: cachedData.sources,
          sourcesWithM3u8: sourcesWithM3u8,
          m3u8Timestamp: now
        });
      }

      // Deduplication des sources par m3u8
      const seenM3u8 = new Set();
      const seenSrc = new Set();
      const dedupedSources = [];
      for (const source of sourcesWithM3u8) {
        const key = source.m3u8 || source.src;
        if (!key) continue;
        if (!seenM3u8.has(key)) {
          seenM3u8.add(key);
          dedupedSources.push(source);
        }
      }
      const finalSources = [];
      for (const source of dedupedSources) {
        if (!seenSrc.has(source.src)) {
          seenSrc.add(source.src);
          finalSources.push(source);
        }
      }
      const filteredSources = finalSources.filter(source => source.m3u8 !== null);
      res.status(200).json({ sources: filteredSources });
      dataReturned = true;
      (async () => {
        try {
          const shouldUpdate_ = await shouldUpdateCache(DARKINOS_CACHE_DIR, cacheKey);
          if (!shouldUpdate_) {
            return;
          }

          await refreshDarkinoSessionIfNeeded();
          const response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/titles/${id}/download` });
          let freshSources = response.data.alternative_videos || [];
          if (response.data.video) {
            freshSources.unshift(response.data.video);
          }
          if (freshSources.length > 0) {
            const basicSources = freshSources.map(source => ({
              src: source.src,
              language: source.language,
              quality: source.quality,
              sub: source.sub
            }));
            const currentCacheData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey) || {};
            if (JSON.stringify(basicSources) !== JSON.stringify(currentCacheData.sources)) {
              await saveToCache(DARKINOS_CACHE_DIR, cacheKey, { sources: basicSources });
            }
          }
        } catch (refreshError) {
        }
      })();
      return;
    }
    // Si pas de cache valide, comportement normal (requete Darkino)
    const maxRetries = 3;
    let retryCount = 0;
    let response;
    let success = false;
    await refreshDarkinoSessionIfNeeded();
    while (!success && retryCount < maxRetries) {
      try {
        response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/titles/${id}/download` });
        success = true;
      } catch (error) {
        if (error.response?.data?.message === "Il y a eu un probleme. Veuillez reessayer plus tard.") {
          throw error;
        }

        if (error.response && (error.response.status === 500 || error.response.status === 403)) {
          throw error;
        }

        retryCount++;
        if (retryCount >= maxRetries) {
          throw error;
        }
        if (!error.response) {
          const delay = Math.min(2000 * Math.pow(1.5, retryCount), 5000) + (Math.random() * 500);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }
    // ... existing code (process response.data) ...

  } catch (error) {
    console.error(`Erreur lors de la recuperation des liens de telechargement:`, error);
    res.status(500).json({ error: 'Erreur lors de la recuperation des liens de telechargement' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /films/download/:id/cache  -- delete film download cache
// ---------------------------------------------------------------------------
router.delete('/films/download/:id/cache', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = generateCacheKey(`films_download_${id}`);
    const cacheFile = path.join(DARKINOS_CACHE_DIR, `${cacheKey}.json`);
    await fsp.unlink(cacheFile);
    return res.status(200).json({ success: true, message: `Cache film ${id} supprime.` });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Cache introuvable.' });
    }
    console.error('Erreur suppression cache film :', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /series/download/:titleId/season/:seasonId/episode/:episodeId/cache
// ---------------------------------------------------------------------------
router.delete('/series/download/:titleId/season/:seasonId/episode/:episodeId/cache', async (req, res) => {
  try {
    const { titleId, seasonId, episodeId } = req.params;
    const cacheKey = generateCacheKey(`series_download_${titleId}_${seasonId}_${episodeId}`);
    const cacheFile = path.join(DARKINOS_CACHE_DIR, `${cacheKey}.json`);
    await fsp.unlink(cacheFile);
    return res.status(200).json({ success: true, message: `Cache episode ${titleId}/${seasonId}/${episodeId} supprime.` });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Cache introuvable.' });
    }
    console.error('Erreur suppression cache episode :', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = router;
module.exports.configure = configure;
module.exports.findDarkiboxEntriesForEpisode = findDarkiboxEntriesForEpisode;
