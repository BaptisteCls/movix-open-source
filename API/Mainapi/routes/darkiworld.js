/**
 * DarkiWorld routes module.
 * Extracted from server.js -- handles DarkiWorld download links, decoding,
 * seasons and episodes retrieval.
 *
 * Mounted at /api/darkiworld  (paths below are relative to that prefix).
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const { generateCacheKey } = require('../utils/cacheManager');
const { getAuthIfValid } = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Dependencies injected via configure()
// ---------------------------------------------------------------------------
let DARKINO_MAINTENANCE;
let DOWNLOAD_CACHE_DIR;
let darkiHeaders;
let axiosDarkinoRequest;
let getFromCacheNoExpiration;
let saveToCache;
let shouldUpdateCache;
let shouldUpdateCache24h;
let refreshDarkinoSessionIfNeeded;

/**
 * Inject runtime dependencies that still live in server.js.
 */
function configure(deps) {
  if (deps.DARKINO_MAINTENANCE !== undefined) DARKINO_MAINTENANCE = deps.DARKINO_MAINTENANCE;
  if (deps.DOWNLOAD_CACHE_DIR) DOWNLOAD_CACHE_DIR = deps.DOWNLOAD_CACHE_DIR;
  if (deps.darkiHeaders) darkiHeaders = deps.darkiHeaders;
  if (deps.axiosDarkinoRequest) axiosDarkinoRequest = deps.axiosDarkinoRequest;
  if (deps.getFromCacheNoExpiration) getFromCacheNoExpiration = deps.getFromCacheNoExpiration;
  if (deps.saveToCache) saveToCache = deps.saveToCache;
  if (deps.shouldUpdateCache) shouldUpdateCache = deps.shouldUpdateCache;
  if (deps.shouldUpdateCache24h) shouldUpdateCache24h = deps.shouldUpdateCache24h;
  if (deps.refreshDarkinoSessionIfNeeded) refreshDarkinoSessionIfNeeded = deps.refreshDarkinoSessionIfNeeded;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchLegacySeasonsPage(titleId, page, perPage) {
  const response = await axiosDarkinoRequest({
    method: 'get',
    url: `/api/v1/titles/${titleId}/seasons?perPage=${perPage}&query=&page=${page}`
  });

  return {
    success: true,
    mode: 'legacy',
    ...response.data
  };
}

async function fetchSeasonPageForCount(titleId, seasonNumbers = []) {
  const attemptedSeasonNumbers = new Set();

  for (const rawSeasonNumber of seasonNumbers) {
    const seasonNumber = parsePositiveInt(rawSeasonNumber, null);
    if (!seasonNumber || attemptedSeasonNumbers.has(seasonNumber)) {
      continue;
    }

    attemptedSeasonNumbers.add(seasonNumber);

    try {
      const response = await axiosDarkinoRequest({
        method: 'get',
        url: `/api/v1/titles/${titleId}/seasons/${seasonNumber}?loader=seasonPage`
      });

      const seasonsCount = parsePositiveInt(response.data?.title?.seasons_count, 0);
      if (seasonsCount > 0) {
        return {
          seasonsCount,
          data: response.data
        };
      }
    } catch (error) {
      const status = error.response?.status;
      if (status !== 404 && status !== 422) {
        console.warn(`[DARKIWORLD][SEASONS] seasonPage indisponible pour titleId=${titleId}, season=${seasonNumber}: ${error.message}`);
      }
    }
  }

  return null;
}

function buildSyntheticSeasonsResponse(titleId, page, perPage, seasonPagePayload) {
  const currentPage = parsePositiveInt(page, 1);
  const itemsPerPage = parsePositiveInt(perPage, 8);
  const seasonsCount = parsePositiveInt(seasonPagePayload?.title?.seasons_count, 0);
  const selectedSeason = seasonPagePayload?.season || null;
  const selectedSeasonNumber = parsePositiveInt(selectedSeason?.number, 0);
  const lastPage = seasonsCount > 0 ? Math.ceil(seasonsCount / itemsPerPage) : 1;
  const safePage = Math.min(currentPage, lastPage);
  const startIndex = seasonsCount > 0 ? (safePage - 1) * itemsPerPage : 0;

  const allSeasons = Array.from({ length: seasonsCount }, (_, index) => {
    const seasonNumber = index + 1;
    const isSelectedSeason = selectedSeasonNumber === seasonNumber;

    return {
      id: isSelectedSeason && selectedSeason?.id ? selectedSeason.id : seasonNumber,
      poster: isSelectedSeason ? (selectedSeason?.poster || '') : '',
      release_date: isSelectedSeason
        ? (selectedSeason?.release_date || seasonPagePayload?.title?.release_date || '')
        : '',
      number: seasonNumber,
      title_id: isSelectedSeason && selectedSeason?.title_id
        ? selectedSeason.title_id
        : parsePositiveInt(titleId, 0),
      episodes_count: isSelectedSeason
        ? parsePositiveInt(selectedSeason?.episodes_count ?? selectedSeason?.episode_count, 0)
        : 0,
      model_type: isSelectedSeason ? (selectedSeason?.model_type || 'season') : 'season',
      first_episode: isSelectedSeason ? (selectedSeason?.first_episode || null) : null
    };
  });

  const data = allSeasons.slice(startIndex, startIndex + itemsPerPage);
  const from = data.length > 0 ? startIndex + 1 : 0;
  const to = data.length > 0 ? startIndex + data.length : 0;

  return {
    success: true,
    mode: 'seasonPage',
    title: seasonPagePayload?.title || null,
    loader: seasonPagePayload?.loader || 'seasonPage',
    pagination: {
      current_page: safePage,
      data,
      from,
      last_page: lastPage,
      next_page: safePage < lastPage ? safePage + 1 : null,
      per_page: itemsPerPage,
      prev_page: safePage > 1 ? safePage - 1 : null,
      to,
      total: seasonsCount
    }
  };
}

async function fetchSeasonsCountResponse(titleId, page, perPage) {
  let seasonPageResult = await fetchSeasonPageForCount(titleId, [1]);

  if (!seasonPageResult) {
    try {
      const legacyBootstrap = await fetchLegacySeasonsPage(titleId, 1, 1);
      const firstLegacySeasonNumber = legacyBootstrap?.pagination?.data?.[0]?.number;
      seasonPageResult = await fetchSeasonPageForCount(titleId, [firstLegacySeasonNumber]);
    } catch (error) {
      const status = error.response?.status;
      if (status !== 404 && status !== 422) {
        console.warn(`[DARKIWORLD][SEASONS] fallback legacy indisponible pour titleId=${titleId}: ${error.message}`);
      }
    }
  }

  if (!seasonPageResult) {
    return null;
  }

  return buildSyntheticSeasonsResponse(titleId, page, perPage, seasonPageResult.data);
}

// ---------------------------------------------------------------------------
// findAllEntriesForEpisode -- paginate DarkiWorld API to find all entries
// ---------------------------------------------------------------------------
async function findAllEntriesForEpisode({ titleId, seasonId, episodeId, perPage = 100, maxPages = 10 }) {
  // Rafraîchir les cookies avant de commencer la pagination
  try {
    await refreshDarkinoSessionIfNeeded();
  } catch (e) {
    console.warn('Erreur lors du rafraîchissement des cookies Darkino:', e.message);
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

      // Chercher toutes les entrées correspondant à l'épisode ET les liens de saison complète
      const matching = data.filter(entry =>
        entry.host &&
        (
          // Liens d'épisode spécifique
          (entry.episode_id == episodeId || entry.episode == episodeId || entry.episode_number == episodeId) ||
          // Liens de saison complète (full_saison = 1)
          entry.full_saison == 1
        )
      );

      if (matching.length > 0) {
        foundEntries = [...foundEntries, ...matching];
      }

      // Pagination intelligente
      const nextPage = resp.data?.pagination?.next_page;
      if (!nextPage) {
        shouldContinue = false;
      } else {
        page = nextPage;
      }
    } catch (error) {
      const status = error.response?.status;
      if (status !== 404 && status !== 422) {
        console.error(`[ENHANCEMENT] Erreur lors de la recherche des liens (page ${page}, url: ${url}):`, error.message);
      }
      shouldContinue = false;
    }
  }

  return foundEntries;
}

// ---------------------------------------------------------------------------
// GET /download/:type/:id
// Récupérer tous les liens d'amélioration DarkiWorld pour un film ou un épisode
// Params: type (movie/tv), id (TMDB ID)
// Query: season (optionnel pour les séries), episode (optionnel pour les séries)
// ---------------------------------------------------------------------------
router.get('/download/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { season, episode } = req.query;

    // Validation
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Type invalide. Utilisez "movie" ou "tv"'
      });
    }

    if (type === 'tv' && (!season || !episode)) {
      return res.status(400).json({
        success: false,
        error: 'Pour les séries, les paramètres season et episode sont requis'
      });
    }

    // Generate cache key
    const cacheKey = generateCacheKey(`darkiworld_download_${type}_${id}${type === 'tv' ? `_${season}_${episode}` : ''}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
    let dataReturned = false;

    if (cachedData) {
      // console.log(`Résultats de téléchargement pour ${type}/${id} récupérés du cache`);
      res.status(200).json(cachedData); // Return cached data immediately
      dataReturned = true;
    }

    // Vérifier si l'utilisateur a accès premium (optionnel)
    const auth = await getAuthIfValid(req);
    const darkiworld_premium = auth && auth.userType === 'premium';

    let allEnhancementLinks = [];

    if (type === 'movie') {
      // Pour les films
      try {
        // 1. Récupérer tous les liens pour le film (pas seulement darkibox)
        const liensResp = await axiosDarkinoRequest({
          method: 'get',
          url: `/api/v1/liens?perPage=100&title_id=${id}&loader=linksdl&season=1&filters=&paginate=preferLengthAware`
        });

        const allEntries = liensResp.data?.pagination?.data || [];

        // Traiter directement les entrées sans faire de requête de décodage
        const enhancementSources = allEntries.map(entry => {
          if (!entry) return null;

          const hostInfo = entry.host;
          let embedUrl = null;
          let provider = hostInfo?.name || 'unknown';

          // Traitement spécial pour darkibox
          if (provider === 'darkibox') {
            // Pour darkibox, construire l'URL d'embed avec l'ID
            embedUrl = `https://darkibox.com/embed-${entry.id}.html`;
          } else {
            // Pour les autres providers, utiliser le lien direct s'il existe
            embedUrl = entry.lien || `https://darkibox.com/embed-${entry.id}.html`;
          }

          return {
            id: entry.id,
            language: (entry?.langues_compact && entry.langues_compact.length > 0)
              ? entry.langues_compact.map(l => l.name).join(', ')
              : undefined,
            quality: entry?.qual?.qual,
            sub: (entry?.subs_compact && entry.subs_compact.length > 0)
              ? entry.subs_compact.map(s => s.name).join(', ')
              : undefined,
            provider: provider,
            host_id: hostInfo?.id_host,
            host_name: hostInfo?.name,
            size: entry?.taille,
            upload_date: entry?.created_at,
            host_icon: hostInfo?.icon,
            view: entry?.view
          };
        });

        allEnhancementLinks = enhancementSources.filter(Boolean);
      } catch (err) {
        const status = err.response?.status;
        if (status !== 404 && status !== 422) {
          console.error(`[ENHANCEMENT] Erreur lors de la récupération des liens pour le film (id: ${id}, url: /api/v1/liens?perPage=100&title_id=${id}&loader=linksdl&season=1):`, err.message);
        }
      }

    } else {
      // Pour les séries (épisodes)
      try {
        // 1. Paginer intelligemment pour trouver l'épisode
        const allEntries = await findAllEntriesForEpisode({
          titleId: id,
          seasonId: parseInt(season),
          episodeId: parseInt(episode),
          perPage: 100,
          maxPages: 10
        });

        // Traiter directement les entrées sans faire de requête de décodage
        const enhancementSources = allEntries.map(entry => {
          if (!entry) return null;

          const hostInfo = entry.host;
          let embedUrl = null;
          let provider = hostInfo?.name || 'unknown';

          // Traitement spécial pour darkibox
          if (provider === 'darkibox') {
            // Pour darkibox, construire l'URL d'embed avec l'ID
            embedUrl = `https://darkibox.com/embed-${entry.id}.html`;
          } else {
            // Pour les autres providers, utiliser le lien direct s'il existe
            embedUrl = entry.lien || `https://darkibox.com/embed-${entry.id}.html`;
          }

          return {
            id: entry.id,
            language: (entry?.langues_compact && entry.langues_compact.length > 0)
              ? entry.langues_compact.map(l => l.name).join(', ')
              : undefined,
            quality: entry?.qual?.qual,
            sub: (entry?.subs_compact && entry.subs_compact.length > 0)
              ? entry.subs_compact.map(s => s.name).join(', ')
              : undefined,
            provider: provider,
            host_id: hostInfo?.id_host,
            host_name: hostInfo?.name,
            size: entry?.taille,
            upload_date: entry?.created_at,
            episode_id: entry?.episode_id,
            episode_number: entry?.episode_number,
            host_icon: hostInfo?.icon,
            view: entry?.view,
            saison: entry?.saison,
            episode: entry?.episode,
            full_saison: entry?.full_saison
          };
        });

        allEnhancementLinks = enhancementSources.filter(Boolean);
      } catch (err) {
        const status = err.response?.status;
        if (status !== 404 && status !== 422) {
          console.error(`[ENHANCEMENT] Erreur lors de la récupération des liens pour l'épisode (id: ${id}, season: ${season}, episode: ${episode}):`, err.message);
        }
      }
    }

    const responseData = {
      success: true,
      all: allEnhancementLinks
    };

    // Si on n'a pas encore retourné de données, retourner maintenant
    if (!dataReturned) {
      res.json(responseData);
    }

    // Background update du cache
    (async () => {
      try {
        // Vérifier si le cache doit être mis à jour
        const shouldUpdate = await shouldUpdateCache(DOWNLOAD_CACHE_DIR, cacheKey);
        if (!shouldUpdate) {
          return; // Ne pas mettre à jour le cache
        }

        // Si on a des données, sauvegarder dans le cache
        if (allEnhancementLinks && allEnhancementLinks.length > 0) {
          await saveToCache(DOWNLOAD_CACHE_DIR, cacheKey, responseData);
        }
      } catch (cacheError) {
        // Silent fail on cache save
      }
    })();

  } catch (error) {
    console.error('❌ Error fetching DarkiWorld enhancement links:', error);

    // Si Darkino retourne 500, ne pas créer/mettre à jour le cache et renvoyer le cache existant si présent
    if (error.response && error.response.status >= 500) {
      try {
        const fallbackCache = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
        if (fallbackCache) {
          return res.status(200).json(fallbackCache);
        }
      } catch (_) { }
    }

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des liens d\'amélioration DarkiWorld',
        message: error.message
      });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /decode/:id
// Extraire le lien décodé (m3u8) pour un ID de lien DarkiWorld
// Params: id (ID du lien DarkiWorld)
// ---------------------------------------------------------------------------
router.get('/decode/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'ID du lien requis'
      });
    }

    // Generate cache key
    const cacheKey = generateCacheKey(`darkiworld_decode_${id}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
    let dataReturned = false;
    let shouldDoBackgroundUpdate = false;

    if (cachedData) {
      // Vérifier si le lien en cache est un lien d'embed invalide
      const embedUrl = cachedData.embed_url || '';
      const isInvalidEmbedLink = /\/embed-\d+\.html$/i.test(embedUrl);

      if (isInvalidEmbedLink) {
        // Le cache contient un lien d'embed invalide, réessayer d'obtenir le bon lien
        console.warn(`[DECODE] Cache contient un lien d'embed invalide pour ${id}: ${embedUrl}`);
        // Ne pas retourner le cache, continuer pour refetch
      } else {
        // Cache valide, le retourner immédiatement
        res.status(200).json(cachedData);
        dataReturned = true;

        // Vérifier si on doit faire un background update (fichier modifié il y a plus de 24h)
        shouldDoBackgroundUpdate = await shouldUpdateCache24h(DOWNLOAD_CACHE_DIR, cacheKey);

        // Si pas besoin de background update, on s'arrête là
        if (!shouldDoBackgroundUpdate) {
          return;
        }
        // Sinon on continue pour faire le fetch en arrière-plan
      }
    }



    // Si pas de cache valide
    // Si en maintenance
    if (DARKINO_MAINTENANCE) {
      if (!dataReturned) {
        return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
      }
      return; // Si on a déjà retourné des données, on arrête juste le traitement (pas de background update)
    }

    // Fonction pour récupérer les données fraîches
    const fetchFreshData = async () => {
      let linkInfo = null;
      let embedUrl = null;
      let provider = 'unknown';
      let retryCount = 0;
      const maxRetries = 2;

      while (retryCount < maxRetries) {
        try {
          await refreshDarkinoSessionIfNeeded();

          const linkResp = await axiosDarkinoRequest({
            method: 'post',
            url: `/api/v1/liens/${id}/download`,
            data: { token: '' }
          });

          linkInfo = linkResp.data;
          provider = linkInfo?.host?.name || 'unknown';

          if (provider === 'darkibox') {
            const rawDarkiboxLink = typeof linkInfo?.lien === 'string' ? linkInfo.lien : '';
            const darkiboxCodeMatch = rawDarkiboxLink.match(/darkibox\.com\/(?:embed-)?([a-z0-9]{12,})(?:\.html)?/i);
            const darkiboxCode = darkiboxCodeMatch ? darkiboxCodeMatch[1] : null;
            embedUrl = darkiboxCode
              ? `https://darkibox.com/embed-${darkiboxCode}.html`
              : (rawDarkiboxLink || `https://darkibox.com/embed-${id}.html`);
          } else {
            embedUrl = linkInfo?.lien || `https://darkibox.com/embed-${id}.html`;
          }

          const isInvalidEmbedLink = /\/embed-\d+\.html$/i.test(embedUrl);

          if (isInvalidEmbedLink && retryCount < maxRetries - 1) {
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          } else if (isInvalidEmbedLink) {
            throw new Error('Lien d\'embed invalide');
          }

          break;
        } catch (err) {
          console.error(`[DARKIWORLD DECODE] Attempt ${retryCount + 1} failed for id=${id}:`, err.message);
          if (retryCount < maxRetries - 1) {
            retryCount++;
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          throw err;
        }
      }

      return {
        success: true,
        id: id,
        provider: provider,
        embed_url: embedUrl,
        metadata: linkInfo ? {
          language: (linkInfo?.langues_compact && linkInfo.langues_compact.length > 0)
            ? linkInfo.langues_compact.map(l => l.name).join(', ')
            : undefined,
          quality: linkInfo?.qual?.qual,
          sub: (linkInfo?.subs_compact && linkInfo.subs_compact.length > 0)
            ? linkInfo.subs_compact.map(s => s.name).join(', ')
            : undefined,
          size: linkInfo?.size,
          upload_date: linkInfo?.created_at
        } : null
      };
    };

    // Si on fait un background update (données déjà retournées au client)
    if (dataReturned && shouldDoBackgroundUpdate) {
      // Background update du cache
      (async () => {
        try {
          const freshData = await fetchFreshData();
          if (freshData && freshData.embed_url) {
            await saveToCache(DOWNLOAD_CACHE_DIR, cacheKey, freshData);
          }
        } catch (bgError) {
          // Silent fail on background update
        }
      })();
      return;
    }

    // Si on n'a pas encore retourné de données, faire le fetch normal
    try {
      const responseData = await fetchFreshData();

      // Retourner les données
      res.json(responseData);

      // Mise à jour du cache
      if (responseData.embed_url) {
        try {
          await saveToCache(DOWNLOAD_CACHE_DIR, cacheKey, responseData);
        } catch (cacheError) {
          // Silent fail on cache save
        }
      }
    } catch (fetchError) {
      console.error(`[DARKIWORLD DECODE] Erreur fetch pour id=${id}:`, fetchError.message);
      return res.status(404).json({
        success: false,
        error: 'Lien non trouvé ou inaccessible',
        id: id,
        debug: fetchError.message
      });
    }

  } catch (error) {
    if (res.headersSent) {
      console.error('❌ Error decoding DarkiWorld link (headers already sent):', error.message);
      return;
    }
    console.error('❌ Error decoding DarkiWorld link:', error);

    // Si Darkino retourne 500, ne pas créer/mettre à jour le cache et renvoyer le cache existant si présent
    if (error.response && error.response.status >= 500) {
      try {
        const fallbackCache = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
        if (fallbackCache) {
          return res.status(200).json(fallbackCache);
        }
      } catch (_) { }
    }

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors du décodage du lien DarkiWorld',
        message: error.message
      });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /seasons/:titleId
// Récupérer les saisons d'une série depuis DarkiWorld
// Params: titleId (ID DarkiWorld de la série)
// Query: page (optionnel, défaut: 1), perPage (optionnel, défaut: 8)
// ---------------------------------------------------------------------------
router.get('/seasons/:titleId', async (req, res) => {
  let cacheKey;
  let dataReturned = false;
  try {
    const { titleId } = req.params;
    const { page = 1, perPage = 8, mode = 'auto' } = req.query;

    if (!titleId) {
      return res.status(400).json({
        success: false,
        error: 'ID de la série requis'
      });
    }

    const currentPage = parsePositiveInt(page, 1);
    const itemsPerPage = parsePositiveInt(perPage, 8);
    const normalizedMode = mode === 'legacy' ? 'legacy' : mode === 'seasonPage' ? 'seasonPage' : 'auto';

    // Nouvelle clÃ© de cache pour Ã©viter de ressortir l'ancien format paginÃ©.
    cacheKey = generateCacheKey(`darkiworld_seasons_v2_${normalizedMode}_${titleId}_${currentPage}_${itemsPerPage}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);

    if (cachedData) {
      // console.log(`Saisons pour ${titleId} récupérées du cache`);
      res.status(200).json(cachedData); // Return cached data immediately
      dataReturned = true;
    }

    // Récupérer les saisons depuis DarkiWorld
    let responseData = null;

    if (normalizedMode !== 'legacy') {
      responseData = await fetchSeasonsCountResponse(titleId, currentPage, itemsPerPage);
    }

    if (!responseData) {
      responseData = await fetchLegacySeasonsPage(titleId, currentPage, itemsPerPage);
    }

    // Si on n'a pas encore retourné de données, retourner maintenant
    if (!dataReturned) {
      res.json(responseData);
    }

    // Background update du cache
    (async () => {
      try {
        // Vérifier si le cache doit être mis à jour
        const shouldUpdate = await shouldUpdateCache(DOWNLOAD_CACHE_DIR, cacheKey);
        if (!shouldUpdate) {
          return; // Ne pas mettre à jour le cache
        }

        // Si on a des données, sauvegarder dans le cache
        if (responseData && responseData.pagination) {
          await saveToCache(DOWNLOAD_CACHE_DIR, cacheKey, responseData);
        }
      } catch (cacheError) {
        // Silent fail on cache save
      }
    })();

  } catch (error) {

    // Si Darkino retourne 500, ne pas créer/mettre à jour le cache et renvoyer le cache existant si présent
    if (error.response && error.response.status >= 500) {
      // Si on a déjà retourné des données (cache), on ne fait RIEN
      if (dataReturned) return;

      try {
        const fallbackCache = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
        if (fallbackCache) {
          return res.status(200).json(fallbackCache);
        }
      } catch (_) { }
    }

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des saisons DarkiWorld',
        message: error.message
      });
    }
  }
});

// ---------------------------------------------------------------------------
// GET /episodes/:titleId/:seasonNumber
// Récupérer les épisodes d'une saison depuis DarkiWorld
// Params: titleId (ID DarkiWorld de la série), seasonNumber (numéro de la saison: 0, 1, 2, etc.)
// Query: page (optionnel, défaut: 1), perPage (optionnel, défaut: 30)
// ---------------------------------------------------------------------------
router.get('/episodes/:titleId/:seasonNumber', async (req, res) => {
  let dataReturned = false;
  try {
    const { titleId, seasonNumber } = req.params;
    const { page = 1, perPage = 30 } = req.query;

    if (!titleId || seasonNumber === undefined) {
      return res.status(400).json({
        success: false,
        error: 'ID de la série et numéro de saison requis'
      });
    }

    // Generate cache key
    const cacheKey = generateCacheKey(`darkiworld_episodes_${titleId}_${seasonNumber}_${page}_${perPage}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);

    if (cachedData) {
      // console.log(`Épisodes pour ${titleId}/${seasonNumber} récupérés du cache`);
      res.status(200).json(cachedData); // Return cached data immediately
      dataReturned = true;
    }

    // Récupérer les épisodes depuis DarkiWorld
    const episodesResponse = await axiosDarkinoRequest({
      method: 'get',
      url: `/api/v1/titles/${titleId}/seasons/${seasonNumber}/episodes?perPage=${perPage}&excludeDescription=true&query=&orderBy=episode_number&orderDir=asc&page=${page}`
    });

    const responseData = {
      success: true,
      ...episodesResponse.data
    };

    // Si on n'a pas encore retourné de données, retourner maintenant
    if (!dataReturned) {
      res.json(responseData);
    }

    // Background update du cache
    (async () => {
      try {
        // Vérifier si le cache doit être mis à jour
        const shouldUpdate = await shouldUpdateCache(DOWNLOAD_CACHE_DIR, cacheKey);
        if (!shouldUpdate) {
          return; // Ne pas mettre à jour le cache
        }

        // Si on a des données, sauvegarder dans le cache
        if (episodesResponse.data && episodesResponse.data.pagination) {
          await saveToCache(DOWNLOAD_CACHE_DIR, cacheKey, responseData);
        }
      } catch (cacheError) {
        // Silent fail on cache save
      }
    })();

  } catch (error) {

    // Si Darkino retourne 500, ne pas créer/mettre à jour le cache et renvoyer le cache existant si présent
    if (error.response && error.response.status >= 500) {
      // Si on a déjà retourné des données (cache), on ne fait RIEN
      if (dataReturned) return;

      try {
        const fallbackCache = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);
        if (fallbackCache) {
          return res.status(200).json(fallbackCache);
        }
      } catch (_) { }
    }

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des épisodes DarkiWorld',
        message: error.message
      });
    }
  }
});

module.exports = router;
module.exports.configure = configure;
module.exports.findAllEntriesForEpisode = findAllEntriesForEpisode;
