/**
 * Wiflix routes.
 * Extracted from server.js -- Wiflix search, player extraction, and routes.
 * Mount point: app.use('/api/wiflix', router)
 */

const express = require("express");
const router = express.Router();
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");
const fsp = require("fs").promises;

const { memoryCache } = require("../config/redis");
const {
  generateCacheKey,
  saveToCache,
} = require("../utils/cacheManager");
const {
  PROXIES,
  getProxyAgent,
  pickNextSocks5Proxy,
} = require("../utils/proxyManager");
const {
  fetchTmdbDetails,
  fetchTmdbSeason,
  fetchTmdbFrenchReleaseYear,
} = require("../utils/tmdbCache");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TMDB_API_URL = "https://api.themoviedb.org/3";
const WIFLIX_BASE_URL = "https://flemmix.farm";
const WIFLIX_PROXY_POOL_NAME = "WIFLIX_SOCKS5_PROXIES";
const WIFLIX_PROXY_MIN_INTERVAL_MS = 1000;
const WIFLIX_PROXY_WAIT_TIMEOUT_MS = 1100;

function hasWiflixProxyPool() {
  return Array.isArray(PROXIES) && PROXIES.length > 0;
}

async function pickNextWiflixProxy() {
  return pickNextSocks5Proxy({
    poolName: WIFLIX_PROXY_POOL_NAME,
    minIntervalMs: WIFLIX_PROXY_MIN_INTERVAL_MS,
    waitTimeoutMs: WIFLIX_PROXY_WAIT_TIMEOUT_MS,
  });
}

// === Cache helpers (local, since getFromCacheNoExpiration is not yet in cacheManager) ===
const getFromCacheNoExpiration = async (cacheDir, key) => {
  try {
    const memKey = `${cacheDir}:${key}`;
    const memData = await memoryCache.get(memKey);
    if (memData) return memData;

    const cacheFilePath = path.join(cacheDir, `${key}.json`);
    let fileContent;
    try {
      fileContent = await fsp.readFile(cacheFilePath, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }

    const cacheData = JSON.parse(fileContent);
    if (
      typeof cacheData === "string" ||
      cacheData === null ||
      cacheData === undefined
    ) {
      try {
        await fsp.unlink(cacheFilePath);
      } catch {}
      return null;
    }

    await memoryCache.set(memKey, cacheData);
    return cacheData;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    console.error(
      `Erreur lors de la recuperation du cache pour ${key}:`,
      error,
    );
    return null;
  }
};

// === Utility Functions ===
const normalizeString = (str) => {
  if (!str) return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const getLevenshteinSimilarity = (str1, str2) => {
  const s1 = normalizeString(str1);
  const s2 = normalizeString(str2);
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const matrix = [];
  for (let i = 0; i <= s2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      if (s2.charAt(i - 1) === s1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  const maxLength = Math.max(s1.length, s2.length);
  return maxLength === 0
    ? 1
    : (maxLength - matrix[s2.length][s1.length]) / maxLength;
};

function formatNextUpdate(ms) {
  if (ms <= 0) return 'imminent';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// === Search ===
async function searchWiflixMovie(title, baseUrl = WIFLIX_BASE_URL) {
  const searchUrl = `${baseUrl}/`;
  const payload = `do=search&subaction=search&story=${encodeURIComponent(title)}`;
  const searchHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Content-Type": "application/x-www-form-urlencoded",
    "Referer": baseUrl + "/",
    "Origin": baseUrl,
  };
  try {
    const proxyErrors = [];
    let responseBody = null;

    // Utiliser le prochain proxy SOCKS5 pour répartir les requêtes sur tout le pool
    const proxy = await pickNextWiflixProxy();
    if (proxy) {
      const proxyLabel = `${proxy.host}:${proxy.port}`;
      const agent = getProxyAgent(proxy);
      if (!agent) {
        proxyErrors.push(`${proxyLabel}: agent indisponible`);
      } else {
        try {
          const res = await axios({
            url: searchUrl,
            method: "POST",
            data: payload,
            headers: searchHeaders,
            timeout: 5000,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
            responseType: "text",
            decompress: true,
          });
          responseBody = res.data;
          console.log(`[WIFLIX SEARCH] OK via ${proxyLabel}`);
        } catch (err) {
          proxyErrors.push(`${proxyLabel}: ${err.message}`);
        console.log(`[WIFLIX SEARCH] ${proxyLabel} échoué: ${err.message}`);
        }
      }
    } else if (hasWiflixProxyPool()) {
      return {
        url: null,
        transient: true,
        debugHtml:
          "Pool sature: tous les proxies Wiflix sont occupes (1 req/s par proxy)",
      };
    }

    // Fallback direct (sans proxy)
    if (responseBody === null) {
      try {
        const res = await axios({
          url: searchUrl,
          method: "POST",
          data: payload,
          headers: searchHeaders,
          timeout: 5000,
          responseType: "text",
          decompress: true,
        });
        responseBody = res.data;
        console.log(`[WIFLIX SEARCH] OK direct`);
      } catch (err) {
        proxyErrors.push(`direct: ${err.message}`);
        return { url: null, debugHtml: `Toutes les tentatives ont échoué:\n${proxyErrors.join('\n')}` };
      }
    }

    if (!responseBody || responseBody.includes('Un instant, s\'il vous plaît')) {
      return { url: null, debugHtml: responseBody || `Proxies échoués:\n${proxyErrors.join('\n')}` };
    }

    const $ = cheerio.load(responseBody);
    const movBlocks = $("#dle-content div.mov");
    if (movBlocks.length === 0) return { url: null, debugHtml: responseBody };

    let bestMatch = null;
    let bestSimilarity = 0;

    movBlocks.each((_, block) => {
      const $block = $(block);
      const $titleLink = $block.find("a.mov-t");
      if (!$titleLink.length) return;

      const href = $titleLink.attr("href");
      if (!href) return;

      const resultTitle = $titleLink.text().trim();
      if (!resultTitle || resultTitle.length < 2) return;

      const resultTitleLower = resultTitle.toLowerCase();
      const hasBlockSai = $block.find(".block-sai").length > 0;
      const isSeries =
        href.includes("/serie-") ||
        resultTitleLower.includes("saison") ||
        /saison-\d+/i.test(href) ||
        hasBlockSai;
      const searchIsSeries = title.toLowerCase().includes("saison");

      if (searchIsSeries && !isSeries) return;
      if (!searchIsSeries && isSeries) return;

      if (searchIsSeries) {
        const searchSeasonMatch = title.match(/saison\s+(\d+)/i);
        if (searchSeasonMatch) {
          const searchSeason = parseInt(searchSeasonMatch[1]);

          let resultSeasonNum = null;
          const titleSeasonMatch = resultTitle.match(/saison\s+(\d+)/i);
          if (titleSeasonMatch) {
            resultSeasonNum = parseInt(titleSeasonMatch[1]);
          }
          if (resultSeasonNum === null) {
            const blockSaiText = $block.find(".block-sai").text().trim();
            const saiMatch =
              blockSaiText.match(/saison\s+(\d+)/i) ||
              blockSaiText.match(/^(\d+)/);
            if (saiMatch) {
              resultSeasonNum = parseInt(saiMatch[1]);
            }
          }
          if (resultSeasonNum === null) {
            const urlSeasonMatch = href.match(/saison-(\d+)/i);
            if (urlSeasonMatch) {
              resultSeasonNum = parseInt(urlSeasonMatch[1]);
            }
          }

          if (resultSeasonNum === null || searchSeason !== resultSeasonNum)
            return;
        }
      }

      const cleanSearchTitle = title
        .toLowerCase()
        .replace(/\s+saison\s+\d+/g, "")
        .trim();
      const cleanResultTitle = resultTitle
        .toLowerCase()
        .replace(/\s+saison\s+\d+/g, "")
        .trim();

      let similarity = 0;
      if (cleanResultTitle === cleanSearchTitle) {
        similarity = 1.0;
      } else {
        similarity = getLevenshteinSimilarity(
          cleanResultTitle,
          cleanSearchTitle,
        );
      }

      let fullUrl = href;
      if (fullUrl && !fullUrl.startsWith("http")) {
        fullUrl = fullUrl.startsWith("/")
          ? `${baseUrl}${fullUrl}`
          : `${baseUrl}/${fullUrl}`;
      }

      if (similarity >= 0.85 && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = fullUrl ? encodeURI(fullUrl) : fullUrl;
      }
    });

    return { url: bestMatch, debugHtml: bestMatch ? null : responseBody };
  } catch (error) {
    if (error.response?.status === 403) {
      console.error(
        `[WIFLIX SEARCH] 403 Forbidden pour "${title}" sur ${searchUrl}`,
      );
    }
    return { url: null, debugHtml: error.response?.data || `Erreur: ${error.message}` };
  }
}

// === Release Date Extraction ===
function extractWiflixReleaseDate($) {
  try {
    const releaseDateElement = $(
      "body > div:first-child > div > div > div > div > div > article > div:first-child > div:nth-child(2) > ul > li:nth-child(2) > div:nth-child(2)",
    );
    if (releaseDateElement.length > 0) {
      const dateText = releaseDateElement.text().trim();
      const yearMatch = dateText.match(/(\d{4})/);
      if (yearMatch) return parseInt(yearMatch[1]);
    }

    const fallbackSelectors = [
      "div.mov-desc",
      ".mov-desc",
      'li:contains("Annee") + li',
      'li:contains("Date") + li',
    ];
    for (const selector of fallbackSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        const text = element.text().trim();
        const yearMatch = text.match(/(\d{4})/);
        if (yearMatch) return parseInt(yearMatch[1]);
      }
    }
    return null;
  } catch (error) {
    console.error("[WIFLIX] Erreur lors de l'extraction de la date:", error);
    return null;
  }
}

// === Player Extraction ===
async function extractWiflixPlayers(pageUrl) {
  try {
    let rawHtml = null;
    const proxy = await pickNextWiflixProxy();
    if (proxy) {
      const agent = getProxyAgent(proxy);
      if (!agent) {
        console.log(
          `[WIFLIX PLAYERS] ${proxy.host}:${proxy.port} ignore: agent indisponible`,
        );
      } else {
        try {
          const res = await axios({
            url: pageUrl,
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
            },
            timeout: 5000,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
            responseType: "text",
            decompress: true,
          });
          rawHtml = res.data;
          console.log(`[WIFLIX PLAYERS] OK via ${proxy.host}:${proxy.port}`);
        } catch (err) {
          console.log(
            `[WIFLIX PLAYERS] ${proxy.host}:${proxy.port} echoue: ${err.message}`,
          );
        }
      }
    } else if (hasWiflixProxyPool()) {
      return {
        players: [],
        releaseYear: null,
        transient: true,
        debugHtml:
          "Tous les proxies Wiflix sont occupes (1 req/s par proxy)",
      };
    }
    if (!rawHtml) {
      // Fallback direct
      const res = await axios({ url: pageUrl, method: "GET", timeout: 5000, responseType: "text", decompress: true });
      rawHtml = res.data;
    }
    const $ = cheerio.load(rawHtml);
    const players = [];
    const releaseYear = extractWiflixReleaseDate($);

    const episodeDivs = $(
      'div[class*="ep"][class*="vf"], div[class*="ep"][class*="vs"]',
    );

    if (episodeDivs.length > 0) {
      episodeDivs.each((index, element) => {
        const $episodeDiv = $(element);
        const episodeClass = $episodeDiv.attr("class");
        const episodeMatch = episodeClass.match(/ep(\d+)(vf|vs)/);
        if (episodeMatch) {
          const episodeNumber = parseInt(episodeMatch[1]);
          const type = episodeMatch[2] === "vf" ? "VF" : "VOSTFR";
          $episodeDiv.find("a[onclick]").each((linkIndex, linkElement) => {
            const $link = $(linkElement);
            const onclick = $link.attr("onclick");
            const $span = $link.find("span.clichost");
            if (onclick && $span.length) {
              const match = onclick.match(/loadVideo\('(.+?)'\)/);
              if (match && match[1]) {
                let processedUrl = match[1];
                const name = $span.text().trim();
                if (processedUrl.includes("tipfly.xyz")) {
                  const tipflyMatch = processedUrl.match(
                    /tipfly\.xyz\/em-?\d+-(.+)/,
                  );
                  if (tipflyMatch && tipflyMatch[1])
                    processedUrl = `https://oneupload.net/embed-${tipflyMatch[1]}.html`;
                } else if (
                  name.toLowerCase() === "voe" ||
                  processedUrl.includes("jilliandescribecompany.com")
                ) {
                  processedUrl = processedUrl.replace(
                    /^https?:\/\/[^/]+/,
                    "https://voe.sx",
                  );
                }
                const domainMatch = processedUrl.match(
                  /https?:\/\/(?:www\.)?([^\/]+)/,
                );
                const domainName = domainMatch ? domainMatch[1] : name;
                players.push({
                  name: domainName,
                  url: processedUrl,
                  episode: episodeNumber,
                  type,
                });
              }
            }
          });
        }
      });
    } else {
      const filmLinks = $(".tabs-sel a[onclick]");
      filmLinks.each((index, element) => {
        const $link = $(element);
        const onclick = $link.attr("onclick");
        const $span = $link.find("span");
        if (onclick && $span.length) {
          const match = onclick.match(/loadVideo\('(.+?)'\)/);
          if (match && match[1]) {
            let processedUrl = match[1];
            const name = $span.text().trim();
            let type = "VF";
            if (name.toLowerCase().includes("vostfr")) type = "VOSTFR";
            if (processedUrl.includes("tipfly.xyz")) {
              const tipflyMatch = processedUrl.match(
                /tipfly\.xyz\/em-?\d+-(.+)/,
              );
              if (tipflyMatch && tipflyMatch[1])
                processedUrl = `https://oneupload.net/embed-${tipflyMatch[1]}.html`;
            } else if (
              name.toLowerCase() === "voe" ||
              processedUrl.includes("jilliandescribecompany.com")
            ) {
              processedUrl = processedUrl.replace(
                /^https?:\/\/[^/]+/,
                "https://voe.sx",
              );
            }
            const domainMatch = processedUrl.match(
              /https?:\/\/(?:www\.)?([^\/]+)/,
            );
            const domainName = domainMatch ? domainMatch[1] : name;
            players.push({
              name: domainName,
              url: processedUrl,
              episode: 1,
              type,
            });
          }
        }
      });
    }

    return { players, releaseYear, debugHtml: players.length === 0 ? rawHtml : null };
  } catch (error) {
    return {
      players: [],
      releaseYear: null,
      transient: false,
      debugHtml: error.response?.data || error.message || null,
    };
  }
}

function categorizeWiflixPlayers(players) {
  const vf = [];
  const vostfr = [];
  players.forEach((player) => {
    if (player.type === "VOSTFR") vostfr.push(player);
    else vf.push(player);
  });
  return { vf, vostfr };
}

// === Data Fetching ===
async function fetchWiflixMovieData(tmdbId, cachedData = null) {
  try {
    const tmdbData = await fetchTmdbDetails(
      TMDB_API_URL,
      TMDB_API_KEY,
      tmdbId,
      "movie",
      "fr-FR",
    );

    if (!tmdbData) {
      if (cachedData) return cachedData;
      return {
        success: false,
        error: "Film non trouve sur TMDB",
        tmdb_id: tmdbId,
      };
    }

    const originalData = tmdbData;
    const titlesToTry = [
      tmdbData.title,
      originalData.original_title,
      originalData.title,
    ]
      .filter(Boolean)
      .filter((title, index, arr) => arr.indexOf(title) === index);

    let movieUrl = null;
    let searchDebugHtml = null;
    for (const title of titlesToTry) {
      const searchResult = await searchWiflixMovie(title);
      if (searchResult.transient) {
        return {
          success: false,
          transient: true,
          error: "Pool proxy Wiflix temporairement sature",
          tmdb_id: tmdbId,
          titles_tried: titlesToTry,
          debugHtml: searchResult.debugHtml,
          retry_after_ms: WIFLIX_PROXY_WAIT_TIMEOUT_MS,
        };
      }
      if (searchResult.url) { movieUrl = searchResult.url; break; }
      searchDebugHtml = searchResult.debugHtml;
    }

    if (!movieUrl)
      return {
        success: false,
        error: "Film non trouve sur Wiflix",
        tmdb_id: tmdbId,
        titles_tried: titlesToTry,
        debugHtml: searchDebugHtml,
      };

    const extractionResult = await extractWiflixPlayers(movieUrl);
    if (extractionResult.transient) {
      return {
        success: false,
        transient: true,
        error: "Pool proxy Wiflix temporairement sature",
        tmdb_id: tmdbId,
        wiflix_url: movieUrl,
        debugHtml: extractionResult.debugHtml,
        retry_after_ms: WIFLIX_PROXY_WAIT_TIMEOUT_MS,
      };
    }
    const players = extractionResult.players;
    const wiflixReleaseYear = extractionResult.releaseYear;

    if (players.length === 0)
      return {
        success: false,
        error: "Aucun lecteur video trouve",
        tmdb_id: tmdbId,
        wiflix_url: movieUrl,
        debugHtml: extractionResult.debugHtml,
      };

    if (wiflixReleaseYear) {
      const frReleaseYear = await fetchTmdbFrenchReleaseYear(
        TMDB_API_URL,
        TMDB_API_KEY,
        tmdbId,
      );
      const tmdbReleaseYear =
        frReleaseYear ||
        (tmdbData.release_date
          ? new Date(tmdbData.release_date).getFullYear()
          : null);
      if (tmdbReleaseYear && wiflixReleaseYear !== tmdbReleaseYear) {
        console.log(
          `[WIFLIX MOVIE] Date mismatch: TMDB ${tmdbReleaseYear}${frReleaseYear ? " (FR)" : ""} vs Wiflix ${wiflixReleaseYear} pour ${tmdbData.title}`,
        );
        return {
          success: false,
          error: "Film non disponible sur Wiflix (date de sortie differente)",
          tmdb_id: tmdbId,
          wiflix_url: movieUrl,
          tmdb_release_year: tmdbReleaseYear,
          wiflix_release_year: wiflixReleaseYear,
        };
      }
    }

    const categorizedPlayers = categorizeWiflixPlayers(players);
    return {
      success: true,
      tmdb_id: tmdbId,
      title: tmdbData.title,
      original_title: originalData.original_title,
      wiflix_url: movieUrl,
      players: { vf: categorizedPlayers.vf, vostfr: categorizedPlayers.vostfr },
      cache_timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(
      `[WIFLIX MOVIE] Erreur dans fetchWiflixMovieData: ${error.message}`,
    );
    if (cachedData) {
      console.log(
        `[WIFLIX] Cache preserve malgre l'erreur pour movie ${tmdbId}`,
      );
      return cachedData;
    }
    return {
      success: false,
      error: "Erreur lors de la recuperation des donnees Wiflix",
      message: error.message,
      tmdb_id: tmdbId,
    };
  }
}

async function fetchWiflixTvData(tmdbId, season, cachedData = null) {
  try {
    const [tmdbData, seasonData] = await Promise.all([
      fetchTmdbDetails(TMDB_API_URL, TMDB_API_KEY, tmdbId, "tv", "fr-FR"),
      fetchTmdbSeason(TMDB_API_URL, TMDB_API_KEY, tmdbId, season, "fr-FR"),
    ]);
    const originalData = tmdbData;

    if (!tmdbData || !seasonData) {
      if (cachedData) return cachedData;
      return {
        success: false,
        error: "Serie ou saison non trouvee sur TMDB",
        tmdb_id: tmdbId,
        season,
      };
    }

    const titlesToTry = [
      tmdbData.name,
      originalData.original_name,
      originalData.name,
    ]
      .filter(Boolean)
      .filter((title, index, arr) => arr.indexOf(title) === index);

    let seriesUrl = null;
    let searchDebugHtml = null;
    for (const title of titlesToTry) {
      const searchResult = await searchWiflixMovie(`${title} saison ${season}`);
      if (searchResult.transient) {
        return {
          success: false,
          transient: true,
          error: "Pool proxy Wiflix temporairement sature",
          tmdb_id: tmdbId,
          season,
          titles_tried: titlesToTry,
          debugHtml: searchResult.debugHtml,
          retry_after_ms: WIFLIX_PROXY_WAIT_TIMEOUT_MS,
        };
      }
      if (searchResult.url) { seriesUrl = searchResult.url; break; }
      searchDebugHtml = searchResult.debugHtml;
    }

    if (!seriesUrl)
      return {
        success: false,
        error: "Serie non trouvee sur Wiflix",
        tmdb_id: tmdbId,
        season,
        titles_tried: titlesToTry,
        debugHtml: searchDebugHtml,
      };

    const extractionResult = await extractWiflixPlayers(seriesUrl);
    if (extractionResult.transient) {
      return {
        success: false,
        transient: true,
        error: "Pool proxy Wiflix temporairement sature",
        tmdb_id: tmdbId,
        season,
        wiflix_url: seriesUrl,
        debugHtml: extractionResult.debugHtml,
        retry_after_ms: WIFLIX_PROXY_WAIT_TIMEOUT_MS,
      };
    }
    const players = extractionResult.players;
    const wiflixReleaseYear = extractionResult.releaseYear;

    if (players.length === 0)
      return {
        success: false,
        error: "Aucun lecteur video trouve",
        tmdb_id: tmdbId,
        season,
        wiflix_url: seriesUrl,
        debugHtml: extractionResult.debugHtml,
      };

    if (wiflixReleaseYear) {
      const tmdbReleaseYear = seasonData.air_date
        ? new Date(seasonData.air_date).getFullYear()
        : null;
      if (tmdbReleaseYear && wiflixReleaseYear !== tmdbReleaseYear) {
        console.log(
          `[WIFLIX TV] Date mismatch: TMDB Season ${season} (${tmdbReleaseYear}) vs Wiflix ${wiflixReleaseYear} pour ${tmdbData.name}`,
        );
        return {
          success: false,
          error: "Serie non disponible sur Wiflix (date de sortie differente)",
          tmdb_id: tmdbId,
          season,
          wiflix_url: seriesUrl,
          tmdb_release_year: tmdbReleaseYear,
          wiflix_release_year: wiflixReleaseYear,
        };
      }
    }

    const episodes = {};
    players.forEach((player) => {
      const episodeNum = player.episode;
      if (!episodes[episodeNum]) episodes[episodeNum] = { vf: [], vostfr: [] };
      if (player.type === "VOSTFR") episodes[episodeNum].vostfr.push(player);
      else episodes[episodeNum].vf.push(player);
    });

    return {
      success: true,
      tmdb_id: tmdbId,
      title: tmdbData.name,
      original_title: originalData.original_name,
      season: parseInt(season),
      wiflix_url: seriesUrl,
      episodes,
      cache_timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`[WIFLIX TV] Erreur: ${error.message}`);
    if (cachedData) {
      console.log(
        `[WIFLIX] Cache preserve malgre l'erreur pour tv ${tmdbId} saison ${season}`,
      );
      return cachedData;
    }
    return {
      success: false,
      error: "Erreur lors de la recuperation des donnees Wiflix",
      message: error.message,
      tmdb_id: tmdbId,
      season,
    };
  }
}

// === Background Cache Update ===
const updateWiflixCache = async (
  cacheDir,
  cacheKey,
  type,
  tmdbId,
  season = null,
) => {
  try {
    const existingCache = await getFromCacheNoExpiration(cacheDir, cacheKey);
    let attempts = 0;
    const maxAttempts = 1;
    let lastError = null;

    while (attempts < maxAttempts) {
      try {
        let newData;
        if (type === "movie")
          newData = await fetchWiflixMovieData(tmdbId, existingCache);
        else if (type === "tv")
          newData = await fetchWiflixTvData(tmdbId, season, existingCache);
        else throw new Error(`Type non supporte: ${type}`);

        if (newData?.transient) {
          return;
        }

        if (
          typeof newData === "string" &&
          newData.includes("Maintenance en cours")
        )
          throw new Error("Maintenance en cours - donnees invalides");
        if (
          typeof newData === "string" ||
          newData === null ||
          newData === undefined
        )
          throw new Error("Donnees invalides - non-JSON");

        if (newData) {
          const isFailedResult = newData.success === false;
          if (isFailedResult && existingCache?.success) return;
          if (newData.success) {
            const { debugHtml: _dh, ...cacheableData } = newData;
            await saveToCache(cacheDir, cacheKey, cacheableData);
          } else {
            await saveToCache(cacheDir, cacheKey, newData);
          }
          return;
        }
        break;
      } catch (error) {
        attempts++;
        lastError = error;
        if (error.response && error.response.status === 403) break;
        if (
          (error.response && error.response.status >= 500) ||
          !error.response
        ) {
          const delay = 2000 * attempts;
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          break;
        }
      }
    }
  } catch (error) {
    // Background error, ignore
  }
};

// === Routes ===

// GET /movie/:tmdbId
router.get("/movie/:tmdbId", async (req, res) => {
  const { tmdbId } = req.params;
  const cacheKey = generateCacheKey(`wiflix_movie_${tmdbId}`);
  const cacheDir = path.join(__dirname, "..", "cache", "wiflix");

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    let dataReturned = false;

    if (cachedData) {
      const RECENT_UPDATE_THRESHOLD = cachedData.success === false
        ? 5 * 60 * 1000
        : 1 * 60 * 60 * 1000;
      const cachePath = path.join(cacheDir, `${cacheKey}.json`);
      let nextUpdateIn = null;
      let shouldSkipUpdate = false;
      try {
        const stats = await fsp.stat(cachePath);
        const remaining = RECENT_UPDATE_THRESHOLD - (Date.now() - stats.mtime.getTime());
        if (remaining > 0) {
          shouldSkipUpdate = true;
          nextUpdateIn = formatNextUpdate(remaining);
        } else {
          nextUpdateIn = 'imminent';
        }
      } catch (e) {}

      res.status(200).json({ ...cachedData, next_update_in: nextUpdateIn });
      dataReturned = true;

      if (!shouldSkipUpdate)
        updateWiflixCache(cacheDir, cacheKey, "movie", tmdbId);
    }

    if (!dataReturned) {
      const result = await fetchWiflixMovieData(tmdbId, null);
      if (result.transient) {
        res.status(503).json(result);
      } else if (result.success) {
        const { debugHtml: _dh, ...cacheableResult } = result;
        await saveToCache(cacheDir, cacheKey, cacheableResult);
        res.json({ ...cacheableResult, next_update_in: '60m 0s' });
      } else {
        await saveToCache(cacheDir, cacheKey, result);
        res.status(404).json(result);
      }
    }
  } catch (error) {
    console.error(`[WIFLIX MOVIE] Erreur: ${error.message}`);
    res
      .status(500)
      .json({
        success: false,
        error: "Erreur lors de la recuperation des donnees Wiflix",
        message: error.message,
        tmdb_id: tmdbId,
      });
  }
});

// GET /tv/:tmdbId/:season
router.get("/tv/:tmdbId/:season", async (req, res) => {
  const { tmdbId, season } = req.params;
  const cacheKey = generateCacheKey(`wiflix_tv_${tmdbId}_${season}`);
  const cacheDir = path.join(__dirname, "..", "cache", "wiflix");

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    let dataReturned = false;

    if (cachedData) {
      const RECENT_UPDATE_THRESHOLD = cachedData.success === false
        ? 5 * 60 * 1000
        : 1 * 60 * 60 * 1000;
      const cachePath = path.join(cacheDir, `${cacheKey}.json`);
      let nextUpdateIn = null;
      let shouldSkipUpdate = false;
      try {
        const stats = await fsp.stat(cachePath);
        const remaining = RECENT_UPDATE_THRESHOLD - (Date.now() - stats.mtime.getTime());
        if (remaining > 0) {
          shouldSkipUpdate = true;
          nextUpdateIn = formatNextUpdate(remaining);
        } else {
          nextUpdateIn = 'imminent';
        }
      } catch (e) {}

      res.json({ ...cachedData, next_update_in: nextUpdateIn });
      dataReturned = true;

      if (!shouldSkipUpdate)
        updateWiflixCache(cacheDir, cacheKey, "tv", tmdbId, season);
    }

    if (!dataReturned) {
      const result = await fetchWiflixTvData(tmdbId, season, null);
      if (result.transient) {
        res.status(503).json(result);
      } else if (result.success) {
        const { debugHtml: _dh, ...cacheableResult } = result;
        await saveToCache(cacheDir, cacheKey, cacheableResult);
        res.json({ ...cacheableResult, next_update_in: '60m 0s' });
      } else {
        await saveToCache(cacheDir, cacheKey, result);
        res.status(404).json(result);
      }
    }
  } catch (error) {
    console.error(`[WIFLIX TV] Erreur: ${error.message}`);
    res
      .status(500)
      .json({
        success: false,
        error: "Erreur lors de la recuperation des donnees Wiflix",
        message: error.message,
        tmdb_id: tmdbId,
        season,
      });
  }
});

module.exports = router;
