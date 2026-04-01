const cluster = require('cluster');
const os = require('os');
require('dotenv').config();

// === CLUSTER MODE CONFIGURATION (au tout début pour éviter que le master charge tout) ===
const NUM_WORKERS = parseInt(process.env.NUM_WORKERS) || 6; // 6 cœurs physiques sur le serveur

if (cluster.isPrimary ?? cluster.isMaster) {
  // === MODE MASTER — ne charge RIEN d'autre (pas de MySQL, Redis, Express, etc.) ===
  console.log(`🚀 Master process ${process.pid} démarré en mode cluster`);
  console.log(`📊 Création de ${NUM_WORKERS} workers...`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = cluster.fork();
    console.log(`✅ Worker ${worker.process.pid} créé (${i + 1}/${NUM_WORKERS})`);
  }

  // Anti-fork-bomb : limiter les redémarrages rapides
  const workerRestarts = new Map(); // pid -> [timestamps]
  const MAX_RESTARTS = 5;
  const RESTART_WINDOW_MS = 60000; // 1 minute
  let isShuttingDown = false; // Flag pour empêcher le redémarrage des workers pendant le shutdown

  cluster.on('exit', (worker, code, signal) => {
    if (signal) {
      console.warn(`⚠️ Worker ${worker.process.pid} tué par le signal ${signal}`);
    } else if (code !== 0) {
      console.error(`❌ Worker ${worker.process.pid} terminé avec le code ${code}`);
    } else {
      console.log(`ℹ️ Worker ${worker.process.pid} terminé normalement`);
    }

    // Ne pas redémarrer les workers si le master est en cours d'arrêt
    if (isShuttingDown) {
      console.log(`🛑 Shutdown en cours — worker ${worker.process.pid} ne sera pas redémarré`);
      return;
    }

    // Vérifier le taux de redémarrage pour éviter la boucle infinie
    const now = Date.now();
    const restarts = workerRestarts.get('global') || [];
    const recentRestarts = restarts.filter(t => now - t < RESTART_WINDOW_MS);
    recentRestarts.push(now);
    workerRestarts.set('global', recentRestarts);

    if (recentRestarts.length > MAX_RESTARTS) {
      console.error(`🚨 Trop de redémarrages (${recentRestarts.length} en ${RESTART_WINDOW_MS / 1000}s) — arrêt du fork`);
      return;
    }

    console.log(`🔄 Redémarrage d'un nouveau worker...`);
    const newWorker = cluster.fork();
    console.log(`✅ Nouveau worker ${newWorker.process.pid} créé`);
  });

  // Graceful shutdown master
  const shutdownMaster = () => {
    isShuttingDown = true;
    console.log('\n🛑 Signal de fermeture reçu par le master...');
    console.log('📤 Envoi du signal de fermeture à tous les workers...');
    for (const id in cluster.workers) {
      cluster.workers[id].send('shutdown');
    }
    let workersAlive = Object.keys(cluster.workers).length;
    const checkInterval = setInterval(() => {
      workersAlive = Object.keys(cluster.workers).length;
      if (workersAlive === 0) {
        clearInterval(checkInterval);
        console.log('✅ Tous les workers sont arrêtés. Arrêt du master.');
        process.exit(0);
      }
    }, 100);
    setTimeout(() => {
      console.warn('⚠️ Timeout atteint (30s). Arrêt forcé du master.');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', shutdownMaster);
  process.on('SIGINT', shutdownMaster);

  console.log(`
╔═══════════════════════════════════════════════════════╗
║  🎯 Mode Cluster Actif                                ║
║  👷 Workers: ${NUM_WORKERS.toString().padEnd(42, ' ')}║
║  🔒 Redis Locks: Verrous distribués entre workers    ║
║  ⚛️  Atomic writes: Garantis entre les processus      ║
╚═══════════════════════════════════════════════════════╝
  `);

  // Le master ne fait RIEN d'autre — pas de require express, mysql, etc.
  return;
}

// === CODE WORKER UNIQUEMENT (ci-dessous) ===
process.env.UV_THREADPOOL_SIZE = 8; // 8 threads libuv par worker (6 workers × 8 = 48 threads total)
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const cheerio = require('cheerio');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Buffer } = require('buffer');
const { v4: uuidv4 } = require('uuid');
const bip39 = require('bip39');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const iconv = require('iconv-lite');
const chardet = require('chardet');
const Redis = require('ioredis');
const http = require('http');
const https = require('https');

// === DISCORD WEBHOOK POUR LES ERREURS DE SYNC ===
const SYNC_ERROR_WEBHOOK = process.env.DISCORD_SYNC_ERROR_WEBHOOK_URL;

async function logSyncErrorToDiscord(errorMessage, context = {}) {
  if (!SYNC_ERROR_WEBHOOK) return; // Skip if webhook not configured
  try {
    const embed = {
      title: '❌ Erreur de Sync',
      color: 0xff0000,
      description: errorMessage,
      fields: [
        { name: 'User Type', value: context.userType || 'N/A', inline: true },
        { name: 'User ID', value: context.userId ? `\`${context.userId.substring(0, 8)}...\`` : 'N/A', inline: true },
        { name: 'Profile ID', value: context.profileId ? `\`${context.profileId.substring(0, 8)}...\`` : 'N/A', inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Movix Sync API' }
    };

    if (context.error) {
      embed.fields.push({ name: 'Détails Erreur', value: `\`\`\`${String(context.error).substring(0, 500)}\`\`\``, inline: false });
    }

    if (context.payload) {
      // Tronquer le payload pour éviter de dépasser la limite Discord (1024 chars par field)
      const payloadStr = JSON.stringify(context.payload, null, 2);
      const truncatedPayload = payloadStr.length > 900 ? payloadStr.substring(0, 900) + '\n... (tronqué)' : payloadStr;
      embed.fields.push({ name: 'Payload Requête', value: `\`\`\`json\n${truncatedPayload}\`\`\``, inline: false });
    }

    await axios.post(SYNC_ERROR_WEBHOOK, { embeds: [embed] }, { timeout: 5000 }).catch(() => { });
  } catch (e) {
    // Silently fail - don't break sync if webhook fails
  }
}

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

// === REDIS DISTRIBUTED LOCK (remplace proper-lockfile) ===
// Utilise SET NX EX pour un verrou atomique avec TTL auto-expiration.
// Plus fiable que les lockfiles filesystem (pas de .lock orphelins, fonctionne en cluster).
const LOCK_PREFIX = 'lock:';
const LOCK_DEFAULT_TTL = 10; // secondes — TTL auto-expiration du verrou
const LOCK_RETRY_DELAY = 100; // ms entre chaque tentative
const LOCK_MAX_RETRIES = 50; // 50 × 100ms = 5s max d'attente

/**
 * Acquiert un verrou distribué Redis sur une clé donnée.
 * @param {string} resourceKey - Identifiant unique de la ressource (ex: chemin de fichier)
 * @param {object} opts - Options : ttl (sec), retries, retryDelay (ms)
 * @returns {Promise<{release: Function}|null>} - Objet avec release(), ou null si échec
 */
async function acquireRedisLock(resourceKey, opts = {}) {
  const ttl = opts.ttl || LOCK_DEFAULT_TTL;
  const retries = opts.retries ?? LOCK_MAX_RETRIES;
  const retryDelay = opts.retryDelay || LOCK_RETRY_DELAY;
  const lockKey = LOCK_PREFIX + resourceKey;
  const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // SET key value NX EX ttl — atomique, ne set que si la clé n'existe pas
      const result = await redis.set(lockKey, lockValue, 'EX', ttl, 'NX');
      if (result === 'OK') {
        // Verrou acquis — retourner une fonction release sécurisée
        return {
          release: async () => {
            try {
              // Script Lua atomique : ne supprime que si la valeur correspond (évite de libérer le lock d'un autre process)
              const luaScript = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                  return redis.call("del", KEYS[1])
                else
                  return 0
                end
              `;
              await redis.eval(luaScript, 1, lockKey, lockValue);
            } catch (e) {
              console.warn(`[RedisLock] Erreur release ${resourceKey}:`, e.message);
            }
          }
        };
      }
    } catch (err) {
      // Redis indisponible — on abandonne immédiatement
      console.warn(`[RedisLock] Redis indisponible pour ${resourceKey}:`, err.message);
      return null;
    }

    // Attendre avant de réessayer
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  // Timeout — impossible d'acquérir le verrou
  console.warn(`[RedisLock] Timeout: impossible d'acquérir le verrou pour ${resourceKey} après ${retries} tentatives`);
  return null;
}

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

// === LIMITEUR DE CONCURRENCE (p-limit style) ===
// Fonction pour limiter le nombre de promesses exécutées en parallèle
function createConcurrencyLimiter(concurrency) {
  const queue = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()();
    }
  };

  const run = async (fn) => {
    activeCount++;
    try {
      return await fn();
    } finally {
      next();
    }
  };

  const enqueue = (fn) => {
    return new Promise((resolve, reject) => {
      const task = () => run(fn).then(resolve, reject);
      if (activeCount < concurrency) {
        task();
      } else {
        queue.push(task);
      }
    });
  };

  return enqueue;
}

// Limiteurs pré-configurés pour différents cas d'usage
const limitConcurrency5 = createConcurrencyLimiter(5);   // Pour les requêtes réseau légères
const limitConcurrency3 = createConcurrencyLimiter(3);   // Pour les requêtes réseau lourdes
const limitConcurrency10 = createConcurrencyLimiter(10); // Pour les opérations I/O locales

// === CACHE POUR LES AGENTS PROXY ===
const proxyAgentCache = new Map();
const darkinoProxyAgentCache = new Map();

// Initialize global agent keep-alive for better performance
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;
const writeFileAtomic = require('write-file-atomic');
bip39.setDefaultWordlist('french');


// === MYSQL DATABASE CONNECTION ===
const mysql = require('mysql2/promise');
const wrappedRoutes = require('./wrappedRoutes'); // Wrapped Routes
const { verifyAccessKey, vipMiddleware, invalidateVipCache, invalidateAllVipCache } = require('./checkVip');
// === JWT AUTHENTICATION HELPERS ===
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not defined in .env");
  process.exit(1);
}
function issueJwt(userType, userId, sessionId) {
  // Issue a token without expiration (no exp claim)
  return jwt.sign({ sub: userId, userType, sessionId }, JWT_SECRET, { algorithm: 'HS256' });
}

// ===== FONCTIONS SÉCURISÉES POUR LES ÉCRITURES DE FICHIERS =====

/**
 * Écriture sécurisée avec verrou de fichier et écriture atomique
 * @param {string} filePath - Chemin du fichier à écrire
 * @param {string|Buffer} data - Données à écrire
 * @param {object} options - Options pour l'écriture
 * @returns {Promise<boolean>} - Succès de l'opération
 */
async function safeWriteFile(filePath, data, options = {}) {
  const defaultOptions = {
    encoding: 'utf8',
    mode: 0o644,
    lockTtl: 10,     // TTL du verrou Redis en secondes
    retries: 3,
    retryDelay: 100
  };

  const finalOptions = { ...defaultOptions, ...options };
  let lock = null;

  try {
    // Créer le répertoire parent si nécessaire
    await fsp.mkdir(path.dirname(filePath), { recursive: true });

    // Tentative d'acquisition du verrou Redis (avec fallback si échec)
    // Clé de lock basée sur le chemin absolu normalisé
    const lockResource = path.resolve(filePath).replace(/\\/g, '/');
    lock = await acquireRedisLock(lockResource, {
      ttl: finalOptions.lockTtl,
      retries: finalOptions.retries * 10, // plus de tentatives car Redis est rapide
      retryDelay: finalOptions.retryDelay
    });

    if (!lock) {
      // Redis indisponible ou timeout — on continue l'écriture sans verrou
      console.warn(`[SafeWriteFile] AVERTISSEMENT: Impossible de verrouiller ${path.basename(filePath)} via Redis, écriture forcée sans verrou.`);
    }

    // Écrire le fichier de manière atomique (même si le lock a échoué)
    // flush: false désactive fsync pour améliorer les performances sur software RAID
    await writeFileAtomic(filePath, data, {
      encoding: finalOptions.encoding,
      mode: finalOptions.mode,
      fsync: false // Désactiver fsync pour perf sur software RAID OVH
    });

    return true;
  } catch (error) {
    console.error(`[SafeWriteFile] Échec pour ${filePath}:`, error.message, error.code || '');
    return false;
  } finally {
    // Libérer le verrou Redis si acquis
    if (lock) {
      try {
        await lock.release();
      } catch (releaseError) {
        console.error(`[SafeWriteFile] Erreur release Redis lock pour ${filePath}:`, releaseError);
      }
    }
  }
}

/**
 * Écriture sécurisée de données JSON avec verrou de fichier et écriture atomique
 * @param {string} filePath - Chemin du fichier à écrire
 * @param {object} data - Objet JSON à écrire
 * @param {object} options - Options pour l'écriture
 * @returns {Promise<boolean>} - Succès de l'opération
 */
async function safeWriteJsonFile(filePath, data, options = {}) {
  const jsonOptions = {
    ...options,
    encoding: 'utf8'
  };

  try {
    const jsonString = JSON.stringify(data);
    return await safeWriteFile(filePath, jsonString, jsonOptions);
  } catch (error) {
    console.error(`Erreur lors de la sérialisation JSON pour ${filePath}:`, error);
    return false;
  }
}

/**
 * Lecture sécurisée avec verrou de fichier
 * @param {string} filePath - Chemin du fichier à lire
 * @param {object} options - Options pour la lecture
 * @returns {Promise<object|null>} - Données lues ou null en cas d'erreur
 */
async function safeReadJsonFile(filePath, options = {}) {
  const defaultOptions = {
    encoding: 'utf8',
    retries: 2,
    retryDelay: 50
  };

  const finalOptions = { ...defaultOptions, ...options };

  // Petite boucle de retry en cas d'accès concurrentiel très rare
  for (let attempt = 0; attempt <= finalOptions.retries; attempt++) {
    try {
      const fileContent = await fsp.readFile(filePath, finalOptions.encoding);
      try {
        return JSON.parse(fileContent);
      } catch (parseError) {
        // Si JSON temporairement invalide, réessayer brièvement
        if (attempt < finalOptions.retries) {
          await new Promise(r => setTimeout(r, finalOptions.retryDelay));
          continue;
        }
        console.error(`Erreur de parse JSON pour ${filePath}:`, parseError);
        return null;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null; // Fichier absent
      }
      if (attempt < finalOptions.retries) {
        await new Promise(r => setTimeout(r, finalOptions.retryDelay));
        continue;
      }
      console.error(`Erreur lors de la lecture de ${filePath}:`, error);
      return null;
    }
  }
  return null;
}

const DARKINO_MAINTENANCE = false; // Passe à true pour activer le mode maintenance


// Base URLs
const COFLIX_BASE_URL = 'https://coflix.ninja';
const COFLIX_SEARCH_URL = `${COFLIX_BASE_URL}/?s=`;

// Anime Sama API Configuration
const ANIME_SAMA_URL = "https://anime-sama.tv/";
const ANIME_SAMA_CACHE_DIR = path.join(__dirname, 'cache', 'anime-sama');

const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_API_URL = 'https://api.themoviedb.org/3';


// === PROXY CONFIGURATION ===

const ENABLE_DARKINO_PROXY = true; // Passe à false pour désactiver le proxy pour Darkino
const ENABLE_COFLIX_PROXY = true;  // Passe à false pour désactiver le proxy pour Coflix
const ENABLE_FRENCH_STREAM_PROXY = true;  // Active/désactive le proxy pour French-Stref
const ENABLE_LECTEURVIDEO_PROXY = true;   // Active/désactive le proxy pour LecteurVideo
const ENABLE_FSTREAM_PROXY = true;   // Active/désactive le proxy pour FStream
const ENABLE_ANIME_PROXY = true;   // Active/désactive le proxy pour AnimeSama (via Cloudflare Workers)
const ENABLE_WIFLIX_PROXY = true;   // Active/désactive le proxy pour Wiflix

// Constante pour l'enhancement Darkino
const darkiworld_premium = false; // Passe à false pour désactiver l'enhancement Darkino

// === DARKINO 403 COOLDOWN ===
// Cooldown de 5 minutes après une erreur 403 (Cloudflare challenge)
const DARKINO_403_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let darkino403CooldownUntil = 0; // Timestamp jusqu'auquel on ne fait plus de requêtes

// === CPASMAL CONFIGURATION ===
const CPASMAL_BASE_URL = 'https://www.cpasmal.rip';

const cpasmalJar = new tough.CookieJar(null, { rejectPublicSuffixes: false });

// === CPASMAL GLOBAL CONCURRENCY LIMITER (Semaphore) ===
// Limite le nombre de requêtes Cpasmal simultanées pour éviter de bloquer le serveur
const CPASMAL_MAX_CONCURRENT = 4; // Max 4 requêtes Cpasmal en parallèle
let cpasmalActivRequests = 0;
const cpasmalQueue = [];

async function acquireCpasmalSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (cpasmalActivRequests < CPASMAL_MAX_CONCURRENT) {
        cpasmalActivRequests++;
        resolve();
      } else {
        cpasmalQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseCpasmalSlot() {
  cpasmalActivRequests--;
  if (cpasmalQueue.length > 0) {
    const next = cpasmalQueue.shift();
    next();
  }
}

// Cache pour les agents SOCKS5 Cpasmal (Keep-Alive)
const cpasmalAgentCache = new Map();

function getCpasmalAgent(proxy) {
  if (!proxy) return null;
  const cacheKey = `${proxy.type}:${proxy.host}:${proxy.port}:${proxy.auth}`;

  if (cpasmalAgentCache.has(cacheKey)) {
    return cpasmalAgentCache.get(cacheKey);
  }

  // Configuration Keep-Alive optimisée
  const agentOpts = {
    keepAlive: true,
    keepAliveMsecs: 15000, // 15s keep-alive
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 30000
  };

  let agent;
  if (proxy.type === 'socks5' || proxy.type === 'socks5h') {
    const info = {
      hostname: proxy.host,
      port: proxy.port,
      protocol: 'socks:',
      tls: { rejectUnauthorized: false },
      ...agentOpts
    };

    // Auth handling
    if (proxy.auth) {
      const parts = proxy.auth.split(':');
      info.username = parts[0]; // Correction: userId -> username
      info.password = parts[1];
    }

    agent = new SocksProxyAgent(info);
  }

  if (agent) {
    cpasmalAgentCache.set(cacheKey, agent);
  }
  return agent;
}

// Fonction pour faire des requêtes vers Cpasmal avec rotation de proxies SOCKS5
async function axiosCpasmalRequest(config) {
  const urlStr = config.url || '';

  // Constante pour Cpasmal Base URL si relative
  const baseURL = CPASMAL_BASE_URL;

  // Headers par défaut
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    ...(config.headers || {})
  };

  // Gestion des cookies (récupération)
  // Gestion des cookies (récupération manuelle pour compatibilité avec proxy agent)
  if (urlStr || config.baseURL) {
    try {
      // Reconstitution approximative de l'URL pour les cookies
      const targetUrl = urlStr.startsWith('http') ? urlStr : (config.baseURL || baseURL) + urlStr;
      const cookieString = await cpasmalJar.getCookieString(targetUrl);
      if (cookieString) {
        defaultHeaders['Cookie'] = cookieString;
      }
    } catch (err) {
      console.error('[Cpasmal CookieJar] Error getting cookies:', err);
    }
  }

  // Choix d'un proxy SOCKS5h aléatoire (une seule fois)
  const proxy = pickRandomProxyOrNone();
  const agent = getCpasmalAgent(proxy);

  try {
    if (process.env.DEBUG_CPASMAL === 'true') console.time(`[Cpasmal] Request ${urlStr} (Proxy: ${proxy ? proxy.host : 'Direct'})`);

    const response = await axios({
      ...config,
      headers: defaultHeaders,
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      timeout: config.timeout || 5000,
      decompress: true
    });

    if (process.env.DEBUG_CPASMAL === 'true') console.timeEnd(`[Cpasmal] Request ${urlStr} (Proxy: ${proxy ? proxy.host : 'Direct'})`);

    // Gestion des cookies (sauvegarde manuelle)
    if (response.headers['set-cookie']) {
      const cookies = response.headers['set-cookie'];
      const url = response.config.url;
      try {
        if (Array.isArray(cookies)) {
          for (const cookie of cookies) {
            await cpasmalJar.setCookie(cookie, url);
          }
        } else {
          await cpasmalJar.setCookie(cookies, url);
        }
      } catch (err) {
        console.error('[Cpasmal CookieJar] Error setting cookies:', err);
      }
    }

    return response;
  } catch (error) {
    // Ajouter infos debug
    error.cpasmalUrl = urlStr;
    error.cpasmalProxy = proxy ? `${proxy.host}:${proxy.port}` : 'Direct';

    // Propager l'erreur immédiatement
    throw error;
  }
}



// === CLOUDFLARE WORKERS PROXIES CONFIGURATION ===
const CLOUDFLARE_WORKERS_PROXIES = (process.env.CLOUDFLARE_WORKERS_PROXIES || '')
  .split(',')
  .map(proxy => proxy.trim())
  .filter(Boolean);

// === CACHE POUR LES PROXIES CLOUDFLARE EN ERREUR ===
// Cache pour mémoriser les proxies en erreur (429, 500, timeout, etc.)
// Les proxies en erreur seront ignorés pendant PROXY_ERROR_COOLDOWN_MS millisecondes
const proxyErrorCache = new Map(); // Map<proxyUrl, { errorTime: timestamp, errorCode: number|string, errorCount: number }>
const PROXY_ERROR_COOLDOWN_MS = 60000; // 60 secondes de cooldown pour un proxy en erreur
const PROXY_ERROR_COOLDOWN_429_MS = 120000; // 2 minutes de cooldown spécifique pour erreur 429 (rate limit)
const PROXY_ERROR_COOLDOWN_5XX_MS = 90000; // 1.5 minutes pour les erreurs serveur (500, 502, 503, 504)
const MAX_CONSECUTIVE_ERRORS = 3; // Nombre max d'erreurs consécutives avant cooldown prolongé
const PROXY_EXTENDED_COOLDOWN_MS = 300000; // 5 minutes de cooldown prolongé si trop d'erreurs consécutives

/**
 * Marque un proxy comme étant en erreur
 * @param {string} proxyUrl - URL du proxy
 * @param {number|string} errorCode - Code d'erreur (429, 500, 'timeout', etc.)
 */
function markProxyAsErrored(proxyUrl, errorCode) {
  const existing = proxyErrorCache.get(proxyUrl);
  const errorCount = existing ? existing.errorCount + 1 : 1;

  proxyErrorCache.set(proxyUrl, {
    errorTime: Date.now(),
    errorCode,
    errorCount
  });

  // Log seulement si DEBUG activé
  if (process.env.DEBUG_PROXY) {
    console.log(`[PROXY CACHE] Proxy marqué en erreur: ${proxyUrl} (code: ${errorCode}, count: ${errorCount})`);
  }
}

/**
 * Vérifie si un proxy est actuellement en cooldown (à éviter)
 * @param {string} proxyUrl - URL du proxy
 * @returns {boolean} - true si le proxy doit être ignoré
 */
function isProxyInCooldown(proxyUrl) {
  const errorInfo = proxyErrorCache.get(proxyUrl);
  if (!errorInfo) return false;

  const now = Date.now();
  const timeSinceError = now - errorInfo.errorTime;

  // Déterminer le cooldown approprié selon le type d'erreur et le nombre d'erreurs
  let cooldownMs;
  if (errorInfo.errorCount >= MAX_CONSECUTIVE_ERRORS) {
    cooldownMs = PROXY_EXTENDED_COOLDOWN_MS;
  } else if (errorInfo.errorCode === 429) {
    cooldownMs = PROXY_ERROR_COOLDOWN_429_MS;
  } else if (errorInfo.errorCode >= 500 && errorInfo.errorCode < 600) {
    cooldownMs = PROXY_ERROR_COOLDOWN_5XX_MS;
  } else {
    cooldownMs = PROXY_ERROR_COOLDOWN_MS;
  }

  // Si le cooldown est passé, supprimer l'entrée du cache
  if (timeSinceError >= cooldownMs) {
    proxyErrorCache.delete(proxyUrl);
    return false;
  }

  return true;
}

/**
 * Retourne la liste des proxies disponibles (non en cooldown)
 * @param {string[]} allProxies - Liste de tous les proxies
 * @returns {string[]} - Liste des proxies disponibles
 */
function getAvailableProxies(allProxies) {
  const available = allProxies.filter(proxy => !isProxyInCooldown(proxy));

  // Si tous les proxies sont en cooldown, on réinitialise le cache et on retourne tous les proxies
  // pour éviter de bloquer complètement le service
  if (available.length === 0) {
    if (process.env.DEBUG_PROXY) {
      console.log('[PROXY CACHE] Tous les proxies sont en cooldown, réinitialisation du cache');
    }
    proxyErrorCache.clear();
    return allProxies;
  }

  return available;
}

/**
 * Réinitialise le compteur d'erreurs d'un proxy après un succès
 * @param {string} proxyUrl - URL du proxy
 */
function markProxyAsHealthy(proxyUrl) {
  proxyErrorCache.delete(proxyUrl);
}

/**
 * Construit l'URL proxy en fonction du type de proxy
 * Les proxies se terminant par '/' attendent l'URL encodée
 * Les proxies se terminant par '?' attendent l'URL non-encodée
 * @param {string} proxyUrl - URL du proxy Cloudflare
 * @param {string} targetUrl - URL cible à proxyer
 * @returns {string} - URL finale à appeler
 */
function buildProxiedUrl(proxyUrl, targetUrl) {
  if (proxyUrl.endsWith('/')) {
    // Proxy qui attend l'URL encodée (ex: cors-worker-1)
    return proxyUrl + encodeURIComponent(targetUrl);
  } else {
    // Proxy qui attend l'URL en query string (ex: ?url=...)
    return proxyUrl + targetUrl;
  }
}

// Fonction pour faire une requête avec fallback CORS en cas d'erreur 429
async function makeRequestWithCorsFallback(targetUrl, options = {}) {
  const { timeout = 7000, headers = {}, decompress = true, ...otherOptions } = options;

  // Filtrer les proxies disponibles (non en cooldown)
  const availableProxies = getAvailableProxies(CLOUDFLARE_WORKERS_PROXIES);

  // Utiliser directement les proxies Cloudflare Workers disponibles
  let lastError = null;

  for (let i = 0; i < availableProxies.length; i++) {
    const currentProxy = availableProxies[i];
    try {
      // Construire l'URL complète : proxy Cloudflare + URL cible (encodage si nécessaire)
      const finalProxyUrl = buildProxiedUrl(currentProxy, targetUrl);

      const response = await axios.get(finalProxyUrl, {
        headers: {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Brave";v="140"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'cross-site',
          'sec-gpc': '1',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          ...headers
        },
        timeout,
        decompress,
        ...otherOptions
      });

      // Succès : marquer le proxy comme sain
      markProxyAsHealthy(currentProxy);
      return response;
    } catch (proxyError) {
      lastError = proxyError;
      const statusCode = proxyError.response?.status;
      const errorCode = statusCode || proxyError.code || 'unknown';

      // En cas d'erreur 400 ou 403, arrêt immédiat sans réessayer avec d'autres proxies
      if (statusCode === 400 || statusCode === 403) {
        throw proxyError;
      }

      // Marquer le proxy en erreur pour les codes 429, 5xx, timeout, etc.
      if (statusCode === 429 || (statusCode >= 500 && statusCode < 600) || proxyError.code === 'ECONNABORTED' || proxyError.code === 'ETIMEDOUT') {
        markProxyAsErrored(currentProxy, errorCode);
      }

      // Si c'est le dernier proxy et qu'on a une erreur, throw l'erreur
      if (i === availableProxies.length - 1) {
        throw proxyError;
      }
      // Sinon continuer avec le prochain proxy (429, etc.)
    }
  }

  // Si on arrive ici, tous les proxies ont échoué
  throw lastError || new Error('Tous les proxies ont échoué');
}

// Fonction pour faire une requête Coflix avec les proxies Cloudflare Workers (comme Anime Sama)
async function makeCoflixRequest(targetUrl, options = {}) {
  const { timeout = 15000, headers = {}, decompress = true, ...otherOptions } = options;

  // Nettoyer l'URL pour éviter les espaces indésirables
  const cleanTargetUrl = targetUrl.trim();

  // Filtrer les proxies disponibles (non en cooldown)
  const availableProxies = getAvailableProxies(CLOUDFLARE_WORKERS_PROXIES);

  // Headers pour les requêtes Coflix via proxy
  const coflixProxyHeaders = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Brave";v="140"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'cross-site',
    'sec-gpc': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ...coflixHeaders,
    ...headers
  };

  // Supprimer les headers liés à l'IP d'origine pour éviter de les transmettre
  const headersToRemove = ['X-Forwarded-For', 'X-Real-IP', 'X-Client-IP', 'CF-Connecting-IP', 'True-Client-IP', 'X-Original-Forwarded-For'];
  const cleanHeaders = { ...coflixProxyHeaders };
  headersToRemove.forEach(header => {
    delete cleanHeaders[header];
    delete cleanHeaders[header.toLowerCase()];
  });

  // Choisir un proxy SOCKS5h aléatoire
  const socks5Proxy = pickRandomProxyOrNone();
  const proxyAgent = socks5Proxy ? getProxyAgent(socks5Proxy) : null;

  // Utiliser les proxies Cloudflare Workers avec le proxy SOCKS5h
  let lastError = null;

  // Essayer chaque proxy Cloudflare séquentiellement
  for (let i = 0; i < availableProxies.length; i++) {
    const cloudflareProxy = availableProxies[i];
    const proxiedUrl = buildProxiedUrl(cloudflareProxy, cleanTargetUrl);

    try {
      if (process.env.DEBUG_COFLIX) console.log(`[Coflix] Tentative avec ${cloudflareProxy}`);

      const response = await axios({
        url: proxiedUrl,
        headers: cleanHeaders,
        timeout,
        decompress: true,
        responseType: 'text',
        responseEncoding: 'utf8',
        ...otherOptions,
        ...(proxyAgent ? { httpAgent: proxyAgent, httpsAgent: proxyAgent, proxy: false } : {})
      });

      // Succès : marquer le proxy comme sain
      markProxyAsHealthy(cloudflareProxy);
      return response;
    } catch (error) {
      if (process.env.DEBUG_COFLIX) console.log(`[Coflix] Échec avec ${cloudflareProxy}: ${error.message}`);

      lastError = error;
      const statusCode = error.response?.status;
      const errorCode = statusCode || error.code || 'unknown';

      // En cas d'erreur 429 (Too Many Requests), marquer le proxy et essayer le suivant
      if (statusCode === 429) {
        markProxyAsErrored(cloudflareProxy, 429);
        continue;
      }

      // En cas d'erreur 5xx, marquer le proxy et essayer le suivant
      if (statusCode >= 500 && statusCode < 600) {
        markProxyAsErrored(cloudflareProxy, statusCode);
        continue;
      }

      // En cas de timeout, marquer le proxy et essayer le suivant
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        markProxyAsErrored(cloudflareProxy, errorCode);
        continue;
      }

      // Pour les erreurs 400, 403, arrêter immédiatement
      if (process.env.DEBUG_COFLIX) console.error(`[Coflix] Erreur fatale avec le proxy ${cloudflareProxy}:`, error.message);
      throw error;
    }
  }

  // Si on arrive ici, tous les proxies ont échoué
  if (lastError) throw lastError;
  throw new Error('Tous les proxies ont échoué (Coflix)');
}


// Fonction pour faire une requête LecteurVideo avec les proxies SOCKS5h
async function makeLecteurVideoRequest(targetUrl, options = {}) {
  const { timeout = 15000, headers = {}, decompress = true, ...otherOptions } = options;

  // Nettoyer l'URL pour éviter les espaces indésirables
  const cleanTargetUrl = targetUrl.trim();

  // Choisir un proxy SOCKS5h aléatoire
  const socks5Proxy = pickRandomProxyOrNone();
  const proxyAgent = socks5Proxy ? getProxyAgent(socks5Proxy) : null;

  if (!proxyAgent) {
    throw new Error('[LECTEURVIDEO] Aucun proxy SOCKS5h disponible');
  }

  try {
    const response = await axios.get(cleanTargetUrl, {
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'fr-FR,fr;q=0.7',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'priority': 'u=0, i',
        'referer': 'https://coflix.observer/',
        'sec-ch-ua': '"Brave";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'iframe',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-storage-access': 'none',
        'sec-gpc': '1',
        'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'cookie': 'cf_clearance=1kltmqQs5IZMXJLw00AYOhoSBjiJhCtM5X8AnVAHR48-1761680096-1.2.1.1-.4wtj_F1hyRvbwTFTbCDdU4z8W0QI0uR11.zNGsr9rE2ZEUzjw_Rjf_xyAFB2OGWrPIJ4f7eSQuUgEU2oZ8x6yfhHoFAcJ.kpsoujC1OGVVA2tnUA9oaLftSRA8jYHg3fcH4uNkhCqrhtnEDwgiHMO3zn.7rXXG_uBQyAPXg0PF2eIxUDpVDom0eUFX.ktljbXrYm9A.idFTvper_DLi_AYvB_nFf0jFQhyWJnAsXjI',
        ...headers
      },
      timeout: 7000,
      decompress: true,
      responseType: 'text',
      responseEncoding: 'utf8',
      httpAgent: proxyAgent,
      httpsAgent: proxyAgent,
      proxy: false,
      ...otherOptions
    });

    return response;
  } catch (error) {
    const errorCode = error.response?.status || error.code || 'unknown';
    console.error(`[LECTEURVIDEO] erreur: ${errorCode}`);
    throw error;
  }
}

// Utilitaires pour le cache
const CACHE_DIR = {
  ANIME_SAMA: ANIME_SAMA_CACHE_DIR,
  COFLIX: path.join(__dirname, 'cache', 'coflix'),
  FSTREAM: path.join(__dirname, 'cache', 'fstream'),
  CPASMAL: path.join(__dirname, 'cache', 'cpasmal'),
  TVDIRECT: path.join(__dirname, 'cache', 'tvdirect'),
  PURSTREAM: path.join(__dirname, 'cache', 'purstream'),
  CINEPULSE: path.join(__dirname, 'cache', 'cinepulse'),
  NOCTAFLIX: path.join(__dirname, 'cache', 'noctaflix'),
  DRAGIV: path.join(__dirname, 'cache', 'dragiv'),
  FTV: path.join(__dirname, 'cache', 'ftv')
};

// Créer les dossiers de cache s'ils n'existent pas
(async () => {
  for (const dir of Object.values(CACHE_DIR)) {
    try {
      await fsp.access(dir);
    } catch {
      await fsp.mkdir(dir, { recursive: true });
    }
  }
})();

// Fonction pour générer une clé de cache basée sur les paramètres
const generateCacheKey = (params) => {
  const stringParams = typeof params === 'string' ? params : JSON.stringify(params);
  return crypto.createHash('md5').update(stringParams).digest('hex');
};

// Fonction pour corriger le type de stream basé sur l'URL
const correctStreamType = (streamData) => {
  if (streamData && streamData.url && streamData.url.includes('.mp4')) {
    return {
      ...streamData,
      type: 'mp4'
    };
  }
  return streamData;
};

// Fonction pour vérifier si une donnée est en cache avec expiration de 8h
const getFromCacheWithExpiration = async (cacheDir, key, expirationHours = 8) => {
  try {
    // 1. Vérifier le cache mémoire (L1) (rapide)
    // Si c'est en mémoire (TTL 5 min), c'est forcément valide (< 8h)
    const memKey = `${cacheDir}:${key}`;
    const memData = await memoryCache.get(memKey);
    if (memData) {
      if (process.env.DEBUG_CACHE) console.log(`[Cache] Memory hit for ${key}`);
      return memData;
    }

    // 2. Vérifier le cache fichier (L2) (lent)
    const cacheFilePath = path.join(cacheDir, `${key}.json`);
    let stats;
    try {
      stats = await fsp.stat(cacheFilePath);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }

    const now = Date.now();
    const fileTime = stats.mtime.getTime();
    const expirationTime = expirationHours * 60 * 60 * 1000; // en millisecondes

    // Vérifier si le cache a expiré
    if (now - fileTime > expirationTime) {
      return null;
    }

    const fileContent = await fsp.readFile(cacheFilePath, 'utf8');
    const cacheData = JSON.parse(fileContent);

    // Mettre à jour le cache mémoire pour les prochaines fois
    await memoryCache.set(memKey, cacheData);

    return cacheData;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    console.error(`Erreur lors de la récupération du cache pour ${key}:`, error);
    return null;
  }
};

// Fonction pour normaliser les URLs Anime-Sama avec le domaine actuel
const normalizeAnimeSamaUrls = (data) => {
  if (!data) return data;

  const currentDomain = ANIME_SAMA_URL.replace(/\/$/, ''); // Enlever le slash final

  // Fonction pour valider une URL de player
  const isValidPlayerUrl = (url) => {
    if (typeof url !== 'string' || url.length === 0) return false;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    if (!url.includes('.')) return false;
    const invalidPatterns = ['_self', 'containerSamedi', 'élite', 'Sectes', 'prouesses', 'discord.gg'];
    if (invalidPatterns.some(pattern => url.includes(pattern))) return false;
    return true;
  };

  // Fonction récursive pour remplacer les URLs dans les objets/tableaux
  const replaceUrls = (obj, key = null) => {
    if (typeof obj === 'string') {
      // Retirer le préfixe proxy.movix.club/proxy/ ou proxy.movix.site/proxy/
      let cleanedUrl = obj.replace(/https:\/\/proxy\.movix\.(club|site)\/proxy\//gi, '');
      // Remplacer tous les anciens domaines anime-sama par le domaine actuel
      return cleanedUrl.replace(/https?:\/\/anime-sama\.[a-z]+/gi, currentDomain);
    }

    if (Array.isArray(obj)) {
      // Si c'est le tableau "players", filtrer les URLs invalides
      // Seulement si les éléments sont des strings (anime-sama)
      // Pour FrenchStream/IMDB, les players sont des objets {name, link}
      if (key === 'players') {
        return obj
          .map(item => replaceUrls(item))
          .filter(item => {
            // Si c'est un objet avec un link (FrenchStream), le garder
            if (item && typeof item === 'object' && item.link) {
              return true;
            }
            // Si c'est une string (anime-sama), valider l'URL
            return isValidPlayerUrl(item);
          });
      }
      // Si c'est le tableau "streaming_links", traiter chaque élément puis filtrer les vides
      if (key === 'streaming_links') {
        return obj
          .map(item => {
            // Traiter l'objet streaming_link (qui contient language et players)
            const processed = replaceUrls(item);
            return processed;
          })
          .filter(item => item && item.players && item.players.length > 0);
      }
      return obj.map(item => replaceUrls(item));
    }

    if (obj && typeof obj === 'object') {
      const newObj = {};
      for (const [k, value] of Object.entries(obj)) {
        newObj[k] = replaceUrls(value, k);
      }
      return newObj;
    }

    return obj;
  };

  return replaceUrls(data);
};

// Fonction pour vérifier si une donnée est en cache sans vérifier la date d'expiration
const getFromCacheNoExpiration = async (cacheDir, key) => {
  try {
    // 1. Vérifier le cache mémoire (L1)
    const memKey = `${cacheDir}:${key}`;
    const memData = await memoryCache.get(memKey);
    if (memData) {
      // Normaliser les URLs pour le cache mémoire aussi (sécurité)
      const normalizedMemData = normalizeAnimeSamaUrls(memData);
      return normalizedMemData;
    }

    const cacheFilePath = path.join(cacheDir, `${key}.json`);
    let fileContent;
    try {
      fileContent = await fsp.readFile(cacheFilePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }

    const cacheData = JSON.parse(fileContent);

    // Validation: s'assurer que les données en cache ne sont pas du texte "Maintenance en cours"
    if (typeof cacheData === 'string' && cacheData.includes('Maintenance en cours')) {
      console.error(`Cache invalide détecté pour ${key} - contient "Maintenance en cours"`);
      // Supprimer le cache invalide
      try {
        await fsp.unlink(cacheFilePath);
      } catch (unlinkError) { }
      return null;
    }

    // Validation: s'assurer que les données en cache sont bien du JSON valide et pas du texte brut
    if (typeof cacheData === 'string' || cacheData === null || cacheData === undefined) {
      console.error(`Cache invalide détecté pour ${key} - données non-JSON ou nulles`);
      try {
        await fsp.unlink(cacheFilePath);
      } catch (unlinkError) { }
      return null;
    }

    // Normaliser les URLs Anime-Sama dans les données du cache
    const normalizedData = normalizeAnimeSamaUrls(cacheData);

    // Mettre en cache mémoire
    await memoryCache.set(memKey, normalizedData);

    return normalizedData;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    console.error(`Erreur lors de la récupération du cache pour ${key}:`, error);
    return null;
  }
};

// Fonction pour sauvegarder des données en cache
const saveToCache = async (cacheDir, key, data) => {
  try {
    const cacheFilePath = path.join(cacheDir, `${key}.json`);

    // OPTIMISATION: Utiliser write-file-atomic directement sans lockfile
    // lockfile (utilisé dans safeWriteFile) ajoute 50-100ms de latence par écriture
    // Pour des fichiers de cache temporaires, atomic write suffit largement
    await writeFileAtomic(cacheFilePath, JSON.stringify(data), { encoding: 'utf8', fsync: false });

    // Mettre aussi en cache mémoire pour éviter les lectures disque
    await memoryCache.set(`${cacheDir}:${key}`, data);
    return true;
  } catch (error) {
    console.error(`Erreur lors de la sauvegarde en cache pour ${key}:`, error);
    return false;
  }
};

// Déduplication des sources : préférer les liens avec m3u8 valide et langue MULTI quand disponible
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

    let winner = current;
    let loser = candidate;

    if (!current.m3u8 && candidate.m3u8) {
      winner = candidate;
      loser = current;
    } else if (current.m3u8 && !candidate.m3u8) {
      winner = current;
      loser = candidate;
    } else if (candidateLang === 'multi' && currentLang !== 'multi') {
      winner = candidate;
      loser = current;
    } else if (currentLang === 'multi' && candidateLang !== 'multi') {
      winner = current;
      loser = candidate;
    } else if (!current.language && candidate.language) {
      winner = candidate;
      loser = current;
    }

    return mergeMissingFields(winner, loser);
  };

  const byKey = new Map();
  for (const source of sources) {
    if (!source) continue;
    const key = source.m3u8 || source.src;
    if (!key) continue;
    const existing = byKey.get(key);
    const chosen = choosePreferred(existing, source);
    byKey.set(key, chosen);
  }

  const bySrc = new Map();
  const result = [];
  for (const entry of byKey.values()) {
    const srcKey = entry.src || entry.m3u8;
    if (!srcKey) continue;
    const existing = bySrc.get(srcKey);
    const chosen = choosePreferred(existing, entry);
    bySrc.set(srcKey, chosen);
    if (!existing) {
      result.push(chosen);
    } else {
      const index = result.findIndex(item => (item.src || item.m3u8) === srcKey);
      if (index !== -1) {
        result[index] = chosen;
      }
    }
  }

  return result;
};

// Fonction pour vérifier si une donnée FStream est en cache
const getFStreamFromCache = async (cacheKey) => {
  try {
    const cacheFilePath = path.join(CACHE_DIR.FSTREAM, `${cacheKey}.json`);
    const cacheData = JSON.parse(await fsp.readFile(cacheFilePath, 'utf8'));


    return cacheData.data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    console.error(`[FSTREAM CACHE] Erreur lors de la récupération du cache pour ${cacheKey}:`, error);
    return null;
  }
};

// === CACHE EN MÉMOIRE POUR ÉVITER LES REQUÊTES DUPLIQUÉES ===
// Map pour stocker les promesses en cours d'exécution
const ongoingFStreamRequests = new Map();

// Fonction pour obtenir ou créer une requête FStream partagée
const getOrCreateFStreamRequest = async (cacheKey, requestFunction) => {
  // Si une requête est déjà en cours pour cette clé, retourner la promesse existante
  if (ongoingFStreamRequests.has(cacheKey)) {
    const existingPromise = ongoingFStreamRequests.get(cacheKey);

    // Appliquer un timeout global de 6 secondes même pour les promesses partagées
    return Promise.race([
      existingPromise,
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('timeout of 6000ms exceeded'));
        }, 8000);
      })
    ]);
  }

  // Créer une nouvelle promesse et la stocker
  const requestPromise = (async () => {
    try {
      // Appliquer un timeout global de 6 secondes
      const result = await Promise.race([
        requestFunction(),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('timeout of 6000ms exceeded'));
          }, 8000
          );
        })
      ]);
      return result;
    } finally {
      // Nettoyer la promesse une fois terminée (succès ou échec)
      ongoingFStreamRequests.delete(cacheKey);
    }
  })();

  // Stocker la promesse
  ongoingFStreamRequests.set(cacheKey, requestPromise);

  return await requestPromise;
};

// Nettoyage automatique des requêtes expirées (toutes les 5 minutes)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  // Parcourir et nettoyer les entrées qui pourraient être "coincées"
  for (const [key, promise] of ongoingFStreamRequests) {
    // Si la promesse existe depuis plus de 10 minutes, la supprimer
    if (promise.createdAt && (now - promise.createdAt > 10 * 60 * 1000)) {
      ongoingFStreamRequests.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[FSTREAM DEDUP] Nettoyage automatique: ${cleaned} requêtes expirées supprimées`);
  }
}, 5 * 60 * 1000); // Toutes les 5 minutes

// Fonction pour sauvegarder des données FStream en cache
const saveFStreamToCache = async (cacheKey, data) => {
  try {
    const cacheFilePath = path.join(CACHE_DIR.FSTREAM, `${cacheKey}.json`);
    const cacheData = {
      data: data
    };

    // Utiliser l'écriture atomique pour les fichiers de cache FStream
    await writeFileAtomic(cacheFilePath, JSON.stringify(cacheData), 'utf8');
    // Mettre aussi en cache mémoire
    await memoryCache.set(`fstream:${cacheKey}`, cacheData);
    return true;
  } catch (error) {
    console.error(`[FSTREAM CACHE] Erreur lors de la sauvegarde en cache pour ${cacheKey}:`, error);
    return false;
  }
};

// Fonction pour générer une clé de cache FStream
const generateFStreamCacheKey = (type, id, season = null, episode = null) => {
  const params = { type, id, season, episode };
  return crypto.createHash('md5').update(JSON.stringify(params)).digest('hex');
};

// Fonction pour nettoyer le cache FStream
const clearFStreamCache = async () => {
  try {
    const cacheDir = CACHE_DIR.FSTREAM;
    const files = await fsp.readdir(cacheDir);

    for (const file of files) {
      if (file.endsWith('.json')) {
        await fsp.unlink(path.join(cacheDir, file));
      }
    }

    return { success: true, deletedFiles: files.length };
  } catch (error) {
    console.error(`[FSTREAM CACHE] Erreur lors du nettoyage: ${error.message}`);
    return { success: false, error: error.message };
  }
};


const app = express();
const PORT = 25565;

// Initialize Socket.IO later in the startServer function
let io;

// Enable gzip compression for all responses
app.use(compression({
  level: 1, // Balanced compression level (1-9, higher = more compression, slower)
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress if client doesn't accept it
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Cors Configuration (Restricted in production)
app.use(cors({
  origin: (origin, callback) => {
    const allowedDomains = [
      'movix.blog',
      'movix.club',
      'movix.site',
      'movix11.pages.dev',
      'nakios.site',
      'cinezo.site'
    ];

    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Allow all localhost requests (http and https)
    if (origin.match(/^https?:\/\/localhost(:[0-9]+)?$/)) {
      return callback(null, true);
    }

    // Check if origin matches allowed domains (allows http, https, and subdomains)
    const isAllowed = allowedDomains.some(domain => {
      // Allow exact match (http/s) or subdomain
      return origin === `https://${domain}` || 
             origin === `http://${domain}` || 
             origin.endsWith(`.${domain}`);
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-No-Compression', 'Access-Control-Request-Headers', 'baggage', 'sentry-trace', 'x-profile-id', 'x-access-key'],
  credentials: true,
  optionsSuccessStatus: 204
}));

// Security headers (minimal set — replaces Helmet)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // Disabled per OWASP recommendation (use CSP instead)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Middleware pour ajouter les headers Keep-Alive
app.use((req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=60, max=1000');
  next();
});

// Middleware de restriction de domaine et réponse fake pour route spécifique
app.use((req, res, next) => {
  // Autoriser les endpoints LiveTV pour l'extension
  if (req.path.startsWith('/api/livetv/')) {
    return next();
  }

  const allowedDomains = [
    'localhost:3000',
    'movix.blog',
    'movix.club',
    'movix.site',
    'movix11.pages.dev',
    'nakios.site',
    'cinezo.site'
  ];

  const origin = req.get('origin');
  const referer = req.get('referer');

  let isAllowed = false;

  // Strict domain verification
  const checkDomain = (url) => {
    try {
      if (!url) return false;
      const hostname = new URL(url).hostname;
      // Allow exact matches or subdomains if needed (here we list full domains)
      return allowedDomains.some(domain => {
         // Handle localhost with port special case if needed, or just match hostname
         if (domain.includes(':')) return url.includes(domain);
         return hostname === domain || hostname.endsWith('.' + domain);
      });
    } catch (e) {
      return false;
    }
  };

  if (origin) {
    if (checkDomain(origin)) isAllowed = true;
  } else if (referer) {
    if (checkDomain(referer)) isAllowed = true;
  }

  // Si autorisé, on continue
  if (isAllowed) {
    return next();
  }

  // Si non autorisé
  // Route spécifique accessible mais avec fausse réponse
  if (req.path.startsWith('/api/imdb/movie')) {
    return res.json({
      "iframe_src": "https://movixfakesite.vercel.app/",
      "player_links": [
        {
          "player": "supervideo",
          "link": "https://movixfakesite.vercel.app/",
          "is_hd": false
        },
        {
          "player": "dropload",
          "link": "https://movixfakesite.vercel.app/",
          "is_hd": false
        },
        {
          "player": "mixdrop",
          "link": "https://movixfakesite.vercel.app/",
          "is_hd": false
        }
      ]
    });
  } else if (req.path.startsWith('/api/imdb/tv')) {
    return res.json({
      "type": "tv",
      "series": [
        {
          "title": "Stranger Things - Saison 5",
          "audio_type": "VF",
          "episode_count": 1,
          "release_date": "2016",
          "summary": "Quand un jeune garçon disparaît, une petite ville découvre une affaire mystérieuse, des expériences secrètes, des forces surnaturelles terrifiantes... et une fillette.",
          "tmdb_data": {
            "id": 66732,
            "name": "Stranger Things",
            "overview": "When a young boy vanishes, a small town uncovers a mystery involving secret experiments, terrifying supernatural forces, and one strange little girl.",
            "first_air_date": "2016-07-15",
            "poster_path": "/uOOtwVbSr4QDjAGIifLDwpb2Pdl.jpg",
            "backdrop_path": "/8zbAoryWbtH0DKdev8abFAjdufy.jpg",
            "vote_average": 8.59,
            "match_score": 0.8818181818181817
          },
          "seasons": [
            {
              "number": 1,
              "title": "Saison 1",
              "episodes": [
                {
                  "number": "1",
                  "versions": {
                    "vf": {
                      "title": "Episode 1",
                      "players": [
                        {
                          "name": "Supervideo",
                          "link": "https://movixfakesite.vercel.app/"
                        }
                      ]
                    }
                  }
                }
              ]
            }
          ]
        }
      ]
    });
  }

  // Bloquer toutes les autres routes
  return res.status(404).json({ error: 'Not Found' });
});

app.use(express.json({ limit: '30mb' })); // Reduced from 1000mb to prevent abuse

// Error handler for JSON parsing errors (malformed requests like URL-encoded form data)
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    // Silently handle malformed JSON requests (likely bots or scanners)
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON body'
    });
  }
  next(err);
});


// Configuration de la connexion MySQL
const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 300,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};

// Pool de connexions MySQL
let pool;
(async () => {
  try {
    pool = mysql.createPool(dbConfig);
    console.log('✅ MySQL connection pool created successfully');

    // Test de connexion
    const connection = await pool.getConnection();
    console.log('✅ MySQL connection test successful');
    connection.release();

    // Créer la table user_sessions si elle n'existe pas
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        user_type ENUM('oauth', 'bip39') NOT NULL,
        device TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_sessions_user (user_id, user_type),
        INDEX idx_user_sessions_accessed (accessed_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ Table user_sessions initialized successfully');

    // Initialiser le pool partagé pour les routes de commentaires
    const { initPool } = require('./mysqlPool');
    await initPool();
    console.log('✅ MySQL shared pool for comments initialized successfully');

    // Initialize Wishboard routes
    const { createWishboardRouter } = require('./wishboardRoutes');
    const wishboardRouter = createWishboardRouter(pool, redis);
    app.use('/api/wishboard', wishboardRouter);
    app.use('/api/admin/wishboard', wishboardRouter);
    console.log('✅ Wishboard routes initialized successfully');

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
    console.log('✅ Link Submissions routes initialized successfully');

    // Initialize Top 10 routes (public ranking)
    const { router: top10Router, initTop10Routes } = require('./top10Routes');
    initTop10Routes(pool, redis);
    app.use('/api/top10', top10Router);
    console.log('✅ Top 10 routes initialized successfully');

    // Initialize Wrapped routes (Movix Wrapped 2026 data collection)
    const { router: wrappedRouter, initWrappedRoutes, initTables: initWrappedTables } = require('./wrappedRoutes');
    initWrappedRoutes(pool, redis);
    await initWrappedTables();
    app.use('/api/wrapped', wrappedRouter);
    console.log('✅ Wrapped routes initialized successfully');
  } catch (error) {
    console.error('❌ MySQL connection error:', error.message);
  }
})();

// Middleware pour vérifier si l'utilisateur est admin
async function isAdmin(req, res, next) {
  try {
    // Vérifier si le pool MySQL est initialisé
    if (!pool) {
      console.error('❌ MySQL pool not initialized');
      return res.status(503).json({ success: false, error: 'Service temporairement indisponible - Base de données en cours d\'initialisation' });
    }

    // Vérifier le JWT
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Non autorisé - Token invalide' });
    }

    const { userId, userType } = auth;

    // Vérifier si l'utilisateur est dans la table admins
    const [rows] = await pool.execute(
      'SELECT * FROM admins WHERE user_id = ? AND auth_type = ?',
      [userId, userType === 'bip39' ? 'bip-39' : userType]
    );

    if (rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Accès refusé - Droits admin requis' });
    }

    // Récupérer le rôle (par défaut 'admin' si non défini)
    const role = rows[0].role || 'admin';

    // Ajouter les infos admin à la requête (avec le rôle)
    req.admin = { userId, userType, adminId: rows[0].id, role };
    next();
  } catch (error) {
    console.error('❌ Admin verification error:', error);
    return res.status(500).json({ success: false, error: 'Erreur lors de la vérification admin' });
  }
}

// Middleware pour vérifier si l'utilisateur est uploader ou admin (pour les liens de streaming)
async function isUploaderOrAdmin(req, res, next) {
  try {
    // Vérifier si le pool MySQL est initialisé
    if (!pool) {
      console.error('❌ MySQL pool not initialized');
      return res.status(503).json({ success: false, error: 'Service temporairement indisponible - Base de données en cours d\'initialisation' });
    }

    // Vérifier le JWT
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Non autorisé - Token invalide' });
    }

    const { userId, userType } = auth;

    // Vérifier si l'utilisateur est dans la table admins (admin ou uploader)
    const [rows] = await pool.execute(
      'SELECT * FROM admins WHERE user_id = ? AND auth_type = ?',
      [userId, userType === 'bip39' ? 'bip-39' : userType]
    );

    if (rows.length === 0) {
      return res.status(403).json({ success: false, error: 'Accès refusé - Droits requis' });
    }

    // Récupérer le rôle (par défaut 'admin' si non défini)
    const role = rows[0].role || 'admin';

    // Autoriser les rôles 'admin' et 'uploader'
    if (role !== 'admin' && role !== 'uploader') {
      return res.status(403).json({ success: false, error: 'Accès refusé - Droits insuffisants' });
    }

    // Ajouter les infos admin à la requête (avec le rôle)
    req.admin = { userId, userType, adminId: rows[0].id, role };
    next();
  } catch (error) {
    console.error('❌ Admin/Uploader verification error:', error);
    return res.status(500).json({ success: false, error: 'Erreur lors de la vérification des droits' });
  }
}


async function getAuthIfValid(req) {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) return null;
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const { userType, sub: userId, sessionId } = payload;
    if (!['oauth', 'bip39'].includes(userType) || !userId || !sessionId) return null;

    // Vérification de session via MySQL avec 3 tentatives
    let hasSession = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (!pool) {
          console.warn('[AUTH] MySQL pool not ready, attempt', attempt);
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          return null;
        }

        const [rows] = await pool.execute(
          'SELECT id FROM user_sessions WHERE id = ? AND user_id = ? AND user_type = ?',
          [sessionId, userId, userType]
        );
        hasSession = rows.length > 0;

        if (hasSession) {
          break; // Session trouvée, sortir de la boucle
        }

        if (attempt < 3) {
          console.log(`[AUTH] Tentative ${attempt}/3 échouée pour userType=${userType}, userId=${userId}, sessionId=${sessionId} - nouvelle tentative dans 0.5s`);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`[AUTH] Erreur lors de la tentative ${attempt}/3:`, error.message);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    if (!hasSession) {
      console.warn(`[AUTH] Session manquante après 3 tentatives pour userType=${userType}, userId=${userId}, sessionId=${sessionId}`);
      return null;
    }

    // Update last access as activity signal (fire-and-forget, pas de await)
    updateSessionAccess(userType, userId, sessionId);
    return { userType, userId, sessionId };
  } catch {
    return null;
  }
}


app.use(express.urlencoded({ extended: true, limit: '5mb' })); // Reduced from 1000mb to prevent abuse

// Routes de commentaires
const commentsRoutes = require('./commentsRoutes');
app.use('/api/comments', commentsRoutes);

// Routes de likes
const likesRoutes = require('./likesRoutes');
app.use('/api/likes', likesRoutes);

// Routes Shared Lists (Listes partagées)
const sharedListsRoutes = require('./sharedListsRoutes');
app.use('/api/shared-lists', sharedListsRoutes);

// Routes Live TV (TV en Direct)
const liveTvRoutes = require('./liveTvRoutes');
app.use('/api/livetv', liveTvRoutes);

// Routes Cpasmal
// Helper to sort links
function sortCpasmalLinks(links) {
  const priority = ['voe', 'uqload'];
  return links.sort((a, b) => {
    const indexA = priority.indexOf(a.server);
    const indexB = priority.indexOf(b.server);

    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return 0;
  });
}

// Helper to get TMDB details
async function getTmdbDetails(tmdbId, type) {
  try {
    const url = `${TMDB_API_URL}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=fr-FR`;
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(`Error fetching TMDB details for ${type}/${tmdbId}:`, error.message);
    return null;
  }
}

// Helper to search on Cpasmal
// Scores search results from a single search query and returns { bestMatch, bestScore }
function _scoreCpasmalResults($, items, title, year, type, normalize) {
  let bestMatch = null;
  let bestScore = -1;

  items.each((i, el) => {
    const $el = $(el);
    const link = $el.find('a.th-img').attr('href');
    const titleText = $el.find('.th-desc .th-capt').text().trim();
    const yearText = $el.find('.th-desc .th-year').text().trim();
    const isSerie = $el.find('.th-Serie').length > 0;
    const isMovie = $el.find('.th-Film').length > 0;

    // Check type - strict filtering
    if (type === 'movie' && !isMovie) return;
    if (type === 'tv' && !isSerie) return;

    const normTitle = normalize(title);
    const normTitleText = normalize(titleText);

    // Calculate match score
    let score = 0;
    let titleMatchQuality = 'none'; // Track title match quality for year bonus scaling

    // Exact title match (highest priority) - 100 points
    if (normTitleText === normTitle) {
      score += 100;
      titleMatchQuality = 'exact';
    }
    // Title starts with search term (good match) - score depends on length ratio
    else if (normTitleText.startsWith(normTitle + ' ')) {
      const lengthRatio = normTitle.length / normTitleText.length;
      if (lengthRatio >= 0.75) {
        score += 50;
        titleMatchQuality = 'strong';
      } else if (lengthRatio >= 0.60) {
        score += 25;
        titleMatchQuality = 'moderate';
      } else {
        score += 5;
        titleMatchQuality = 'weak';
      }
    }
    // Title ends with search term - score depends on length ratio (like "starts with")
    else if (normTitleText.endsWith(' ' + normTitle)) {
      const lengthRatio = normTitle.length / normTitleText.length;
      if (lengthRatio >= 0.75) {
        score += 50;
        titleMatchQuality = 'strong';
      } else if (lengthRatio >= 0.60) {
        score += 25;
        titleMatchQuality = 'moderate';
      } else {
        score += 5;
        titleMatchQuality = 'weak';
      }
    }
    // Search term is contained but not at start/end (likely a different movie) - 5 points
    else if (normTitleText.includes(normTitle)) {
      score += 5;
      titleMatchQuality = 'weak';
    }
    // Search term contains the result title (less likely to be correct) - 3 points
    else if (normTitle.includes(normTitleText)) {
      score += 3;
      titleMatchQuality = 'weak';
    }
    // No match at all - skip
    else {
      return;
    }

    // Year matching bonus points - scaled by title match quality
    if (year && yearText) {
      const yearDiff = Math.abs(parseInt(yearText) - parseInt(year));
      const isWeakTitle = (titleMatchQuality === 'weak');
      if (yearDiff === 0) {
        score += isWeakTitle ? 10 : 50;
      } else if (yearDiff === 1) {
        score += isWeakTitle ? 5 : 20;
      } else if (yearDiff > 5) {
        score -= 30;
      } else {
        score -= 10;
      }
    }

    if (process.env.DEBUG_CPASMAL) {
      console.log(`[Cpasmal] Candidate: "${titleText}" (${yearText}) - Score: ${score}`);
    }

    if (score > bestScore && score > 0) {
      bestScore = score;
      bestMatch = link;
    }
  });

  return { bestMatch, bestScore };
}

// Run a single cpasmal search query across multiple pages, return { bestMatch, bestScore }
async function _runCpasmalSearch(searchQuery, title, year, type, normalize, maxPages) {
  let bestMatch = null;
  let bestScore = -1;
  let page = 1;

  while (page <= maxPages) {
    try {
      const searchUrl = `${CPASMAL_BASE_URL}/index.php?do=search&subaction=search&search_start=${page}&full_search=0&story=${encodeURIComponent(searchQuery)}`;
      const response = await axiosCpasmalRequest({ method: 'get', url: searchUrl });
      const $ = cheerio.load(response.data);

      const items = $('div.thumb');
      if (items.length === 0) break;

      const result = _scoreCpasmalResults($, items, title, year, type, normalize);
      if (result.bestScore > bestScore) {
        bestScore = result.bestScore;
        bestMatch = result.bestMatch;
      }

      // If we already found an exact match, no need to search more pages
      if (bestScore >= 100) break;

      page++;
    } catch (error) {
      console.error(`Error searching Cpasmal page ${page}:`, error.message);
      break;
    }
  }

  return { bestMatch, bestScore };
}

async function searchCpasmal(title, year, type) {
  // Prepare search query: normalize spaces (remove non-breaking spaces) and keep colons
  let searchQuery = title.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

  // Normalize function for title comparison
  const normalize = (str) => str.toLowerCase().replace(/[:\s\-.,!?'"()]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (process.env.DEBUG_CPASMAL) console.time(`[Cpasmal] Search ${title}`);

  // === Strategy 1: Search by title only (2 pages) ===
  let { bestMatch, bestScore } = await _runCpasmalSearch(searchQuery, title, year, type, normalize, 2);

  if (process.env.DEBUG_CPASMAL) {
    console.log(`[Cpasmal] Strategy 1 (title only "${searchQuery}"): best score = ${bestScore}`);
  }

  // === Strategy 2: If no good match, retry with "title year" to narrow results ===
  // This helps for generic titles like "Urgences" where the search returns thematically
  // related results instead of the exact show
  if (bestScore < 20 && year) {
    const searchQueryWithYear = `${searchQuery} ${year}`;
    if (process.env.DEBUG_CPASMAL) {
      console.log(`[Cpasmal] Strategy 2: retrying with "${searchQueryWithYear}"`);
    }
    const result2 = await _runCpasmalSearch(searchQueryWithYear, title, year, type, normalize, 1);
    if (result2.bestScore > bestScore) {
      bestScore = result2.bestScore;
      bestMatch = result2.bestMatch;
    }
    if (process.env.DEBUG_CPASMAL) {
      console.log(`[Cpasmal] Strategy 2 (title+year "${searchQueryWithYear}"): best score = ${bestScore}`);
    }
  }

  // === Strategy 3: If still no good match, try full_search=1 (exact title match mode) ===
  if (bestScore < 20) {
    if (process.env.DEBUG_CPASMAL) {
      console.log(`[Cpasmal] Strategy 3: retrying with full_search=1`);
    }
    try {
      const fullSearchUrl = `${CPASMAL_BASE_URL}/index.php?do=search&subaction=search&search_start=1&full_search=1&story=${encodeURIComponent(searchQuery)}`;
      const response = await axiosCpasmalRequest({ method: 'get', url: fullSearchUrl });
      const $ = cheerio.load(response.data);
      const items = $('div.thumb');
      if (items.length > 0) {
        const result3 = _scoreCpasmalResults($, items, title, year, type, normalize);
        if (result3.bestScore > bestScore) {
          bestScore = result3.bestScore;
          bestMatch = result3.bestMatch;
        }
      }
    } catch (error) {
      console.error(`Error in Cpasmal full_search:`, error.message);
    }
    if (process.env.DEBUG_CPASMAL) {
      console.log(`[Cpasmal] Strategy 3 (full_search=1): best score = ${bestScore}`);
    }
  }

  if (process.env.DEBUG_CPASMAL) {
    console.timeEnd(`[Cpasmal] Search ${title}`);
    console.log(`[Cpasmal] Final best match score: ${bestScore}`);
  }

  // Only return a match if the score is high enough (at least 20 points)
  // This filters out poor matches like "The King's Avatar" for "Avatar"
  return bestScore >= 20 ? bestMatch : null;
}

// Helper to extract links from a movie page
async function extractMovieLinks(url) {
  if (process.env.DEBUG_CPASMAL) console.time(`[Cpasmal] ExtractMovieLinks ${url}`);
  try {
    const response = await axiosCpasmalRequest({ method: 'get', url: url });
    const $ = cheerio.load(response.data);
    const links = { vf: [], vostfr: [] };
    let cpasmalYear = null;

    // Extraire l'année de sortie depuis la page cpasmal
    // XPath: /html/body/div[1]/div/div[2]/div/main/div/div/article/div[2]/div[2]/ul/li[2]
    // Chercher dans la liste des infos pour "Date de sortie"
    $('article ul li').each((i, el) => {
      const $el = $(el);
      const infoLabel = $el.find('span.info').text().trim().toLowerCase();
      if (infoLabel.includes('date de sortie') || infoLabel.includes('année') || infoLabel.includes('annee')) {
        const infoValue = $el.find('span.infos').text().trim();
        const yearMatch = infoValue.match(/(\d{4})/);
        if (yearMatch) {
          cpasmalYear = yearMatch[1];
        }
      }
    });

    // Si pas trouvé, chercher avec d'autres sélecteurs
    if (!cpasmalYear) {
      const infosList = $('div.content-info ul li, div.shortpost-info ul li, .fx-info ul li');
      infosList.each((i, el) => {
        const text = $(el).text().toLowerCase();
        if (text.includes('date de sortie') || text.includes('année') || text.includes('annee')) {
          const yearMatch = text.match(/(\d{4})/);
          if (yearMatch) {
            cpasmalYear = yearMatch[1];
          }
        }
      });
    }

    if (process.env.DEBUG_CPASMAL) {
      console.log(`[Cpasmal] Extracted year from page: ${cpasmalYear}`);
    }

    const linkElements = $('.liens-c .lien');

    // Collect all tasks first
    const tasks = [];

    for (let i = 0; i < linkElements.length; i++) {
      const el = linkElements[i];
      const onclick = $(el).attr('onclick');
      // onclick="getxfield('22847', 'netu_vostfr', 'be4b6239bc8f19d5832c98acfe10ba78'); return false;"
      if (onclick && onclick.includes('getxfield')) {
        const match = onclick.match(/getxfield\('([^']*)',\s*'([^']*)',\s*'([^']*)'\)/);
        if (match) {
          const [_, id, xfield, token] = match;
          const isVostfr = xfield.includes('vostfr');
          const isVf = xfield.includes('vf');

          // Prepare the task
          const ajaxUrl = `${CPASMAL_BASE_URL}/engine/ajax/getxfield.php?id=${id}&xfield=${xfield}&token=${token}`;
          tasks.push({ ajaxUrl, xfield, isVostfr, isVf });
        }
      }
    }

    // Execute requests in batches to avoid Event Loop blocking
    const results = [];
    const BATCH_SIZE = 3; // Réduit de 5 à 3 pour moins de charge

    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (task) => {
        await acquireCpasmalSlot(); // Attendre un slot disponible
        try {
          const ajaxResponse = await axiosCpasmalRequest({ method: 'get', url: task.ajaxUrl });
          const iframeMatch = ajaxResponse.data.match(/src="([^"]+)"/);
          if (iframeMatch) {
            return {
              server: task.xfield.split('_')[0],
              url: iframeMatch[1],
              isVostfr: task.isVostfr,
              isVf: task.isVf
            };
          }
          return null;
        } catch (err) {
          console.error(`Error fetching link for ${task.xfield}:`, err.message);
          return null;
        } finally {
          releaseCpasmalSlot(); // Libérer le slot
        }
      }));
      results.push(...batchResults);
      // Délai augmenté pour laisser respirer l'event loop (50ms -> 300ms)
      if (i + BATCH_SIZE < tasks.length) await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Process results
    for (const result of results) {
      if (result) {
        const linkData = { server: result.server, url: result.url };
        if (result.isVostfr) links.vostfr.push(linkData);
        if (result.isVf) links.vf.push(linkData);
      }
    }

    links.vf = sortCpasmalLinks(links.vf);
    links.vostfr = sortCpasmalLinks(links.vostfr);
    if (process.env.DEBUG_CPASMAL) {
      console.timeEnd(`[Cpasmal] ExtractMovieLinks ${url}`);
      console.log(`[Cpasmal] Found ${links.vf.length} VF and ${links.vostfr.length} VOSTFR links`);
    }
    return { links, cpasmalYear };
  } catch (error) {
    console.error('Error extracting movie links:', error.message);
    return { links: { vf: [], vostfr: [] }, cpasmalYear: null };
  }
}

// Helper to extract links from a series episode
async function extractSeriesLinks(seriesUrl, seasonNumber, episodeNumber) {
  if (process.env.DEBUG_CPASMAL) console.time(`[Cpasmal] ExtractSeriesLinks ${seriesUrl}`);
  try {
    const response = await axiosCpasmalRequest({ method: 'get', url: seriesUrl });
    let $ = cheerio.load(response.data);

    // Find season link
    let seasonUrl = null;
    $('.th-seas').each((i, el) => {
      const text = $(el).find('.th-count').text().trim(); // "saison 2"
      if (text.toLowerCase().includes(`saison ${seasonNumber}`)) {
        seasonUrl = $(el).closest('a').attr('href');
      }
    });

    if (!seasonUrl) {
      return { vf: [], vostfr: [] };
    }

    // Construct episode URL
    const episodeUrl = `${seasonUrl.replace('.html', '')}/${episodeNumber}-episode.html`;

    // Fetch episode page
    const epResponse = await axiosCpasmalRequest({ method: 'get', url: episodeUrl });
    $ = cheerio.load(epResponse.data);

    const links = { vf: [], vostfr: [] };
    const linkElements = $('.liens-c .lien');

    // Collect all tasks first
    const tasks = [];

    for (let i = 0; i < linkElements.length; i++) {
      const el = linkElements[i];
      const onclick = $(el).attr('onclick');
      // onclick="playEpisode(this, '129422', 'netu_vf')"
      if (onclick && onclick.includes('playEpisode')) {
        const match = onclick.match(/playEpisode\(this,\s*'([^']*)',\s*'([^']*)'\)/);
        if (match) {
          const [_, id, xfield] = match;
          const isVostfr = xfield.includes('vostfr');
          const isVf = xfield.includes('vf');

          // Post data
          const ajaxUrl = `${CPASMAL_BASE_URL}/engine/inc/serial/app/ajax/Season.php`;
          const params = new URLSearchParams();
          params.append('id', id);
          params.append('xfield', xfield);
          params.append('action', 'playEpisode');

          tasks.push({ ajaxUrl, data: params.toString(), xfield, isVostfr, isVf });
        }
      }
    }

    // Execute requests in batches
    const results = [];
    const BATCH_SIZE = 3; // Réduit de 5 à 3 pour moins de charge

    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const batch = tasks.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (task) => {
        await acquireCpasmalSlot(); // Attendre un slot disponible
        try {
          const ajaxResponse = await axiosCpasmalRequest({
            method: 'post',
            url: task.ajaxUrl,
            data: task.data,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest'
            }
          });

          const iframeMatch = ajaxResponse.data.match(/src="([^"]+)"/);
          if (iframeMatch) {
            return {
              server: task.xfield.split('_')[0],
              url: iframeMatch[1],
              isVostfr: task.isVostfr,
              isVf: task.isVf
            };
          }
          return null;
        } catch (err) {
          console.error(`Error fetching link for ${task.xfield}:`, err.message);
          return null;
        } finally {
          releaseCpasmalSlot(); // Libérer le slot
        }
      }));
      results.push(...batchResults);
      // Délai augmenté pour laisser respirer l'event loop (50ms -> 300ms)
      if (i + BATCH_SIZE < tasks.length) await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Process results
    for (const result of results) {
      if (result) {
        const linkData = { server: result.server, url: result.url };
        if (result.isVostfr) links.vostfr.push(linkData);
        if (result.isVf) links.vf.push(linkData);
      }
    }

    links.vf = sortCpasmalLinks(links.vf);
    links.vostfr = sortCpasmalLinks(links.vostfr);
    if (process.env.DEBUG_CPASMAL) {
      console.timeEnd(`[Cpasmal] ExtractSeriesLinks ${seriesUrl}`);
      console.log(`[Cpasmal] Found ${links.vf.length} VF and ${links.vostfr.length} VOSTFR links`);
    }
    return links;

  } catch (error) {
    console.error('Error extracting series links:', error.message);
    return { vf: [], vostfr: [] };
  }
}

// === DATA FETCHING FUNCTIONS ===

async function fetchCpasmalMovieData(tmdbId, throwOnError = true) {
  const tmdbData = await getTmdbDetails(tmdbId, 'movie');
  if (!tmdbData) {
    if (throwOnError) throw new Error('Movie not found on TMDB');
    return null;
  }

  const title = tmdbData.title;
  const tmdbYear = tmdbData.release_date ? tmdbData.release_date.split('-')[0] : null;

  const cpasmalUrl = await searchCpasmal(title, tmdbYear, 'movie');
  if (!cpasmalUrl) {
    if (throwOnError) throw new Error('Movie not found on Cpasmal');
    return null;
  }

  const { links, cpasmalYear } = await extractMovieLinks(cpasmalUrl);

  // Validation post-match : rejeter si l'année cpasmal ne correspond pas à l'année TMDB
  if (cpasmalYear && tmdbYear && cpasmalYear !== tmdbYear) {
    if (process.env.DEBUG_CPASMAL) {
      console.log(`[Cpasmal] Post-match year mismatch: TMDB=${tmdbYear}, Cpasmal=${cpasmalYear} - rejecting match`);
    }
    if (throwOnError) throw new Error('Movie not found on Cpasmal (year mismatch)');
    return null;
  }

  // Utiliser l'année de cpasmal si disponible, sinon celle de TMDB
  const year = cpasmalYear || tmdbYear;
  return { title, year, cpasmalUrl, links };
}

async function fetchCpasmalTvData(tmdbId, season, episode, throwOnError = true) {
  const tmdbData = await getTmdbDetails(tmdbId, 'tv');
  if (!tmdbData) {
    if (throwOnError) throw new Error('TV Show not found on TMDB');
    return null;
  }

  const title = tmdbData.name;
  const year = tmdbData.first_air_date ? tmdbData.first_air_date.split('-')[0] : null;

  const cpasmalUrl = await searchCpasmal(title, year, 'tv');
  if (!cpasmalUrl) {
    if (throwOnError) throw new Error('TV Show not found on Cpasmal');
    return null;
  }

  if (process.env.DEBUG_CPASMAL) console.log(`[Cpasmal] Start Search & Extract for Movie ${tmdbId}`);
  const links = await extractSeriesLinks(cpasmalUrl, season, episode);
  if (process.env.DEBUG_CPASMAL) console.log(`[Cpasmal] End Search & Extract for Movie ${tmdbId}`);
  return { title, year, cpasmalUrl, links };
}

// === CPASMAL REQUEST DEDUPLICATION ===
// Map pour stocker les promesses en cours d'exécution (éviter les requêtes dupliquées)
const ongoingCpasmalRequests = new Map();

// Fonction pour obtenir ou créer une requête Cpasmal partagée (évite de bloquer le serveur)
const getOrCreateCpasmalRequest = async (cacheKey, requestFunction) => {
  // Si une requête est déjà en cours pour cette clé, retourner la promesse existante
  if (ongoingCpasmalRequests.has(cacheKey)) {
    return ongoingCpasmalRequests.get(cacheKey);
  }

  // Créer une nouvelle promesse avec timeout global
  const requestPromise = (async () => {
    try {
      const result = await Promise.race([
        requestFunction(),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Cpasmal request timeout'));
          }, 15000); // 15s max pour toute la requête
        })
      ]);
      return result;
    } finally {
      // Nettoyer la promesse une fois terminée
      ongoingCpasmalRequests.delete(cacheKey);
    }
  })();

  ongoingCpasmalRequests.set(cacheKey, requestPromise);
  return requestPromise;
};

// === BACKGROUND UPDATE ===

const updateCpasmalCache = async (cacheKey, type, ...args) => {
  try {
    // Vérifier si le cache doit être mis à jour
    const shouldUpdate = await shouldUpdateCache(CACHE_DIR.CPASMAL, cacheKey);
    if (!shouldUpdate) {
      return; // Ne pas mettre à jour le cache s'il est récent
    }

    // Récupérer le cache existant pour le préserver en cas d'erreur
    const existingCache = await getFromCacheNoExpiration(CACHE_DIR.CPASMAL, cacheKey);

    let newData;
    if (type === 'movie') {
      newData = await fetchCpasmalMovieData(args[0], false); // throwOnError = false
    } else if (type === 'tv') {
      newData = await fetchCpasmalTvData(args[0], args[1], args[2], false); // throwOnError = false
    }

    // Ne pas mettre à jour le cache si on n'a pas de nouvelles données ET qu'un cache existe déjà
    if (!newData && existingCache) {
      return; // Garder le cache existant
    }

    if (newData) {
      // Utilisation de fsp.writeFile direct au lieu de safeWriteJsonFile pour éviter atomic writes
      await fsp.writeFile(path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`), JSON.stringify(newData), 'utf-8');
      await memoryCache.set(`cpasmal:${cacheKey}`, newData);
      if (process.env.DEBUG_CPASMAL) console.log(`[Cpasmal Cache] Updated background cache for ${cacheKey}`);
    }
  } catch (error) {
    // En cas d'erreur, ne pas toucher au cache existant
    // console.error(`[Cpasmal Cache] Background update failed for ${cacheKey}:`, error.message);
  }
};

app.get('/api/cpasmal/movie/:tmdbid', async (req, res) => {
  const { tmdbid } = req.params;
  const cacheKey = generateCacheKey(`movie_${tmdbid}`);

  if (process.env.DEBUG_CPASMAL) {
    const used = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`[Cpasmal API] Start /movie/${tmdbid} - Memory: ${Math.round(used * 100) / 100} MB`);
    console.time(`[Cpasmal API] Total /movie/${tmdbid}`);
  }

  try {
    // 1. Try cache
    const cachedData = await getFromCacheNoExpiration(CACHE_DIR.CPASMAL, cacheKey);
    if (cachedData) {
      if (cachedData.notFound) {
        res.status(404).json({ error: 'Movie not found on Cpasmal (Cached)' });
      } else {
        res.json(cachedData);
      }

      // Background update if old
      const cacheFilePath = path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`);
      try {
        const stats = await fsp.stat(cacheFilePath);
        const age = Date.now() - stats.mtime.getTime();
        if (age > 20 * 60 * 1000) { // 20 minutes
          updateCpasmalCache(cacheKey, 'movie', tmdbid);
        }
      } catch (e) { /* ignore */ }
      return;
    }

    // 2. Fetch fresh with deduplication (prevents multiple simultaneous requests from blocking)
    const data = await getOrCreateCpasmalRequest(cacheKey, () => fetchCpasmalMovieData(tmdbid, false));

    if (!data) {
      // Content not found - Cache this state because we had no cache before
      const notFoundData = { notFound: true, tmdbId: tmdbid, timestamp: Date.now() };
      await fsp.writeFile(path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`), JSON.stringify(notFoundData), 'utf-8');
      if (process.env.DEBUG_CPASMAL) console.log(`[Cpasmal API] Caching 'Not Found' for /movie/${tmdbid}`);
      if (process.env.DEBUG_CPASMAL) console.timeEnd(`[Cpasmal API] Total /movie/${tmdbid}`);
      return res.status(404).json({ error: 'Movie not found on Cpasmal' });
    }

    // Utilisation de fsp.writeFile direct au lieu de safeWriteJsonFile pour éviter atomic writes
    await fsp.writeFile(path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`), JSON.stringify(data), 'utf-8');
    await memoryCache.set(`cpasmal:movie:${tmdbid}`, data);
    res.json(data);
    if (process.env.DEBUG_CPASMAL) console.timeEnd(`[Cpasmal API] Total /movie/${tmdbid}`);

  } catch (error) {
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Route pour supprimer le cache d'un film cpasmal
app.get('/api/cpasmal/movie/:tmdbid/clear-cache', async (req, res) => {
  const { tmdbid } = req.params;
  const cacheKey = generateCacheKey(`movie_${tmdbid}`);
  const cacheFilePath = path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`);

  try {
    await fsp.unlink(cacheFilePath);
    console.log(`[Cpasmal Cache] Cache cleared for movie ${tmdbid}`);
    res.json({ success: true, message: `Cache cleared for movie ${tmdbid}` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: `No cache found for movie ${tmdbid}` });
    } else {
      console.error(`[Cpasmal Cache] Error clearing cache for movie ${tmdbid}:`, error.message);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  }
});

app.get('/api/cpasmal/tv/:tmdbid/:season/:episode', async (req, res) => {
  const { tmdbid, season, episode } = req.params;
  const cacheKey = generateCacheKey(`tv_${tmdbid}_s${season}_e${episode}`);

  try {
    // 1. Try cache
    const cachedData = await getFromCacheNoExpiration(CACHE_DIR.CPASMAL, cacheKey);
    if (cachedData) {
      if (cachedData.notFound) {
        res.status(404).json({ error: 'TV Show not found on Cpasmal (Cached)' });
      } else {
        res.json(cachedData);
      }

      // Background update if old
      const cacheFilePath = path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`);
      try {
        const stats = await fsp.stat(cacheFilePath);
        const age = Date.now() - stats.mtime.getTime();
        if (age > 20 * 60 * 1000) { // 20 minutes
          updateCpasmalCache(cacheKey, 'tv', tmdbid, season, episode);
        }
      } catch (e) { /* ignore */ }
      return;
    }

    // 2. Fetch fresh with deduplication (prevents multiple simultaneous requests from blocking)
    const data = await getOrCreateCpasmalRequest(cacheKey, () => fetchCpasmalTvData(tmdbid, season, episode, false));

    if (!data) {
      // Content not found - Cache this state
      const notFoundData = { notFound: true, tmdbId: tmdbid, season, episode, timestamp: Date.now() };
      await fsp.writeFile(path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`), JSON.stringify(notFoundData), 'utf-8');
      return res.status(404).json({ error: 'TV Show not found on Cpasmal' });
    }

    // Utilisation de fsp.writeFile direct au lieu de safeWriteJsonFile pour éviter atomic writes
    await fsp.writeFile(path.join(CACHE_DIR.CPASMAL, `${cacheKey}.json`), JSON.stringify(data), 'utf-8');
    await memoryCache.set(`cpasmal:tv:${tmdbid}:${season}:${episode}`, data);
    res.json(data);

  } catch (error) {
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const frembedHeaders = {
  'Accept': '*/*',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Origin': 'https://frembed.top',
  'Referer': 'https://frembed.top',
  'Host': 'api.frembed.top',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const axiosFrembed = axios.create({
  baseURL: 'https://api.frembed.icu',
  timeout: 10000, // Reduced from 30s to 10s to prevent blocking
  headers: frembedHeaders,
  decompress: true
});

// Configuration Darkino - Headers complets comme dans le script Python qui fonctionne
const darkiHeaders = {
  'accept': 'application/json',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'fr-FR,fr;q=0.6',
  'cache-control': 'no-cache',
  'cookie': 'remember_web_3dc7a913ef5fd4b890ecabe3487085573e16cf82=eyJpdiI6IjNmdEJVb3Z2WWM5U0J5NzEvUmIxUmc9PSIsInZhbHVlIjoicUFPT0lTR3RIbWZFYWg0Z0hjMEUvZGpUc0daVlAyYlk1SkNTbU1Nb2I1MDJveFpCY1VTTnUrMlNRVDJNczN3dEpudTB2RDNPN2l5WkJWT2lRZTBqcUYyNXczNWlJU1J5YnZ2Rk1pZ1cwN3djbytkVVJaeStaSHVjYW1HcWpVQmVwY1VBT0VNSXhkODdETHo3bjdDVEl3WG5vUE5IcHB1b0ljRkV3a0dBc0tuOFJxWXZsMEpwQUxwY2hMY2x6WmxMZGdsTFU0b3B5REFuY1ZwYm5VTDBjWEdPdERhelllbXM2d0VDdGZFNHAyND0iLCJtYWMiOiIyODJlNmYzYjM0MjViNmExNTVlMmVhN2Y4MWY0ZjZhNzdhZmNiMTAxNjYzZTQxZWVjYWVkYzM1MzNiMjhiZmNjIiwidGFnIjoiIn0%3D; SERVERID=S1; connected=1; dbruser=1; XSRF-TOKEN=eyJpdiI6IlQ1Vmh1VS90WTVUWHdVdG5VOVc3WEE9PSIsInZhbHVlIjoidmZQd2Mra1RlL0w0NUZCUmp2ZS9aOFdyM3ZWMU5uYjVLcHZpU3RXQXVHcHhhR0daVGhJU0tTNDRwenNXSW9JNG5RR1ZBVjVLUkE3ayttZXdZSmlUZHFwOGJkWG40YnEvNGt4ajFwTG94YnZyS0VnUnAxNmpzOTRURlpodXRsNjUiLCJtYWMiOiJmY2Y2NTkzZWZiODI3MWRjYTMwYmRjN2FmMTEyNTdhMWMwYjY5OGFkZjdhNTJhMDg2ZDI3MTY5NWQ1ZWIwNzg1IiwidGFnIjoiIn0%3D; darkiworld_session=eyJpdiI6IlVxMDU0bjZPU243azdtTStCVzdBM1E9PSIsInZhbHVlIjoidTdURU5hb0FpN0JMdW5qZUlFZWE2ckxkcWhQVlJYZWI1a2NkR2JpaFBHMFc5Z04ySGFLbE1lTENlR0U5ODBvZ1d0TkdpNGtxUTVaZ3NzUW1wVG11TVl0OGxoZDQyeHkvYnYvUkRBS3YxdTgwdk5FbUpxcDBVcUJiNEpjNDJaTnciLCJtYWMiOiJlNTY2NDRhYjRkMjczZWYyYzU2Yjg1Njk3YmQ3NGI0ZmJlZmU2ODdjZGIxNjI3ZGY0Y2Q0YmEyNzVjNmRjNGRhIiwidGFnIjoiIn0%3D',
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
  'x-xsrf-token': 'eyJpdiI6IlQ1Vmh1VS90WTVUWHdVdG5VOVc3WEE9PSIsInZhbHVlIjoidmZQd2Mra1RlL0w0NUZCUmp2ZS9aOFdyM3ZWMU5uYjVLcHZpU3RXQXVHcHhhR0daVGhJU0tTNDRwenNXSW9JNG5RR1ZBVjVLUkE3ayttZXdZSmlUZHFwOGJkWG40YnEvNGt4ajFwTG94YnZyS0VnUnAxNmpzOTRURlpodXRsNjUiLCJtYWMiOiJmY2Y2NTkzZWZiODI3MWRjYTMwYmRjN2FmMTEyNTdhMWMwYjY5OGFkZjdhNTJhMDg2ZDI3MTY5NWQ1ZWIwNzg1IiwidGFnIjoiIn0='
};

// Configuration Coflix with reduced timeout
const coflixHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Referer': 'https://coflix.observer'
};

const axiosCoflix = axios.create({
  baseURL: COFLIX_BASE_URL,
  timeout: 15000, // 15 seconds timeout
  headers: coflixHeaders,
  decompress: true
});

const cookieJar = new tough.CookieJar();


cookieJar.setCookieSync('remember_web_3dc7a913ef5fd4b890ecabe3487085573e16cf82=eyJpdiI6ImlUSnZySE1CRDg1dVNDcUo0Wm85dGc9PSIsInZhbHVlIjoiQnVQMFZYancwV0kxZEkzWEFmSHZyR3MxZ2Q4VEk2U044K1g1NG5EblljYmNmdU1BZzNBNDdVZlF3QlhmYnBNY0xPeHMxd2dSTG9JNTN2aEtEL05OekIxWFFWQXJkdGUrWWlvRzVHQzdLK2hHZ0thU3UvTHJpZHNPanpJQmJzMk5TTjFjVkY4NGMrQXVFcnJaQ0ZqOTZMUWwwZFh5UW8rZkI1TXZxL254ekEvTjdQaURKdnIxcXNwY0I4VGZwaGQrMzRtNVZHRUN3YVpGQ3dacmFLMDZ2V0RuVnl2YUJuYjRMZTRPa3hyK0IzST0iLCJtYWMiOiI1ZjNiNjRhYjc0NWM4NmZjZDU2YWE1ZTZmNTgyYzU0MWYwM2EwZTI4ZjM1ZTU0YWRlYTFlOGNjMTk5NDIyM2JmIiwidGFnIjoiIn0%3D', 'https://darkiworld2026.com');
cookieJar.setCookieSync('SERVERID=S1', 'https://darkiworld2026.com');
cookieJar.setCookieSync('XSRF-TOKEN=eyJpdiI6IllVSmNUN3J3cEVTdWErMlBySzhkNmc9PSIsInZhbHVlIjoiR3hmSmluY0dQYlI0cHFENjJlZUtTR3BYOGhZQVlqUysrcHlIeTVqK2R6aU1FZEhjeWgvTDJKLy9KM2t1WHZ1M0l4Wk5KY3ZBM1RqV3lnNVV4RVJaNmdOR2c5QzI3WnpYSUh5OXpybDBwSUtneWdZR1lhcUdNK0lwalhBUilmNTEiLCJtYWMiOiI2MTNlZTk4Nzk2NTAxN2VhY2FjNmQ2NmJhMTQzZmZlNzMzYTg2YTQ0ZWU0M2VjOTA1ODhlN2Y0YTMxMTIyNzE4IiwidGFnIjoiIn0%3D', 'https://darkiworld2026.com');
cookieJar.setCookieSync('darkiworld_session=eyJpdiI6IlVHUmIzbWNrWlUwc0dRaGtoLzFManc9PSIsInZhbHVlIjoiNSswRnRHc085cWJ3RmRwU0xjNm1UVVRLbTJkVVdiYjVkTFVtY3htS1habVBlMmkyZVVFQlEzem9hL1Jab3RhRnZEaEU5ZmpudkJONnFUUEw3dFpzdTNibUYyZzZZWmhyeFhvYnBid0RPQ0V6cHlYSEFjYW53R05vc3Y3TkhNcEgiLCJtYWMiOiJlMDZjNjlkMDIzNGU2Y2E1MGExODVkNTgzYzBhYzhhNjg0MmU2MGU3MWI4ODkzMTNmMzIzZDA4MGM5MDgwMTg3IiwidGFnIjoiIn0%3D', 'https://darkiworld2026.com');


const axiosDarkino = wrapper(axios.create({
  baseURL: 'https://darkiworld2026.com',
  timeout: 5000,
  jar: cookieJar,
  withCredentials: true,
  headers: darkiHeaders
}));

axiosDarkino.interceptors.response.use(null, async (error) => {
  // Create retry config if it doesn't exist
  if (!error.config) {
    // If the config doesn't exist, we can't retry. This usually happens due to proxy issues.
    return Promise.reject(error);
  }

  if (typeof error.config.__retryCount === 'undefined') {
    error.config.__retryCount = 0;
  }

  // Keep max retries at 1 to prevent server overload
  if (error.config.__retryCount < 1) {
    error.config.__retryCount++;

    // Use a more reasonable backoff with shorter delays
    const delay = Math.min(1000 * Math.pow(1.5, error.config.__retryCount), 5000) + (Math.random() * 500);
    // Suppression du log de retry
    //console.log(`Retry attempt ${error.config.__retryCount} for ${error.config.url} after ${Math.round(delay)}ms delay`);

    // For Cloudflare 403 or 522 errors, don't retry as they won't succeed without solving the challenge
    if (error.response && (error.response.status === 403 || error.response.status === 522)) {
      //console.log(`Cloudflare protection (${error.response.status}) detected, not retrying`);
      return Promise.reject(error);
    }

    // Only retry for server errors or network issues, not for 403 Forbidden
    if ((error.response && error.response.status >= 500) || !error.response) {
      //console.log(`Server error (${error.response?.status || 'network error'}), retrying...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return axiosDarkino(error.config);
    }

    // Standard retry for other errors
    await new Promise(resolve => setTimeout(resolve, delay));
    return axiosDarkino(error.config);
  }

  // If we exhausted retries, reject with the original error
  //console.log(`Max retries (${error.config.__retryCount}) reached for ${error.config.url}`);
  return Promise.reject(error);
});

app.get('/movies/check/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axiosFrembed.get(`/movies/check?id=${id}`);
    res.status(200).json(response.data);
  } catch (error) {
    console.error(`Erreur Frembed: ${error.response?.status || 'Erreur réseau'}`);
    res.status(500).json({ error: 'Erreur lors de la vérification du film' });
  }
});

app.get('/movies', async (req, res) => {
  try {
    const { page = 1, limit = 100, order = 'popular' } = req.query;
    const response = await axiosFrembed.get('/movies', { params: { order, limit, page } });
    res.status(200).json(response.data);
  } catch (error) {
    console.error(`Erreur Frembed: ${error.response?.status || 'Erreur réseau'}`);
    res.status(500).json({ error: 'Erreur lors de la récupération des films' });
  }
});

app.get('/tv/check/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { sa, epi } = req.query;
    const response = await axiosFrembed.get('/tv/check', { params: { id, sa, epi } });
    res.status(200).json(response.data);
  } catch (error) {
    console.error(`Erreur Frembed: ${error.response?.status || 'Erreur réseau'}`);
    res.status(500).json({ error: 'Erreur lors de la vérification de la série' });
  }
});

app.get('/tv', async (req, res) => {
  try {
    const { page = 1, limit = 100, order = 'popular' } = req.query;
    const response = await axiosFrembed.get('/tv', { params: { order, limit, page } });
    res.status(200).json(response.data);
  } catch (error) {
    console.error(`Erreur Frembed: ${error.response?.status || 'Erreur réseau'}`);
    res.status(500).json({ error: 'Erreur lors de la récupération des séries' });
  }
});

app.get('/api/search', async (req, res) => {

  try {
    const { title } = req.query;
    if (!title) return res.status(400).json({ error: 'Le paramètre title est requis' });
    const sanitizedTitle = String(title).replace(/\//g, '').trim();
    if (!sanitizedTitle) return res.status(400).json({ error: 'Le paramètre title est invalide' });

    // Generate cache key
    const cacheKey = generateCacheKey(`api_search_${sanitizedTitle}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    let dataReturned = false;

    if (cachedData) {
      // console.log(`Résultats de recherche pour "${title}" récupérés du cache`);
      res.status(200).json(cachedData); // Return cached data immediately
      dataReturned = true;

      // Update cache in background only if no error occurs
      (async () => {
        try {
          // Vérifier si le cache doit être mis à jour
          const shouldUpdate = await shouldUpdateCache(DARKINOS_CACHE_DIR, cacheKey);
          if (!shouldUpdate) {
            return; // Ne pas mettre à jour le cache
          }

          const response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/search/${encodeURIComponent(sanitizedTitle)}`, params: { loader: 'searchPage' } });

          // Validation: s'assurer que la réponse est du JSON valide et non du texte "Maintenance en cours"
          if (typeof response.data === 'string' && response.data.includes('Maintenance en cours')) {
            throw new Error('Maintenance en cours - pas de mise à jour du cache');
          }

          // Vérifier que c'est bien un objet JSON et non du texte brut
          if (typeof response.data === 'string' || response.data === null || response.data === undefined) {
            throw new Error('Réponse invalide - pas de mise à jour du cache');
          }

          // Si on a des données valides, sauvegarder dans le cache
          if (response.data) {
            await saveToCache(DARKINOS_CACHE_DIR, cacheKey, response.data);
          }
        } catch (error) {
          // Silent fail on background update
        }
      })();
    } else {
      // Si en maintenance et pas de cache, erreur
      if (DARKINO_MAINTENANCE) {
        return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
      }
      // No cache, get data synchronously
      try {
        const fetchFunction = async () => {
          const response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/search/${encodeURIComponent(sanitizedTitle)}`, params: { loader: 'searchPage' } });

          // Validation: s'assurer que la réponse est du JSON valide et non du texte "Maintenance en cours"
          if (typeof response.data === 'string' && response.data.includes('Maintenance en cours')) {
            console.error('Darkino API retourne "Maintenance en cours" - ne pas sauvegarder en cache');
            throw new Error('Maintenance en cours - données invalides');
          }

          // Vérifier que c'est bien un objet JSON et non du texte brut
          if (typeof response.data === 'string' || response.data === null || response.data === undefined) {
            console.error('Darkino API retourne une réponse invalide (non-JSON) - ne pas sauvegarder en cache');
            throw new Error('Réponse invalide - données non-JSON');
          }

          return response.data;
        };

        // Use the updateDarkinosCache function for data fetching with proper retry behavior
        const data = await fetchFunction();

        // If we got data, save it to cache and return
        if (data) {
          await saveToCache(DARKINOS_CACHE_DIR, cacheKey, data);
          res.status(200).json(data);
        } else {
          res.status(404).json({ error: 'Aucun résultat trouvé' });
        }
      } catch (error) {
        if (error.response && error.response.status >= 500) {
          // Si on a déjà retourné des données (cache), on ne fait RIEN
          if (dataReturned) return;

          try {
            const fallbackCache = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
            if (fallbackCache) {
              return res.status(200).json(fallbackCache);
            }
          } catch (_) { }
        }
        res.status(500).json({ error: 'Erreur lors de la recherche' });
      }
    }
  } catch (error) {
    console.error(`Erreur API Darkino Search: ${error.response?.status || 'Erreur réseau'}`);
    if (!res.headersSent) {
      try {
        const { title } = req.query;
        const sanitizedTitle = String(title || '').replace(/\//g, '').trim();
        const cacheKey = generateCacheKey(`api_search_${sanitizedTitle}`);
        const fallbackCache = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
        if (error.response && error.response.status >= 500 && fallbackCache) {
          return res.status(200).json(fallbackCache);
        }
      } catch (_) { }
      res.status(500).json({ error: 'Erreur lors de la recherche' });
    }
  }
});



// Function to validate if an m3u8 URL is accessible
const validateM3u8Url = async (m3u8Url, useProxy = false) => {
  if (!m3u8Url) return { isValid: false, quality: null };

  let proxy = null;
  let agent = null;
  if (useProxy && ENABLE_DARKINO_PROXY) {
    proxy = pickRandomProxyOrNone();
    agent = getProxyAgent(proxy);
    if (proxy) {
      // console.log(`[PROXY] Utilisation du proxy ${proxy.host}:${proxy.port} pour valider m3u8`);
    } else {
      // console.log(`[PROXY] Pas de proxy utilisé pour valider m3u8`);
    }
  }

  try {
    // console.log(`[VALIDATE_M3U8] Validating m3u8 URL: ${m3u8Url}`);
    const response = await axios.get(m3u8Url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.5",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site"
      },
      timeout: 2000, // 5 second timeout for validation
      validateStatus: (status) => status === 200, // Only accept 200 status
      decompress: true,
      ...(agent ? { httpsAgent: agent, httpAgent: agent } : {})
    });

    // Check if the response has the expected m3u8 content
    const contentType = response.headers['content-type'];
    const isValidContent = contentType && (
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      contentType.includes('audio/mpegurl') ||
      contentType.includes('text/plain') // Some servers use text/plain for m3u8
    );

    // Also check content for m3u8 signature
    const isValidM3u8 = response.data &&
      (typeof response.data === 'string' &&
        (response.data.includes('#EXTM3U') ||
          response.data.includes('#EXT-X-VERSION')));

    const isValid = isValidContent || isValidM3u8;

    // If valid, detect quality directly from the response content
    let quality = null;
    if (isValid && response.data && typeof response.data === 'string') {
      const content = response.data;

      // Look for resolution information in the m3u8 content
      const resolutionMatch = content.match(/RESOLUTION=(\d+x\d+)/i);
      if (resolutionMatch) {
        const resolution = resolutionMatch[1];
        const [width, height] = resolution.split('x').map(Number);

        // Determine quality based on resolution
        if (width >= 3840 || height >= 2160) quality = "4K";
        else if (width >= 1920 || height >= 1080) quality = "1080p";
        else if (width >= 1280 || height >= 720) quality = "720p";
        else if (width >= 854 || height >= 480) quality = "480p";
        else if (width >= 640 || height >= 360) quality = "360p";
        else quality = `${height}p`;
      } else {
        // Look for quality indicators in stream names
        const qualityMatch = content.match(/(\d+p|4k|hd|sd)/gi);
        if (qualityMatch) {
          const qualityStr = qualityMatch[0].toLowerCase();
          if (qualityStr.includes('4k')) quality = "4K";
          else if (qualityStr.includes('1080p') || qualityStr.includes('hd')) quality = "1080p";
          else if (qualityStr.includes('720p')) quality = "720p";
          else if (qualityStr.includes('480p')) quality = "480p";
          else if (qualityStr.includes('360p')) quality = "360p";
          else quality = qualityStr.toUpperCase();
        }
      }
    }

    // console.log(`[VALIDATE_M3U8] URL: ${m3u8Url}, ContentType: ${contentType}, isValidContent: ${isValidContent}, isValidM3u8: ${isValidM3u8}, Quality: ${quality}`);
    return { isValid, quality };
  } catch (error) {
    return { isValid: false, quality: null };
  }
};

// Modify extractM3u8Url function
const extractM3u8Url = async (darkiboxUrl) => {
  try {
    let proxy = null;
    let agent = null; // Proxy désactivé pour l'extraction M3U8
    const axiosPromise = axios.get(darkiboxUrl, {

      ...(agent ? { httpsAgent: agent, httpAgent: agent } : {}),

    });

    const timeoutPromise = new Promise((_, reject) =>

      setTimeout(() => reject(new Error("Request timed out (manual)")), 4500)

    );

    const response = await Promise.race([axiosPromise, timeoutPromise]);
    const htmlContent = response.data;
    const playerConfigMatch = htmlContent.match(/sources:\s*\[\s*{\s*src:\s*"([^"]+)"/);
    if (playerConfigMatch && playerConfigMatch[1]) {
      const m3u8Url = playerConfigMatch[1];
      // Validate the m3u8 URL before returning it
      const validation = await validateM3u8Url(m3u8Url, false);
      return validation.isValid ? { url: m3u8Url, quality: validation.quality } : null;
    }
    return null;
  } catch (error) {
    // Ne pas logger les erreurs 500/403 pour EXTRACT_M3U8
    if (!error.response || (error.response.status !== 500 && error.response.status !== 403)) {
      if (error.message.includes("Request timed out")) {
        console.error(`[EXTRACT_M3U8] Timeout (8s) lors de l'extraction depuis ${darkiboxUrl} - serveur trop lent`);
      } else {
        console.error(`[EXTRACT_M3U8] Error processing ${darkiboxUrl}: ${error.response?.status || 'Erreur réseau'}`, error.message);
      }
    }
    return null;
  }
};

// Créer un répertoire pour le cache Darkinos si nécessaire
const DARKINOS_CACHE_DIR = path.join(__dirname, 'cache', 'darkinos');
(async () => {
  try {
    await fsp.access(DARKINOS_CACHE_DIR);
  } catch {
    await fsp.mkdir(DARKINOS_CACHE_DIR, { recursive: true });
  }
})();

// Créer un répertoire pour le cache des téléchargements et décodages
const DOWNLOAD_CACHE_DIR = path.join(__dirname, 'cache', 'darkinodownloadlink');
(async () => {
  try {
    await fsp.access(DOWNLOAD_CACHE_DIR);
  } catch {
    await fsp.mkdir(DOWNLOAD_CACHE_DIR, { recursive: true });
  }
})();

// Créer un répertoire pour le cache des vidéos externes
const EXTERNAL_VIDEOS_CACHE_DIR = path.join(__dirname, 'cache', 'external_videos');
(async () => {
  try {
    await fsp.access(EXTERNAL_VIDEOS_CACHE_DIR);
  } catch {
    await fsp.mkdir(EXTERNAL_VIDEOS_CACHE_DIR, { recursive: true });
  }
})();

// Fonction utilitaire pour vérifier si un fichier de cache a été modifié dans les 40 dernières minutes
const shouldUpdateCache = async (cacheDir, cacheKey) => {
  const cacheFilePath = path.join(cacheDir, `${cacheKey}.json`);
  try {
    const stats = await fsp.stat(cacheFilePath);
    const now = Date.now();
    const fileAge = now - stats.mtime.getTime();
    const fortyMinutes = 40 * 60 * 1000; // 40 minutes en millisecondes

    if (fileAge < fortyMinutes) {
      return false; // Ne pas mettre à jour le cache
    }
    return true; // Mettre à jour le cache
  } catch (error) {
    // Si le fichier n'existe pas ou erreur de lecture, continuer avec la mise à jour
    return true;
  }
};

// Fonction pour vérifier si le cache French-Stream doit être mis à jour (20 minutes)
const shouldUpdateCacheFrenchStream = async (cacheDir, cacheKey) => {
  const cacheFilePath = path.join(cacheDir, `${cacheKey}.json`);
  try {
    const stats = await fsp.stat(cacheFilePath);
    const now = Date.now();
    const fileAge = now - stats.mtime.getTime();
    const twentyMinutes = 3 * 60 * 60 * 1000; // 3 heures en millisecondes

    if (fileAge < twentyMinutes) {
      return false; // Ne pas mettre à jour le cache
    }
    return true; // Mettre à jour le cache
  } catch (error) {
    // Si le fichier n'existe pas ou erreur de lecture, continuer avec la mise à jour
    return true;
  }
};

// Fonction pour vérifier si le cache LecteurVideo doit être mis à jour (2 heures)
const shouldUpdateCacheLecteurVideo = async (cacheDir, cacheKey) => {
  const cacheFilePath = path.join(cacheDir, `${cacheKey}.json`);
  try {
    const stats = await fsp.stat(cacheFilePath);
    const now = Date.now();
    const fileAge = now - stats.mtime.getTime();
    const twoHours = 2 * 60 * 60 * 1000; // 2 heures en millisecondes

    if (fileAge < twoHours) {
      return false; // Ne pas mettre à jour le cache
    }
    return true; // Mettre à jour le cache
  } catch (error) {
    // Si le fichier n'existe pas ou erreur de lecture, continuer avec la mise à jour
    return true;
  }
};

// Fonction pour vérifier si le cache doit être mis à jour (24 heures) - utilisée pour la route decode
const shouldUpdateCache24h = async (cacheDir, cacheKey) => {
  const cacheFilePath = path.join(cacheDir, `${cacheKey}.json`);
  try {
    const stats = await fsp.stat(cacheFilePath);
    const now = Date.now();
    const fileAge = now - stats.mtime.getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000; // 24 heures en millisecondes

    if (fileAge < twentyFourHours) {
      return false; // Ne pas mettre à jour le cache
    }
    return true; // Mettre à jour le cache
  } catch (error) {
    // Si le fichier n'existe pas ou erreur de lecture, continuer avec la mise à jour
    return true;
  }
};

// Fonction pour mettre à jour le cache en arrière-plan
const updateDarkinosCache = async (cacheKey, fetchFunction) => {
  try {
    //console.log(`Mise à jour du cache en arrière-plan pour ${cacheKey}`);

    // Vérifier si le fichier a été modifié dans les 40 dernières minutes
    const shouldUpdate = await shouldUpdateCache(DARKINOS_CACHE_DIR, cacheKey);
    if (!shouldUpdate) {
      //console.log(`Cache ${cacheKey} modifié il y a moins de 40 minutes, pas de mise à jour en arrière-plan`);
      return; // Ne pas mettre à jour le cache
    }

    // Try up to 2 times maximum with a backoff delay
    let attempts = 0;
    const maxAttempts = 1;
    let lastError = null;

    while (attempts < maxAttempts) {
      try {
        const newData = await fetchFunction();

        // Validation: s'assurer que les données ne sont pas du texte "Maintenance en cours"
        if (typeof newData === 'string' && newData.includes('Maintenance en cours')) {
          console.error(`Données invalides (Maintenance en cours) pour ${cacheKey} - ne pas mettre à jour le cache`);
          throw new Error('Maintenance en cours - données invalides');
        }

        // Vérifier que c'est bien un objet JSON et non du texte brut
        if (typeof newData === 'string' || newData === null || newData === undefined) {
          console.error(`Données invalides (non-JSON) pour ${cacheKey} - ne pas mettre à jour le cache`);
          throw new Error('Données invalides - non-JSON');
        }

        if (newData) {
          await saveToCache(DARKINOS_CACHE_DIR, cacheKey, newData);
          //console.log(`Cache mis à jour pour ${cacheKey}`);
          return;
        }
        // If we got here with no data but no error, break the loop
        break;
      } catch (error) {
        attempts++;
        lastError = error;

        // If it's a Cloudflare 403 error, don't retry
        if (error.response && error.response.status === 403) {
          //console.log(`Cloudflare protection (403) détectée pour ${cacheKey}, abandon des tentatives`);
          break;
        }

        // Only retry server errors or network issues
        if ((error.response && error.response.status >= 500) || !error.response) {
          const delay = 2000 * attempts;
          //console.log(`Erreur lors de la tentative ${attempts}/${maxAttempts} pour ${cacheKey}. Nouvel essai dans ${delay/1000} secondes...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // For other errors, don't retry
          break;
        }
      }
    }

    // If we got here, all attempts failed - don't update cache
    if (lastError) {
      // Ne pas mettre à jour le cache en cas d'erreur
      return;
    }
  } catch (error) {
    console.error(`Erreur Darkino cache: ${error.response?.status || 'Erreur réseau'}`);
    // Ne pas mettre à jour le cache en cas d'erreur
  }
};

// Fonction pour mettre à jour le cache LecteurVideo en arrière-plan (similaire à DarkiWorld)
const updateLecteurVideoCache = async (cacheKey, fetchFunction) => {
  try {
    //console.log(`Mise à jour du cache LecteurVideo en arrière-plan pour ${cacheKey}`);

    // Vérifier si le fichier a été modifié dans les 2 dernières heures
    const shouldUpdate = await shouldUpdateCacheLecteurVideo(CACHE_DIR.COFLIX, cacheKey);
    if (!shouldUpdate) {
      //console.log(`Cache LecteurVideo ${cacheKey} modifié il y a moins de 2 heures, pas de mise à jour en arrière-plan`);
      return; // Ne pas mettre à jour le cache
    }

    // Try up to 1 time maximum
    let attempts = 0;
    const maxAttempts = 1;
    let lastError = null;

    while (attempts < maxAttempts) {
      try {
        const newData = await fetchFunction();

        // Validation: s'assurer que les données ne sont pas vides ou invalides
        if (typeof newData === 'string' && newData.includes('Maintenance en cours')) {
          console.error(`Données invalides (Maintenance en cours) pour ${cacheKey} - ne pas mettre à jour le cache`);
          throw new Error('Maintenance en cours - données invalides');
        }

        // Vérifier que c'est bien un objet JSON et non du texte brut
        if (typeof newData === 'string' || newData === null || newData === undefined) {
          console.error(`Données invalides (non-JSON) pour ${cacheKey} - ne pas mettre à jour le cache`);
          throw new Error('Données invalides - non-JSON');
        }

        if (newData) {
          await saveToCache(CACHE_DIR.COFLIX, cacheKey, newData);
          //console.log(`Cache LecteurVideo mis à jour pour ${cacheKey}`);
          return;
        }
        // If we got here with no data but no error, break the loop
        break;
      } catch (error) {
        attempts++;
        lastError = error;
        console.error(`Erreur lors de la mise à jour du cache LecteurVideo pour ${cacheKey} (tentative ${attempts}/${maxAttempts}):`, error.message);

        if (attempts < maxAttempts) {
          // Attendre un peu avant de réessayer
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }
    }

    if (lastError) {
      console.error(`Échec de la mise à jour du cache LecteurVideo pour ${cacheKey} après ${maxAttempts} tentatives:`, lastError.message);
    }
  } catch (error) {
    console.error(`Erreur générale lors de la mise à jour du cache LecteurVideo pour ${cacheKey}:`, error);
  }
};

// Fonction pour mettre à jour le cache Wiflix en arrière-plan
const updateWiflixCache = async (cacheDir, cacheKey, type, tmdbId, season = null) => {
  try {
    // Récupérer le cache existant pour le préserver en cas d'erreur
    const existingCache = await getFromCacheNoExpiration(cacheDir, cacheKey);

    // Try up to 2 times maximum with a backoff delay
    let attempts = 0;
    const maxAttempts = 1;
    let lastError = null;

    while (attempts < maxAttempts) {
      try {
        let newData;

        // Appeler la fonction appropriée selon le type, en passant le cache existant
        if (type === 'movie') {
          newData = await fetchWiflixMovieData(tmdbId, existingCache);
        } else if (type === 'tv') {
          newData = await fetchWiflixTvData(tmdbId, season, existingCache);
        } else {
          throw new Error(`Type non supporté: ${type}`);
        }

        // Validation: s'assurer que les données ne sont pas invalides
        if (typeof newData === 'string' && newData.includes('Maintenance en cours')) {
          console.error(`Données invalides (Maintenance en cours) pour ${cacheKey} - ne pas mettre à jour le cache`);
          throw new Error('Maintenance en cours - données invalides');
        }

        // Vérifier que c'est bien un objet JSON et non du texte brut
        if (typeof newData === 'string' || newData === null || newData === undefined) {
          console.error(`Données invalides (non-JSON) pour ${cacheKey} - ne pas mettre à jour le cache`);
          throw new Error('Données invalides - non-JSON');
        }

        if (newData) {
          // Vérifier si les nouvelles données sont valides avant de mettre à jour
          // Ne pas mettre à jour si les données indiquent un échec ET qu'un cache existait
          const isFailedResult = newData.success === false;

          if (isFailedResult && existingCache) {
            return; // Ne pas mettre à jour le cache avec des données d'échec
          }

          await saveToCache(cacheDir, cacheKey, newData);
          //console.log(`Cache Wiflix mis à jour pour ${cacheKey}`);
          return;
        }
        // If we got here with no data but no error, break the loop
        break;
      } catch (error) {
        attempts++;
        lastError = error;

        // If it's a Cloudflare 403 error, don't retry
        if (error.response && error.response.status === 403) {
          //console.log(`Cloudflare protection (403) détectée pour ${cacheKey}, abandon des tentatives`);
          break;
        }

        // Only retry server errors or network issues
        if ((error.response && error.response.status >= 500) || !error.response) {
          const delay = 2000 * attempts;
          //console.log(`Erreur lors de la tentative ${attempts}/${maxAttempts} pour ${cacheKey}. Nouvel essai dans ${delay/1000} secondes...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // For other errors, don't retry
          break;
        }
      }
    }

    // If we got here, all attempts failed - don't update cache
    if (lastError) {
      // Ne pas mettre à jour le cache en cas d'erreur
      return;
    }
  } catch (error) {
    console.error(`Erreur Wiflix cache: ${error.response?.status || 'Erreur réseau'}`);
    // Ne pas mettre à jour le cache en cas d'erreur
  }
};
app.get('/api/films/download/:id', async (req, res) => {
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
          // Aucun m3u8 valide dans le cache, on force la ré-extraction
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
      // Retourner les sources dédupliquées et filtrées
      res.status(200).json({ sources: filteredSources });
      dataReturned = true;
      (async () => {
        try {
          // Vérifier si le cache doit être mis à jour
          const shouldUpdate = await shouldUpdateCache(DARKINOS_CACHE_DIR, cacheKey);
          if (!shouldUpdate) {
            return; // Ne pas mettre à jour le cache
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
    // Si pas de cache valide, comportement normal (requête Darkino)
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
        if (error.response?.data?.message === "Il y a eu un problème. Veuillez réessayer plus tard.") {
          throw error;
        }

        // Arrêter immédiatement sur les erreurs 500/403
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
            // Extraire l'ID du lien darkibox
            let idMatch = lienObj.lien.match(/(?:\/d\/|\/)([a-z0-9]{12,})/i);
            let darkiboxId = idMatch ? idMatch[1] : null;
            let m3u8Url = null;
            let embedUrl = null;
            if (darkiboxId) {
              embedUrl = `https://darkibox.com/embed-${darkiboxId}.html`;
              m3u8Url = await extractM3u8Url(embedUrl);
            }
            // Find the original entry for quality/language info
            const meta = darkiboxEntries.find(e => e.id === lienObj.id);
            return m3u8Url ? {
              src: embedUrl, // Toujours l'embed comme src
              m3u8: m3u8Url,
              language: (meta?.langues_compact && meta.langues_compact.length > 0) ? meta.langues_compact.map(l => l.name).join(', ') : undefined,
              quality: meta?.qual?.qual,
              sub: (meta?.subs_compact && meta.subs_compact.length > 0) ? meta.subs_compact.map(s => s.name).join(', ') : undefined,
              provider: 'darkibox'
            } : null;
          }));
          // Only keep valid ones
          const validDarkiboxSources = darkiboxSources.filter(Boolean);
          // Merge with basicSources (but don't duplicate by src)
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
          // If m3u8 already exists, validate it and get quality
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
            // If m3u8 already exists, validate it and get quality
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
    // Retourner les sources dédupliquées et filtrées
    res.status(200).json({ sources: filteredSources });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la récupération des liens de téléchargement' });
  }
});
app.get('/api/series/download/:titleId/season/:seasonId/episode/:episodeId', async (req, res) => {
  if (DARKINO_MAINTENANCE) {
    return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
  }
  try {
    const { titleId, seasonId, episodeId } = req.params;
    //console.log(`[API/SERIES/DOWNLOAD] Request for ${titleId}/${seasonId}/${episodeId}`);
    const cacheKey = generateCacheKey(`series_download_${titleId}_${seasonId}_${episodeId}`);
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    if (cachedData) {
      // console.log(`[API/SERIES/DOWNLOAD] Cached data content:`, JSON.stringify(cachedData, null, 2));
    }
    const M3U8_CACHE_EXPIRY = 8 * 60 * 60 * 1000; // 8 hours in milliseconds

    let dataReturned = false;
    if (cachedData && cachedData.sources !== undefined) {
      // console.log(`[API/SERIES/DOWNLOAD] Found cached data for ${cacheKey}`);
      const now = Date.now();
      const needM3u8Refresh = !cachedData.m3u8Timestamp ||
        (now - cachedData.m3u8Timestamp > M3U8_CACHE_EXPIRY);
      // console.log(`[API/SERIES/DOWNLOAD] M3U8 cache for ${cacheKey} needs refresh: ${needM3u8Refresh}`);

      let sourcesWithM3u8;
      let validSources = [];

      // Check if we have a non-expired m3u8 cache
      if (!needM3u8Refresh && cachedData.sourcesWithM3u8) {
        sourcesWithM3u8 = cachedData.sourcesWithM3u8;
        validSources = sourcesWithM3u8.filter(source => source.m3u8);
      }

      // If the cache is expired OR if the non-expired cache has no valid links, re-extract.
      if (needM3u8Refresh || validSources.length === 0) {
        // console.log(`[API/SERIES/DOWNLOAD] Re-extracting m3u8. Reason: ${needM3u8Refresh ? 'cache expired' : 'no valid m3u8 in cache'}.`);
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

        const newCacheData = {
          ...cachedData,
          sourcesWithM3u8: sourcesWithM3u8,
          m3u8Timestamp: Date.now()
        };
        await saveToCache(DARKINOS_CACHE_DIR, cacheKey, newCacheData);
        validSources = sourcesWithM3u8.filter(source => source.m3u8); // Recalculate valid sources
      }

      // console.log(`[API/SERIES/DOWNLOAD] Sending ${validSources.length} sources from cache for ${titleId}/${seasonId}/${episodeId}`);
      const dedupedSources = deduplicateSourcesWithPreference(validSources);
      const filteredSources = dedupedSources.filter(source => source.m3u8);
      res.status(200).json({ sources: filteredSources });
      dataReturned = true;

      (async () => {
        try {
          // Vérifier si le cache doit être mis à jour
          const shouldUpdate = await shouldUpdateCache(DARKINOS_CACHE_DIR, cacheKey);
          if (!shouldUpdate) {
            return; // Ne pas mettre à jour le cache
          }

          await refreshDarkinoSessionIfNeeded();
          const response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/titles/${titleId}/season/${seasonId}/episode/${episodeId}/download`, headers: darkiHeaders });
          let freshSources = response.data.alternative_videos || [];
          if (response.data.video) {
            freshSources.unshift(response.data.video);
          }
          // Filtrer les sources pour l'épisode demandé
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
              // console.log(`[API/SERIES/DOWNLOAD] Background cache updated for ${cacheKey}`);
            }
          }
        } catch (refreshError) {
          // Silent fail on background refresh
        }
      })();
      return;
    }
    // Si pas de cache valide, comportement normal (requête Darkino)
    // console.log(`[API/SERIES/DOWNLOAD] No valid cache for ${cacheKey}, fetching from Darkino...`);
    const maxRetries = 3;
    let retryCount = 0;
    let response;
    let success = false;
    await refreshDarkinoSessionIfNeeded();
    while (!success && retryCount < maxRetries) {
      try {
        console.log(`Tentative ${retryCount + 1}/${maxRetries} pour récupérer les données de ${titleId}/season/${seasonId}/episode/${episodeId}`);
        response = await axiosDarkinoRequest({ method: 'get', url: `/api/v1/titles/${titleId}/season/${seasonId}/episode/${episodeId}/download`, headers: darkiHeaders });
        //console.log(`[API/SERIES/DOWNLOAD] Darkino response data:`, JSON.stringify(response.data, null, 2));
        success = true;
      } catch (error) {
        // Check if the error response contains the specific message that indicates we shouldn't retry
        if (error.response?.data?.message === "Il y a eu un problème. Veuillez réessayer plus tard.") {
          console.log(`Erreur Darkino définitive: ${error.response.data.message}. Arrêt des tentatives.`);
          throw error;
        }

        // Arrêter immédiatement sur les erreurs 500/403
        if (error.response && (error.response.status === 500 || error.response.status === 403)) {
          throw error;
        }

        retryCount++;
        if (retryCount >= maxRetries) {
          throw error;
        }
        const delay = Math.min(2000 * Math.pow(2, retryCount), 30000) + (Math.random() * 1000);
        console.log(`Erreur lors de la tentative ${retryCount}. Nouvel essai dans ${Math.round(delay / 1000)} secondes...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    let sources = response.data.alternative_videos || [];
    if (response.data.video) {
      sources.unshift(response.data.video);
    }
    // Filtrer les sources pour l'épisode demandé
    sources = sources.filter(source => {
      return !source.episode || source.episode.toString() === episodeId.toString();
    });
    // console.log(`[API/SERIES/DOWNLOAD] Got ${sources.length} sources from Darkino for ${cacheKey}`);
    const basicSources = sources.map(source => ({
      src: source.src,
      language: source.language,
      quality: source.quality,
      sub: source.sub
    }));

    // --- DARKIBOX ENHANCEMENT START ---
    if (darkiworld_premium) {
      try {
        // 1. Paginer intelligemment pour trouver l'épisode
        const darkiboxEntries = await findDarkiboxEntriesForEpisode({ titleId, seasonId, episodeId, perPage: 100, maxPages: 10 });
        const darkiboxIds = darkiboxEntries.map(entry => entry.id);
        if (darkiboxIds.length > 0) {
          // 2. POST to download-premium with all darkibox IDs
          const darkiboxDownloadResp = await axiosDarkinoRequest({ method: 'post', url: `/api/v1/download-premium/${darkiboxIds.join(',')}` });
          const darkiboxLinks = (darkiboxDownloadResp.data?.liens || []).filter(l => l.lien && l.lien.includes('darkibox.com'));
          // 3. For each link, extract m3u8
          const darkiboxSources = await Promise.all(darkiboxLinks.map(async (lienObj) => {
            // Extraire l'ID du lien darkibox
            let idMatch = lienObj.lien.match(/(?:\/d\/|\/)([a-z0-9]{12,})/i);
            let darkiboxId = idMatch ? idMatch[1] : null;
            let m3u8Url = null;
            let embedUrl = null;
            if (darkiboxId) {
              embedUrl = `https://darkibox.com/embed-${darkiboxId}.html`;
              m3u8Url = await extractM3u8Url(embedUrl);
            }
            // Find the original entry for quality/language info
            const meta = darkiboxEntries.find(e => e.id === lienObj.id);
            return m3u8Url ? {
              src: embedUrl, // Toujours l'embed comme src
              m3u8: m3u8Url,
              language: (meta?.langues_compact && meta.langues_compact.length > 0) ? meta.langues_compact.map(l => l.name).join(', ') : undefined,
              quality: meta?.qual?.qual,
              sub: (meta?.subs_compact && meta.subs_compact.length > 0) ? meta.subs_compact.map(s => s.name).join(', ') : undefined,
              provider: 'darkibox'
            } : null;
          }));
          // Only keep valid ones
          const validDarkiboxSources = darkiboxSources.filter(Boolean);
          // Merge with basicSources (but don't duplicate by src)
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
      basicSources.map(async (source) => {
        if (source.m3u8) {
          // If m3u8 already exists, validate it and get quality
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
        basicSources.map(async (source) => {
          if (source.m3u8) {
            // If m3u8 already exists, validate it and get quality
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
    // Déduplication des sources par m3u8 (prioritaire) puis src
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
    // Déduplication supplémentaire sur src (pour éviter les doublons d'URL)
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
    // Retourner les sources dédupliquées et filtrées
    res.status(200).json({ sources: filteredSources });
  } catch (error) {
    console.error(`Erreur Darkino: ${error.response?.status || 'Erreur réseau'}`);
    try {
      const contentType = error.response?.headers?.['content-type'] || '';
      const body = error.response?.data;
      if (body) {
        const isHtml = typeof body === 'string'
          ? body.includes('<html') || contentType.includes('text/html')
          : contentType.includes('text/html');
        const serialized = typeof body === 'string' ? body : JSON.stringify(body);
        const snippet = serialized?.slice(0, 2000);
        if (isHtml) {
          console.error('Page HTML de l\'erreur (extrait):\n', snippet);
        } else {
          console.error('Corps de la réponse d\'erreur (extrait):\n', snippet);
        }
      }
    } catch (logErr) {
      console.error('Impossible d\'afficher le corps de la réponse d\'erreur:', logErr);
    }
    res.status(500).json({ error: 'Erreur lors de la récupération des liens de téléchargement' });
  }
});

// Function to search for a TV series on TMDB and find the best match
async function findTvSeriesOnTMDB(title, releaseYear, overview) {
  try {
    // Variables pour stocker les informations de saison spéciales
    let seasonOffset = 0;
    let isSeasonPart = false;
    let originalTitle = title;

    // Remove "- Saison X" from the title
    let cleanTitle = title.replace(/\s*-\s*Saison\s+\d+$/i, '');

    // Handle special case for series like "Les Simpson Part 2 (Saison 1 - 29) - Saison 8"
    const partMatch = cleanTitle.match(/Part\s+(\d+)\s*\(Saison\s+(\d+)\s*-\s*(\d+)\)/i);
    if (partMatch) {
      isSeasonPart = true;
      const partNumber = parseInt(partMatch[1]);
      const startSeason = parseInt(partMatch[2]);
      const endSeason = parseInt(partMatch[3]);

      // console.log(`Série en parties détectée: Part ${partNumber}, Saisons ${startSeason}-${endSeason}`);

      // Si c'est la partie 2+, on doit calculer le numéro de saison réel
      if (partNumber > 1) {
        // Chercher la saison mentionnée dans le titre
        const seasonMatch = title.match(/Saison\s+(\d+)$/i);
        if (seasonMatch) {
          const seasonInTitle = parseInt(seasonMatch[1]);

          // On calcule le décalage à partir des informations de saison
          seasonOffset = endSeason - startSeason + 1; // Nombre total de saisons dans la partie 1

          // console.log(`Saison dans le titre: ${seasonInTitle}, Offset calculé: ${seasonOffset}`);
          // console.log(`La vraie saison devrait être: ${seasonOffset + seasonInTitle - 1}`);
        }
      }

      // Remove the part and season range info
      cleanTitle = cleanTitle.replace(/\s*Part\s+\d+\s*\(Saison\s+\d+\s*-\s*\d+\)/i, '');
    }

    // Clean up any remaining parentheses
    cleanTitle = cleanTitle.replace(/\([^)]*\)/g, '').trim();

    // console.log(`Searching TMDB for TV series: "${cleanTitle}" (Original: "${title}")`);

    // Construct the API URL for logging
    const tmdbSearchUrl = `${TMDB_API_URL}/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}&language=fr-FR${releaseYear ? '&first_air_date_year=' + releaseYear : ''}`;
    // console.log(`TMDB API Call URL: ${tmdbSearchUrl}`);

    // Search for the TV series on TMDB
    const searchResponse = await axios.get(`${TMDB_API_URL}/search/tv`, {
      params: {
        api_key: TMDB_API_KEY,
        query: cleanTitle,
        language: 'fr-FR', // Search in French
        first_air_date_year: releaseYear // Filter by year if available
      }
    });

    if (!searchResponse.data.results || searchResponse.data.results.length === 0) {
      // console.log(`No results found on TMDB for "${cleanTitle}"`);
      return null;
    }

    // Log the raw TMDB search results for debugging
    // console.log(`TMDB Search Results for "${cleanTitle}":`, JSON.stringify(searchResponse.data.results.map(r => ({ id: r.id, name: r.name, first_air_date: r.first_air_date })), null, 2));

    // Get the first few results
    const potentialMatches = searchResponse.data.results.slice(0, 5);

    // Function to calculate similarity between two strings
    const calculateSimilarity = (str1, str2) => {
      if (!str1 || !str2) return 0;

      const s1 = str1.toLowerCase();
      const s2 = str2.toLowerCase();

      // Calculate percentage match
      let matches = 0;
      const words1 = s1.split(/\s+/);
      const words2 = s2.split(/\s+/);

      words1.forEach(word => {
        if (words2.some(w => w.includes(word) || word.includes(w))) {
          matches++;
        }
      });

      return matches / Math.max(words1.length, 1);
    };

    // Find the best match by comparing title, release year, and overview
    let bestMatch = null;
    let highestScore = 0;

    for (const series of potentialMatches) {
      // Calculate match score based on title similarity
      const titleSimilarity = calculateSimilarity(cleanTitle, series.name);

      // Get detailed info for the series to compare overviews
      const detailsResponse = await axios.get(`${TMDB_API_URL}/tv/${series.id}`, {
        params: {
          api_key: TMDB_API_KEY
        }
      });

      const overviewSimilarity = overview && detailsResponse.data.overview
        ? calculateSimilarity(overview, detailsResponse.data.overview)
        : 0;

      // Year match (exact match gives bonus)
      const yearMatch = releaseYear && series.first_air_date ?
        (parseInt(series.first_air_date.split('-')[0]) === parseInt(releaseYear) ? 1 : 0) : 0;

      // Calculate total score (weighted)
      // Reduce overview weight, increase title weight
      const totalScore = (titleSimilarity * 0.7) + (overviewSimilarity * 0.2) + (yearMatch * 0.1);

      // console.log(`TMDB Match: "${series.name}", Score: ${totalScore.toFixed(2)} (Title: ${titleSimilarity.toFixed(2)}, Overview: ${overviewSimilarity.toFixed(2)}, Year: ${yearMatch})`);

      if (totalScore > highestScore) {
        highestScore = totalScore;
        bestMatch = {
          ...detailsResponse.data,
          match_score: totalScore
        };
      }
    }

    // Si on a trouvé une correspondance et qu'il s'agit d'une saison spéciale
    if (bestMatch && isSeasonPart) {
      // Ajouter les informations relatives à la saison dans les données TMDB
      bestMatch.is_season_part = true;
      bestMatch.season_offset = seasonOffset;
      bestMatch.original_title = originalTitle;

      // Si nous avons une saison spécifique dans le titre
      const seasonMatch = title.match(/Saison\s+(\d+)$/i);
      if (seasonMatch) {
        const titleSeason = parseInt(seasonMatch[1]);
        bestMatch.title_season = titleSeason;
        bestMatch.actual_season = seasonOffset + titleSeason - 1;
        console.log(`Série en parties: La saison ${titleSeason} dans le titre correspond à la saison ${bestMatch.actual_season} de la série`);
      }
    }

    // Consider it a match if score is above threshold
    return highestScore >= 0.3 ? bestMatch : null;
  } catch (error) {
    console.error('Error finding TV series on TMDB:', error);
    return null;
  }
}
// Middleware commun de logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // Skip logging for POST /api/sync and GET /api/guest/uuid
    if ((req.method === 'POST') || (req.method === 'GET')) {
      return;
    }
    console.log(`${req.method} ${req.path} - ${res.statusCode} - ${Date.now() - start}ms`);
  });
  next();
});

// Gestion des erreurs unifiée
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

// Fonction utilitaire pour formater les erreurs Coflix de manière propre
function formatCoflixError(error, context = '') {
  if (error && error.isAxiosError) {
    const url = error.config && error.config.url ? error.config.url : '';
    const statusCode = error.response ? error.response.status : '';
    const statusText = error.response ? error.response.statusText : '';

    // Ne pas logger les erreurs 400
    if (statusCode === 400) {
      return '';
    }

    return `[AxiosError] ${error.code || ''} ${error.message} ${statusCode ? `(${statusCode} ${statusText})` : ''} ${url}`;
  } else {
    const msg = error && error.message
      ? error.message
      : (typeof error === 'string' ? error : JSON.stringify(error));
    return msg;
  }
}
// Gestion améliorée de l'arrêt
let isShuttingDown = false;



// Le système de graceful shutdown est maintenant géré plus bas dans le fichier
// Function to start the server with retry logic
const startServer = async (retries = 3) => {
  // Create HTTP server with Express
  const server = http.createServer(app);

  // Configure Keep-Alive settings
  server.keepAliveTimeout = 65000; // 65 secondes
  server.headersTimeout = 66000;   // 66 secondes

  // Configure additional keep-alive settings
  // Configure additional keep-alive settings
  server.maxRequestsPerSocket = 0; // Illimité
  server.requestTimeout = 300000; // 5 minutes timeout to prevent hung sockets

  // Start the server
  // Backlog increased to 4096 to handle burst connections
  server.listen(PORT, '0.0.0.0', 4096, () => {
    console.log('Connecté à la base de données MySQL');

    // Init Wrapped Routes
    wrappedRoutes.initWrappedRoutes(pool, redis);
    wrappedRoutes.initTables(); // Create tables if not exist

    // Init Top 10 Routes
    const top10RoutesModule = require('./top10Routes');
    top10RoutesModule.initTop10Routes(pool, redis);

    // Mount Wrapped Routes if not already mounted (to avoid duplicates on retry)
    // Checking if route is already in the stack
    const isWrappedMounted = app._router && app._router.stack && app._router.stack.some(layer =>
      layer.regexp && layer.regexp.toString().includes('wrapped')
    );

    if (!isWrappedMounted) {
      app.use('/api/wrapped', wrappedRoutes.router);
      console.log('[Wrapped] Routes mounted /api/wrapped');
    }

    // Mount Top 10 Routes if not already mounted
    const isTop10Mounted = app._router && app._router.stack && app._router.stack.some(layer =>
      layer.regexp && layer.regexp.toString().includes('top10')
    );

    if (!isTop10Mounted) {
      app.use('/api/top10', top10RoutesModule.router);
      console.log('[Top10] Routes mounted /api/top10');
    }

    // Start server
    console.log(`Serveur démarré sur le port ${PORT} - Process ${process.pid}`);
    console.log(`Proxy service available at http://localhost:${PORT}/proxy/`);
    console.log(`Keep-Alive configuré: timeout=${server.keepAliveTimeout}ms, max=1000`);
    console.log(`Performance tuning: UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE}, RequestTimeout=${server.requestTimeout}ms`);
  });

  server.on('error', (err) => {
    console.error('Erreur de démarrage:', err);
    if (retries > 0) {
      console.log(`Redémarrage... (${retries} restantes)`);
      setTimeout(() => startServer(retries - 1), 5000);
    } else {
      console.error('Échec du démarrage après plusieurs tentatives');
      process.exit(1);
    }
  });

  return server;
};

// === DÉMARRAGE DU WORKER ===
startServer().then(() => {
  console.log(`✅ Worker ${process.pid} - Serveur démarré sur le port ${PORT}`);
}).catch((error) => {
  console.error(`❌ Worker ${process.pid} - Échec du démarrage:`, error);
  process.exit(1);
});

// Graceful shutdown worker
const shutdownWorker = async () => {
  console.log(`\n🛑 Worker ${process.pid} - Signal de fermeture reçu...`);
  try { await redis.quit(); } catch { /* ignore */ }
  process.exit(0);
};

process.on('SIGTERM', shutdownWorker);
process.on('SIGINT', shutdownWorker);
process.on('message', (msg) => {
  if (msg === 'shutdown') shutdownWorker();
});


// Utility functions for zipVarlen and splitAndStrip
const zipVarlen = (...arrays) => {
  const maxLength = Math.max(...arrays.map(arr => arr.length));
  const result = [];

  for (let i = 0; i < maxLength; i++) {
    result.push(arrays.map(arr => i < arr.length ? arr[i] : []));
  }

  return result;
};

const splitAndStrip = (str, delimiter) => {
  return str.split(delimiter).map(item => item.trim()).filter(item => item);
};

const removeQuotes = (str) => {
  if (typeof str !== 'string') return str;
  return str.replace(/^["'](.*)["']$/, '$1');
};

const safeFilename = (str) => {
  return str.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
};

// Language constants for Anime Sama
const LANG = {
  VOSTFR: 'VOSTFR',
  VF: 'VF',
  VOST_ENG: 'VOSTEng',
  VOST_SPA: 'VOSTSpa',
  VJ: 'VJ' // Ajout VJ
};

const LANG_ID = {
  VOSTFR: 'vostfr',
  VF: 'vf',
  VOST_ENG: 'vosteng',
  VOST_SPA: 'vostspa',
  VJ: 'vj' // Ajout VJ
};

const flags = {
  'VOSTFR': '🇯🇵',
  'VF': '🇫🇷',
  'VOSTEng': '🇬🇧',
  'VOSTSpa': '🇪🇸',
  'VJ': '🇯🇵' // Ajout VJ (drapeau japonais par défaut)
};

const id2lang = {
  'vostfr': LANG.VOSTFR,
  'vf': LANG.VF,
  'vosteng': LANG.VOST_ENG,
  'vostspa': LANG.VOST_SPA,
  'vj': LANG.VJ // Ajout VJ
};

const lang2ids = {
  [LANG.VOSTFR]: [LANG_ID.VOSTFR],
  [LANG.VF]: [LANG_ID.VF],
  [LANG.VOST_ENG]: [LANG_ID.VOST_ENG],
  [LANG.VOST_SPA]: [LANG_ID.VOST_SPA],
  [LANG.VJ]: [LANG_ID.VJ] // Ajout VJ
};

const langIds = ['vostfr', 'vf', 'vosteng', 'vostspa', 'vj', 'va', 'vf1', 'vf2', 'vkr']; // Ajout 'vj'

// Helper function to validate player URLs - filters out garbage data like _self, containerSamedi, random text
const isValidPlayerUrl = (url) => {
  if (typeof url !== 'string' || url.length === 0) return false;
  // Must start with http:// or https://
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
  // Must contain a dot (domain)
  if (!url.includes('.')) return false;
  // Filter out known garbage patterns
  const invalidPatterns = ['_self', 'containerSamedi', 'élite', 'Sectes', 'prouesses', 'discord.gg'];
  if (invalidPatterns.some(pattern => url.includes(pattern))) return false;
  return true;
};

// Players class for Anime Sama
class Players {
  constructor(availables = []) {
    this.availables = availables;
    this._best = null;
    this.index = 1;
  }

  get best() {
    if (!this._best) {
      this.setBest();
    }
    return this._best;
  }

  setBest(prefers = [], bans = []) {
    if (!this.availables.length) {
      return;
    }

    // Try preferred players first
    for (const prefer of prefers) {
      for (const player of this.availables) {
        if (player.includes(prefer)) {
          this._best = player;
          return;
        }
      }
    }

    // Try to find a player that isn't banned
    for (let i = this.index; i < this.availables.length + this.index; i++) {
      const candidate = this.availables[i % this.availables.length];
      if (bans.every(ban => !candidate.includes(ban))) {
        this._best = candidate;
        return;
      }
    }

    // Default to first player if none match criteria
    if (!this._best) {
      console.warn(`WARNING: No suitable player found. Defaulting to ${this.availables[0]}`);
      this._best = this.availables[0];
    }
  }
}

class Languages {
  constructor(players, preferLanguages = []) {
    this.players = players;
    this.preferLanguages = preferLanguages;

    // Remove empty players
    Object.keys(this.players).forEach(langId => {
      if (!this.players[langId].availables.length) {
        delete this.players[langId];
      }
    });

    if (Object.keys(this.players).length === 0) {
      console.warn('WARNING: No player available');
    }

    // Group players by language
    this.availables = {};
    for (const langId in this.players) {
      const lang = id2lang[langId];
      if (!this.availables[lang]) {
        this.availables[lang] = [];
      }
      this.availables[lang].push(this.players[langId]);
    }
  }

  get best() {
    // Try preferred languages first
    for (const preferLanguage of this.preferLanguages) {
      if (this.availables[preferLanguage]) {
        for (const player of this.availables[preferLanguage]) {
          if (player.availables.length) {
            return player.best;
          }
        }
      }
    }

    // Try any available language
    for (const language in this.availables) {
      for (const player of this.availables[language]) {
        if (player.availables.length) {
          console.warn(`WARNING: Language preference not respected. Defaulting to ${language}`);
          return player.best;
        }
      }
    }

    return null;
  }

  setBest(...args) {
    for (const langId in this.players) {
      this.players[langId].setBest(...args);
    }
  }
}

class Episode {
  constructor(languages, serieName = "", seasonName = "", episodeName = "", index = 1) {
    this.languages = languages;
    this.serieName = serieName;
    this.seasonName = seasonName;
    this.episodeName = episodeName;
    this._index = index;

    this.name = this.episodeName;
    this.fancyName = this.name;

    // Add language flags to the name
    for (const lang in this.languages.availables) {
      this.fancyName += ` ${flags[lang]}`;
    }

    this.index = this._index;

    // Extract season number
    const seasonNumberMatch = seasonName.match(/\d+/);
    this.seasonNumber = seasonNumberMatch ? parseInt(seasonNumberMatch[0]) : 0;

    this.longName = `${this.seasonName} - ${this.episodeName}`;
    this.shortName = `${this.serieName} S${this.seasonNumber.toString().padStart(2, '0')}E${this.index.toString().padStart(2, '0')}`;
  }

  get index() {
    return this._index;
  }

  set index(value) {
    this._index = value;
    for (const langId in this.languages.players) {
      this.languages.players[langId].index = this._index;
    }
  }

  toString() {
    return this.fancyName;
  }
}
// Season class for Anime Sama
class Season {
  constructor(url, name = "", serieName = "", client = null) {
    // S'assurer que l'URL se termine par / pour éviter les problèmes de concaténation
    const normalizedUrl = url.endsWith('/') ? url : url + '/';
    this.pages = langIds.map(lang => normalizedUrl + lang + "/");
    this.siteUrl = url.split('/').slice(0, 3).join('/') + '/';

    this.name = name || url.split('/').slice(-2)[0];
    this.serieName = serieName || url.split('/').slice(-3)[0];

    this.client = client || axiosAnimeSama;
  }

  async _getPlayersLinksFrom(page) {
    try {
      // Aller directement vers episodes.js sans proxy (fichier JS sans protection Cloudflare)
      const episodesUrl = page + 'episodes.js';
      const episodesJsResponse = await axiosAnimeSama({
        method: 'get',
        url: episodesUrl,
        timeout: 10000
      });

      if (episodesJsResponse.status !== 200) {
        return [];
      }

      const episodesJs = episodesJsResponse.data;

      // Détecter si la réponse est une page HTML 404 déguisée (status 200 mais contenu HTML)
      if (typeof episodesJs === 'string' && (
        episodesJs.includes('<!doctype html>') ||
        episodesJs.includes('<!DOCTYPE html>') ||
        episodesJs.includes('<html') ||
        episodesJs.includes('Page introuvable') ||
        episodesJs.includes('Accès Introuvable')
      )) {
        return [];
      }

      // Vérifier que le contenu ressemble à du JavaScript valide (doit contenir des tableaux)
      if (typeof episodesJs !== 'string' || !episodesJs.includes('[')) {
        return [];
      }

      // Extract player links from JS
      const playersList = episodesJs.split('[').slice(1);
      const playersListLinks = playersList.map(player => {
        const matches = player.match(/'(.+?)'/g);
        if (!matches) return [];

        const allLinks = matches.map(link => {
          let cleanLink = link.replace(/'/g, '');
          // Remove duplicate proxy prefixes
          const proxyPrefix = 'https://proxy.liyao.space/------';
          if (cleanLink.startsWith(proxyPrefix)) {
            cleanLink = cleanLink.substring(proxyPrefix.length);
          }
          return cleanLink;
        });

        // Filtrer et logger les URLs invalides
        const validLinks = allLinks.filter(isValidPlayerUrl);
        const invalidLinks = allLinks.filter(link => !isValidPlayerUrl(link));
        if (invalidLinks.length > 0) {
        }

        return validLinks;
      });

      const result = zipVarlen(...playersListLinks);
      return result;
    } catch (error) {
      // Ne logger que si ce n'est pas une erreur 404 (langue inexistante)
      if (!error.response || error.response.status !== 404) {
        const episodesUrl = page + 'episodes.js';
      } else {
      }
      return [];
    }
  }

  async episodes(existingEpisodes = null) {
    //console.log(`Getting episode list for ${this.name}`);
    // Get episodes from all language pages
    const episodesPagesPromises = this.pages.map(page => this._getPlayersLinksFrom(page));
    const episodesPages = await Promise.all(episodesPagesPromises);
    const episodesInSeason = Math.max(...episodesPages.map(ep => ep.length));

    // Générer des noms d'épisodes numérotés sans faire de requêtes supplémentaires
    const padding = episodesInSeason.toString().length;
    const episodeNames = Array.from({ length: episodesInSeason }, (_, i) =>
      `Episode ${(i + 1).toString().padStart(padding, '0')}`
    );

    // Create Episode objects with simple numbered names
    const episodeObjs = episodeNames.map((name, index) => {
      // Pour chaque épisode, récupérer les players de chaque langue
      const playersLinks = episodesPages.map(pages => pages[index] || []);

      const languages = new Languages(
        Object.fromEntries(
          langIds.map((langId, i) => [langId, new Players(playersLinks[i])])
        )
      );
      return new Episode(languages, this.serieName, this.name, name, index + 1);
    });

    if (!existingEpisodes) {
      return episodeObjs.map(ep => ({
        name: ep.name,
        serie_name: ep.serieName,
        season_name: ep.seasonName,
        index: ep.index,
        streaming_links: Object.entries(ep.languages.players).map(([langId, players]) => ({
          language: langId,
          players: (Array.isArray(players.availables) ? players.availables : []).filter(isValidPlayerUrl)
        })).filter(link => link.players.length > 0)
      }));
    }
    // Sinon, fusionne avec les épisodes existants (par index)
    return episodeObjs.map((ep, idx) => {
      const oldEp = existingEpisodes[idx];
      if (!oldEp) {
        return {
          name: ep.name,
          serie_name: ep.serieName,
          season_name: ep.seasonName,
          index: ep.index,
          streaming_links: Object.entries(ep.languages.players).map(([langId, players]) => ({
            language: langId,
            players: (Array.isArray(players.availables) ? players.availables : []).filter(isValidPlayerUrl)
          })).filter(link => link.players.length > 0)
        };
      }
      // Fusionne les streaming_links par langue
      const oldLinks = oldEp.streaming_links || [];
      // On reconstitue les nouveaux liens à partir de ep.languages.players
      const newLinks = Object.entries(ep.languages.players).map(([langId, players]) => ({
        language: langId,
        players: (Array.isArray(players.availables) ? players.availables : []).filter(isValidPlayerUrl)
      }));
      const mergedLinks = mergeStreamingLinks(oldLinks, newLinks);
      // On retourne un objet Episode-like avec les infos fusionnées
      return {
        name: ep.name,
        serie_name: ep.serieName,
        season_name: ep.seasonName,
        index: ep.index,
        streaming_links: mergedLinks.filter(link => link.players && link.players.length > 0)
      };
    });
  }
}

// Catalogue class for Anime Sama
class Catalogue {
  constructor(url, name = "", client = null, additionalData = null) {
    // Convert URLs to always use the current ANIME_SAMA_URL
    if (url.startsWith('/')) {
      // Relative URL
      this.url = ANIME_SAMA_URL + url.substring(1);
    } else if (url.startsWith('http')) {
      // Absolute URL - replace domain with current ANIME_SAMA_URL
      try {
        const urlObj = new URL(url);
        // Take pathname and search query 
        let path = urlObj.pathname;
        if (path.startsWith('/')) path = path.substring(1);
        this.url = ANIME_SAMA_URL + path + urlObj.search;
      } catch (e) {
        console.error("Error parsing URL in Catalogue constructor:", url);
        this.url = url;
      }
    } else {
      // Other URLs
      this.url = url.endsWith('/') ? url : url + '/';
    }
    this.name = name || url.split('/').slice(-2)[0];
    this.siteUrl = url.split('/').slice(0, 3).join('/') + '/';
    this.client = client || axiosAnimeSama;

    // Add additional data if provided
    if (additionalData) {
      this.image = additionalData.image || '';
      this.alternative_names = additionalData.alternative_names || [];
      this.alternative_names_string = additionalData.alternative_names_string || '';
    } else {
      this.image = '';
      this.alternative_names = [];
      this.alternative_names_string = '';
    }
  }

  async seasons() {

    try {
      const response = await axiosAnimeSamaRequest({
        method: 'get',
        url: this.url
      });
      const responseData = response.data;

      // Extract seasons using regex - preserve original HTML order
      // The order of panneauAnime() calls in the HTML determines the display order
      const seasonsMatches = responseData.match(/panneauAnime\("(.+?)", *"(.+?)(?:vostfr|vf)"\);/g) || [];

      const seasons = [];
      for (const match of seasonsMatches) {
        const [_, name, link] = match.match(/panneauAnime\("(.+?)", *"(.+?)(?:vostfr|vf)"\);/) || [];

        if (name && link) {
          // Extraire le nom de l'anime depuis this.url (ex: gachiakuta depuis /catalogue/gachiakuta/)
          const urlParts = this.url.split('/');
          const animeNameFromUrl = urlParts[urlParts.length - 2] || urlParts[urlParts.length - 1]; // Prendre le dernier segment avant le /

          // Si le link contient le nom de l'anime au début, l'enlever
          let normalizedLink = link;
          if (animeNameFromUrl && normalizedLink.startsWith(animeNameFromUrl)) {
            // Enlever le nom de l'anime du début du link
            normalizedLink = normalizedLink.substring(animeNameFromUrl.length);
          }

          // S'assurer que le link commence par /
          if (!normalizedLink.startsWith('/')) {
            normalizedLink = '/' + normalizedLink;
          }

          // Construire l'URL complète : baseUrl + / + nom_anime + normalizedLink
          const baseUrl = this.url.endsWith('/') ? this.url.slice(0, -1) : this.url;
          const seasonUrl = baseUrl + normalizedLink;

          seasons.push(
            new Season(
              seasonUrl,
              name,
              this.name,
              this.client
            )
          );
        }
      }

      // Return seasons in their original HTML order (no sorting)
      return seasons;
    } catch (error) {
      console.error(`Error getting seasons for ${this.name}:`, error.message);
      return [];
    }
  }
}
// Anime Sama class
class AnimeSama {
  constructor(siteUrl) {
    this.siteUrl = siteUrl;
    this.client = axiosAnimeSama;
  }

  async search(query, forceNoCache = false) {

    try {
      // Check cache first, unless forceNoCache is true
      const cacheKey = generateCacheKey(query);
      if (!forceNoCache) {
        const cachedResults = await getFromCacheNoExpiration(ANIME_SAMA_CACHE_DIR, cacheKey);
        if (cachedResults) {
          return cachedResults.map(result =>
            new Catalogue(result.url, result.name, this.client, result)
          );
        }
      }

      const requestUrl = `${this.siteUrl}template-php/defaut/fetch.php`;
      const requestData = `query=${encodeURIComponent(query)}`;
      console.log(`\n[AnimeSama Search] DEBUG INFO:`);
      console.log(`[AnimeSama Search] Query: ${query}`);
      console.log(`[AnimeSama Search] URL: ${requestUrl}`);
      console.log(`[AnimeSama Search] Payload: ${requestData}`);

      const response = await axiosAnimeSamaRequest({
        method: 'post',
        url: requestUrl,
        data: requestData,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      if (response.status !== 200) {
        return [];
      }

      const responseData = response.data;

      // Parse the HTML response to extract detailed information
      const results = this.parseSearchResults(responseData);

      // Save to cache
      await saveToCache(ANIME_SAMA_CACHE_DIR, cacheKey, results);

      return results.map(result =>
        new Catalogue(result.url, result.name, this.client, result)
      );
    } catch (error) {
      console.error(`\n[AnimeSama Search] ERROR FAIL:`);
      console.error(`[AnimeSama Search] Query: ${query}`);
      console.error(`[AnimeSama Search] Error Message: ${error.message}`);
      if (error.response) {
        console.error(`[AnimeSama Search] Status Code: ${error.response.status}`);
        console.error(`[AnimeSama Search] Response Data:`, JSON.stringify(error.response.data, null, 2));
      }
      if (error.config) {
         console.error(`[AnimeSama Search] Request Config URL:`, error.config.url);
      }
      return [];
    }
  }

  parseSearchResults(htmlData) {
    const results = [];

    try {
      // Use cheerio to parse HTML more reliably
      const $ = cheerio.load(htmlData);

      // Find all anime result links
      $('a').each((_, element) => {
        const $link = $(element);
        const href = $link.attr('href');

        // Skip if no href or not an anime catalogue link
        if (!href || !href.includes('/catalogue/')) {
          return;
        }

        // Extract image information
        const $img = $link.find('img');
        const imageUrl = $img.attr('src') || '';

        // Extract title from h3
        const $title = $link.find('h3');
        const mainTitle = $title.text().trim();

        // Extract alternative names from p tag
        const $altNames = $link.find('p');
        const alternativeNames = $altNames.text().trim();

        // Split alternative names by comma and clean them
        const altNamesArray = alternativeNames
          ? alternativeNames.split(',').map(name => name.trim()).filter(name => name.length > 0)
          : [];

        if (mainTitle && href) {
          results.push({
            url: href,
            name: mainTitle,
            image: imageUrl,
            alternative_names: altNamesArray,
            alternative_names_string: alternativeNames
          });
        }
      });

      // Fallback to regex parsing if cheerio parsing fails or returns no results
      if (results.length === 0) {
        console.log('Cheerio parsing returned no results, falling back to regex parsing');
        return this.parseSearchResultsRegex(htmlData);
      }

      console.log(`Parsed ${results.length} anime results with enhanced data`);
      return results;

    } catch (error) {
      console.error('Error parsing search results with cheerio:', error.message);
      // Fallback to regex parsing
      return this.parseSearchResultsRegex(htmlData);
    }
  }

  parseSearchResultsRegex(htmlData) {
    try {
      // Extract links and names using regex (fallback method)
      const links = (htmlData.match(/href="(.+?)"/g) || []).map(link =>
        link.replace(/href="|"/g, '')
      );

      const names = (htmlData.match(/>(.+?)<\/h3>/g) || []).map(name =>
        name.replace(/>(.*?)<\/h3>/g, '$1')
      );

      return links.map((link, index) => ({
        url: link,
        name: names[index] || '',
        image: '',
        alternative_names: [],
        alternative_names_string: ''
      }));
    } catch (error) {
      console.error('Error in regex parsing fallback:', error.message);
      return [];
    }
  }
}
// Episode cache for Anime Sama - Unified cache per anime
class EpisodeCache {
  constructor(cacheDir = ANIME_SAMA_CACHE_DIR, ttl = 3600) {
    this.cacheDir = cacheDir;
    this.ttl = ttl * 1000; // Convert to milliseconds
  }

  _getCachePath(serieName) {
    // Clean names to avoid issues with special characters
    const safeSerie = safeFilename(serieName);
    return path.join(this.cacheDir, `${safeSerie}.json`);
  }

  async getAnimeData(serieName) {
    const cachePath = this._getCachePath(serieName);

    try {
      const fileContent = await fsp.readFile(cachePath, 'utf-8');
      const data = normalizeAnimeSamaUrls(JSON.parse(fileContent));

      // Check if cache is expired
      if (Date.now() - data.timestamp > this.ttl) {
        return null;
      }

      return data.seasons || {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Error reading cache:', error);
      }
      return null;
    }
  }

  async getEpisodes(serieName, seasonName) {
    const animeData = await this.getAnimeData(serieName);
    if (!animeData) return null;

    const seasonData = animeData[seasonName];
    return seasonData ? seasonData.episodes : null;
  }

  async saveAnimeData(serieName, seasonsData) {
    const cachePath = this._getCachePath(serieName);

    const data = {
      timestamp: Date.now(),
      seasons: seasonsData
    };

    try {
      // Utiliser l'écriture atomique pour les fichiers de cache
      await writeFileAtomic(cachePath, JSON.stringify(data), 'utf-8');
      await memoryCache.set(`anime:${serieName}`, data);
    } catch (error) {
      console.error('Error saving cache:', error);
    }
  }

  async saveEpisodes(serieName, seasonName, episodesData) {
    // Get existing anime data or create new
    let animeData = await this.getAnimeData(serieName) || {};

    // Update the specific season
    animeData[seasonName] = {
      timestamp: Date.now(),
      episodes: episodesData
    };

    // Save the updated anime data
    await this.saveAnimeData(serieName, animeData);
  }
}

// Configure Anime Sama axios client
const axiosAnimeSama = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  },

  decompress: true
});
// Configure episode cache
const episodeCache = new EpisodeCache(ANIME_SAMA_CACHE_DIR, 3600);
// Add Anime Sama API routes
app.get('/anime/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const cacheKey = generateCacheKey(query);
    const animeCacheDir = ANIME_SAMA_CACHE_DIR;
    let cachedResults = await getFromCacheNoExpiration(animeCacheDir, cacheKey);
    let dataReturned = false;

    // Si pas de cache, faire la recherche Anime Sama, mettre en cache, retourner le résultat
    if (!cachedResults || !Array.isArray(cachedResults) || cachedResults.length === 0) {
      try {
        const client = new AnimeSama(ANIME_SAMA_URL);
        const searchResults = await client.search(query, false);
        // search() retourne des Catalogue, on les serialize pour le cache
        const serializedResults = searchResults.map(cat => ({
          url: cat.url,
          name: cat.name,
          image: cat.image,
          alternative_names: cat.alternative_names,
          alternative_names_string: cat.alternative_names_string
        }));
        await saveToCache(animeCacheDir, cacheKey, serializedResults);
        cachedResults = serializedResults;
        // On continue pour retourner la structure complète (avec saisons/épisodes)
      } catch (err) {
        console.error('Erreur scraping Anime Sama:', err);
        return res.status(500).json({ error: 'Erreur lors de la recherche Anime Sama' });
      }
    }

    // Lister tous les fichiers de cache d'anime
    const allCacheFiles = await fsp.readdir(animeCacheDir).catch(() => []);

    // Pour chaque anime du cache principal (avec limitation de concurrence)
    const animesWithSeasons = await Promise.all(cachedResults.map(anime => limitConcurrency10(async () => {
      // On cherche le fichier de cache unifié pour cet anime
      const safeAnimeName = anime.name.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
      const animeFile = `${safeAnimeName}.json`;

      let saisons = [];

      // Vérifier si le fichier de cache unifié existe
      if (allCacheFiles.includes(animeFile)) {
        try {
          const animeContent = await fsp.readFile(path.join(animeCacheDir, animeFile), 'utf-8');
          const animeCache = normalizeAnimeSamaUrls(JSON.parse(animeContent));

          // Convertir les saisons du cache unifié en format attendu
          if (animeCache.seasons) {
            saisons = Object.entries(animeCache.seasons).map(([seasonName, seasonData]) => ({
              name: seasonName,
              episodes: seasonData.episodes || [],
              episodeCount: (seasonData.episodes || []).length,
              cacheFile: animeFile,
              timestamp: seasonData.timestamp || animeCache.timestamp || null
            }));
          }
        } catch (e) {
          console.error(`Error reading unified cache for ${anime.name}:`, e.message);
        }
      } else {
        // Fallback: chercher les anciens fichiers de cache séparés pour migration
        const seasonFiles = allCacheFiles.filter(f => f.startsWith(safeAnimeName + '_') && f !== cacheKey + '.json');

        saisons = (await Promise.all(seasonFiles.map(async seasonFile => {
          try {
            const seasonContent = await fsp.readFile(path.join(animeCacheDir, seasonFile), 'utf-8');
            const seasonCache = normalizeAnimeSamaUrls(JSON.parse(seasonContent));
            return {
              name: seasonFile.replace(safeAnimeName + '_', '').replace('.json', ''),
              episodes: seasonCache.episodes || [],
              episodeCount: (seasonCache.episodes || []).length,
              cacheFile: seasonFile,
              timestamp: seasonCache.timestamp || null
            };
          } catch (e) {
            return null;
          }
        }))).filter(Boolean);
      }

      // Fonction pour préserver l'ordre d'origine des saisons depuis la page HTML
      // L'ordre d'affichage sur la page anime-sama reflète l'ordre voulu par le site
      const sortSeasons = (seasons) => {
        // Ne pas trier - préserver l'ordre d'origine de la page HTML
        // L'ordre des appels panneauAnime() dans le HTML détermine l'ordre d'affichage
        return seasons;
      };

      return {
        ...anime,
        seasons: sortSeasons(saisons)
      };
    })));

    // Réponse immédiate avec tout le cache
    // --- FILTRAGE FINAL DES LECTEURS INDÉSIRABLES AVANT RÉPONSE ---
    const unwantedUrls = [
      'https://video.sibnet.ru/shell.php?videoid=',
      'https://vidmoly.to/embed-.html',
      'https://sendvid.com/embed/',
      'https://vk.com/video_ext.php?oid=&hd=3'
    ];
    animesWithSeasons.forEach(anime => {
      if (anime.seasons && Array.isArray(anime.seasons)) {
        anime.seasons.forEach(season => {
          if (season.episodes && Array.isArray(season.episodes)) {
            // Filtrage des URLs indésirables dans les players
            season.episodes.forEach(ep => {
              if (ep.streaming_links && Array.isArray(ep.streaming_links)) {
                ep.streaming_links.forEach(linkObj => {
                  if (linkObj.players && Array.isArray(linkObj.players)) {
                    linkObj.players = linkObj.players.filter(url => !unwantedUrls.includes(url));
                  }
                });
              }
            });
            // Retirer les épisodes qui n'ont aucun lecteur
            season.episodes = season.episodes.filter(ep =>
              Array.isArray(ep.streaming_links) &&
              ep.streaming_links.some(linkObj => Array.isArray(linkObj.players) && linkObj.players.length > 0)
            );
            // Mettre à jour le episodeCount après filtrage
            season.episodeCount = season.episodes.length;
          }
        });

        // Retirer les saisons qui n'ont aucun épisode
        anime.seasons = anime.seasons.filter(season =>
          Array.isArray(season.episodes) && season.episodes.length > 0
        );
      }
    });
    // --- FIN FILTRAGE FINAL ---
    res.json(animesWithSeasons);
    dataReturned = true;

    // --- Mise à jour en arrière-plan ---
    (async () => {
      const client = new AnimeSama(ANIME_SAMA_URL);

      for (const anime of animesWithSeasons) {
        let catalogueObj = null;
        try {
          catalogueObj = new Catalogue(anime.url, anime.name, client.client, anime);
        } catch (e) {
          continue;
        }
        if (!catalogueObj) continue;

        let seasonsList = [];
        try {
          seasonsList = await catalogueObj.seasons();
        } catch (e) {
          continue;
        }


        // Utiliser le cache unifié pour cet anime
        const safeAnimeName = anime.name.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
        const animeCacheFile = `${safeAnimeName}.json`;
        const animeCachePath = path.join(animeCacheDir, animeCacheFile);

        // Charger le cache unifié existant
        let existingAnimeCache = {};
        try {
          const animeContent = await fsp.readFile(animeCachePath, 'utf-8');
          const animeData = JSON.parse(animeContent);
          existingAnimeCache = animeData.seasons || {};
        } catch (e) {
          // Pas de cache existant, continuer avec un objet vide
        }

        // Vérifier si le cache a été mis à jour récemment (moins de 1 heure)
        const RECENT_UPDATE_THRESHOLD = 1 * 60 * 60 * 1000; // 1 heure en millisecondes
        let shouldSkipAnime = false;
        try {
          const stats = await fsp.stat(animeCachePath);
          const timeSinceLastUpdate = Date.now() - stats.mtime.getTime();
          if (timeSinceLastUpdate < RECENT_UPDATE_THRESHOLD) {
            shouldSkipAnime = true;
          }
        } catch (e) {
          // Fichier n'existe pas, continuer normalement
        }

        if (shouldSkipAnime) continue;

        let animeDataUpdated = false;
        const updatedAnimeCache = { ...existingAnimeCache };

        for (const seasonObj of seasonsList) {
          const safeSeasonName = seasonObj.name.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
          let cachedEpisodes = null;
          let shouldUpdate = false;

          try {
            // Récupérer les épisodes en cache pour cette saison
            const seasonCache = existingAnimeCache[seasonObj.name];
            if (seasonCache && seasonCache.episodes) {
              cachedEpisodes = seasonCache.episodes;

              // Vérifier d'abord s'il y a potentiellement de nouveaux contenus avant de scraper
              // Scrape uniquement les langues manquantes !
              const scrapedEpisodes = await seasonObj.episodes(cachedEpisodes);

              // Vérifier s'il y a vraiment des changements significatifs
              const hasNewEpisodes = scrapedEpisodes.length > cachedEpisodes.length;
              const hasNewLang = scrapedEpisodes.some((ep, idx) => {
                const oldEp = cachedEpisodes[idx];
                if (!oldEp) return true; // Nouvel épisode
                const oldLangs = (oldEp.streaming_links || []).map(l => l.language);
                const newLangs = (ep.streaming_links || []).map(l => l.language);
                return newLangs.some(l => !oldLangs.includes(l)); // Nouvelle langue
              });

              // Vérifier s'il y a de nouveaux lecteurs pour les langues existantes
              const hasNewPlayers = scrapedEpisodes.some((ep, idx) => {
                const oldEp = cachedEpisodes[idx];
                if (!oldEp) return false; // Déjà couvert par hasNewEpisodes

                return (ep.streaming_links || []).some(newLink => {
                  const oldLink = (oldEp.streaming_links || []).find(ol => ol.language === newLink.language);
                  if (!oldLink) return false; // Déjà couvert par hasNewLang

                  const oldPlayers = Array.isArray(oldLink.players) ? oldLink.players : [];
                  const newPlayers = Array.isArray(newLink.players) ? newLink.players : [];
                  return newPlayers.length > oldPlayers.length ||
                    newPlayers.some(player => !oldPlayers.includes(player));
                });
              });

              // Ne mettre à jour que s'il y a vraiment du nouveau contenu
              if (hasNewEpisodes || hasNewLang || hasNewPlayers) {
                shouldUpdate = true;
                cachedEpisodes = scrapedEpisodes;
              } else {
              }
            } else {
              // Pas de cache pour cette saison, on scrape tout
              shouldUpdate = true;
              cachedEpisodes = await seasonObj.episodes();
            }
          } catch (e) {
            // Erreur lors du scraping, on scrape tout
            shouldUpdate = true;
            cachedEpisodes = await seasonObj.episodes();
          }

          if (shouldUpdate) {
            try {
              // --- FILTRAGE DES LECTEURS INDÉSIRABLES (pour la mise à jour du cache) ---
              const unwantedUrls = [
                'https://video.sibnet.ru/shell.php?videoid=',
                'https://vidmoly.to/embed-.html',
                'https://sendvid.com/embed/',
                'https://vk.com/video_ext.php?oid=&hd=3'
              ];
              const episodesData = cachedEpisodes.map(episode => ({
                name: episode.name,
                serie_name: episode.serie_name || episode.serieName,
                season_name: episode.season_name || episode.seasonName,
                index: episode.index,
                streaming_links: (episode.streaming_links || []).map(linkObj => ({
                  language: linkObj.language,
                  players: Array.isArray(linkObj.players)
                    ? linkObj.players.filter(url => !unwantedUrls.includes(url))
                    : linkObj.players
                }))
              }));
              // --- FIN FILTRAGE ---

              // Mettre à jour le cache unifié pour cette saison
              updatedAnimeCache[seasonObj.name] = {
                timestamp: Date.now(),
                episodes: episodesData
              };
              animeDataUpdated = true;

            } catch (e) {
              console.error(`Erreur lors du scraping de la saison ${seasonObj.name} (${anime.name}):`, e.message);
            }
          }
        }

        // Sauvegarder le cache unifié si des mises à jour ont été effectuées
        if (animeDataUpdated) {
          try {
            const unifiedCacheData = {
              timestamp: Date.now(),
              seasons: updatedAnimeCache
            };
            await writeFileAtomic(animeCachePath, JSON.stringify(unifiedCacheData), 'utf-8');

            // Nettoyer les anciens fichiers de cache séparés après migration réussie
            await cleanupOldCacheFiles(safeAnimeName, animeCacheDir);
          } catch (e) {
          }
        } else if (Object.keys(existingAnimeCache).length === 0) {
          // Si pas de cache unifié existant, migrer les anciens fichiers séparés
          await migrateOldCacheFiles(safeAnimeName, animeCacheDir);
        }
      }
    })();

  } catch (error) {
    console.error('Erreur /anime/search/:query:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Supprime le cache d'un anime (recherche + cache unifié)
app.delete('/anime/search/:query/cache', async (req, res) => {
  try {
    const { query } = req.params;
    const cacheKey = generateCacheKey(query);
    const animeCacheDir = ANIME_SAMA_CACHE_DIR;

    let deletedFiles = [];
    let errors = [];

    // 1. Supprimer le fichier de cache de recherche
    try {
      const searchCacheFile = path.join(animeCacheDir, `${cacheKey}.json`);
      await fsp.unlink(searchCacheFile);
      deletedFiles.push(`search cache: ${cacheKey}.json`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        errors.push(`Erreur suppression cache de recherche: ${err.message}`);
      }
    }

    // 2. Supprimer le cache unifié de l'anime (basé sur le nom)
    try {
      // Lire le cache de recherche pour obtenir le nom exact de l'anime
      // Sinon, on utilise directement la query décodée
      const decodedQuery = decodeURIComponent(query);
      const safeAnimeName = decodedQuery.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
      const animeFile = path.join(animeCacheDir, `${safeAnimeName}.json`);

      try {
        await fsp.unlink(animeFile);
        deletedFiles.push(`unified cache: ${safeAnimeName}.json`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          errors.push(`Erreur suppression cache unifié: ${err.message}`);
        }
      }

      // 3. Supprimer également les anciens fichiers de cache séparés (si existants)
      const allCacheFiles = await fsp.readdir(animeCacheDir).catch(() => []);
      const oldSeasonFiles = allCacheFiles.filter(f =>
        f.startsWith(safeAnimeName + '_') && f.endsWith('.json')
      );

      for (const oldFile of oldSeasonFiles) {
        try {
          await fsp.unlink(path.join(animeCacheDir, oldFile));
          deletedFiles.push(`old season cache: ${oldFile}`);
        } catch (err) {
          errors.push(`Erreur suppression ancien cache ${oldFile}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`Erreur lors de la recherche des fichiers: ${err.message}`);
    }

    // Réponse
    if (deletedFiles.length > 0) {
      return res.status(200).json({
        success: true,
        message: `Cache anime "${decodeURIComponent(query)}" supprimé.`,
        deletedFiles,
        errors: errors.length > 0 ? errors : undefined
      });
    } else {
      return res.status(404).json({
        success: false,
        error: 'Aucun cache trouvé pour cet anime.',
        errors: errors.length > 0 ? errors : undefined
      });
    }
  } catch (err) {
    console.error('Erreur suppression cache anime:', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// Fonction pour obtenir les détails d'un contenu depuis l'ID TMDB
async function getTMDBDetails(id, type) {
  try {
    // Récupérer d'abord les données sans langue pour avoir le titre international
    let response = await axios.get(`${TMDB_API_URL}/${type}/${id}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR'
      }
    });

    if (!response.data) {
      return null;
    }

    // Essayer ensuite de récupérer les données en français pour l'overview
    let frenchResponse = null;
    try {
      frenchResponse = await axios.get(`${TMDB_API_URL}/${type}/${id}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: 'fr-FR'
        }
      });
    } catch (error) {
      // Si la requête française échoue, on continue avec les données internationales
      console.log(`Impossible de récupérer les données françaises pour ${id}, utilisation des données internationales`);
    }

    // Formater les données selon le type
    let details = {
      id: response.data.id,
      title: type === 'movie' ? response.data.title : response.data.name, // Titre international
      original_title: type === 'movie' ? response.data.original_title : response.data.original_name,
      release_date: type === 'movie' ? response.data.release_date : response.data.first_air_date,
      poster_path: response.data.poster_path,
      backdrop_path: response.data.backdrop_path,
      overview: frenchResponse?.data?.overview || response.data.overview, // Overview français si disponible, sinon international
      vote_average: response.data.vote_average
    };
    // Ne plus sauvegarder en cache
    // await saveToCache(CACHE_DIR.TMDB, details);
    return details;
  } catch (error) {
    console.error(`Erreur lors de la récupération des détails TMDB pour ${id} (${type}):`, error);
    return null;
  }
}

// Fonction pour normaliser les caractères spéciaux pour les requêtes Coflix
function normalizeCoflixQuery(query) {
  if (!query) return query;

  // Dictionnaire des caractères à remplacer
  const replacements = {
    'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
    'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
    'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
    'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
    'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
    'ý': 'y', 'ÿ': 'y',
    'ñ': 'n',
    'ç': 'c',
    'œ': 'oe', 'æ': 'ae',
    'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A',
    'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E',
    'Ì': 'I', 'Í': 'I', 'Î': 'I', 'Ï': 'I',
    'Ò': 'O', 'Ó': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O',
    'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U',
    'Ý': 'Y', 'Ÿ': 'Y',
    'Ñ': 'N',
    'Ç': 'C',
    'Œ': 'OE', 'Æ': 'AE'
  };

  // Remplacer tous les caractères spéciaux
  let normalized = query;
  for (const [special, normal] of Object.entries(replacements)) {
    normalized = normalized.split(special).join(normal);
  }

  return normalized;
}

// Fonction pour rechercher un contenu sur Coflix par titre
async function searchCoflixByTitle(title, mediaType, releaseYear) {
  try {
    // Normaliser le titre avant de faire la requête pour éviter les erreurs 400
    const normalizedTitle = normalizeCoflixQuery(title);

    const response = await axiosCoflixRequest({ method: 'get', url: `/suggest.php?query=${encodeURIComponent(normalizedTitle)}` });

    // Vérifier que la réponse est un tableau
    if (!Array.isArray(response.data)) {
      console.error(`La réponse de l'API Coflix n'est pas un tableau: ${formatCoflixError(response.data)}`);
      return [];
    }

    // Mapper les résultats et calculer la similarité pour tous les types de média
    const results = response.data.map(item => {
      // Normaliser les titres pour calculer la similarité
      const similarity = calculateTitleSimilarity(title, item.title);

      // Debug logging pour Alice
      if (title.toLowerCase().includes('alice') || item.title.toLowerCase().includes('alice')) {
      }

      // Extraire l'année de sortie
      const resultYear = item.year ? parseInt(item.year) : null;

      return {
        title: item.title,
        url: item.url,
        similarity: similarity,
        year: resultYear,
        id: item.ID,
        excerpt: item.excerpt,
        post_type: item.post_type,
        rating: item.rating
      };
    });

    // Faire correspondre le type de média demandé avec les types de Coflix
    let coflixTypes = [];

    if (mediaType === 'movie') {
      coflixTypes = ['movies'];
    } else if (mediaType === 'tv') {
      // Pour la TV, on accepte séries et animes
      coflixTypes = ['series', 'animes', 'doramas'];
    } else if (mediaType === 'anime') {
      coflixTypes = ['animes'];
    } else {
      // Si aucun type spécifié, accepter tous les types
      coflixTypes = ['movies', 'series', 'animes', 'doramas'];
    }

    // Filtrer d'abord par type de média
    let filteredResults = mediaType
      ? results.filter(item => coflixTypes.includes(item.post_type))
      : results;

    // filteredResults.map(r => `${r.title} (${r.post_type}) [${r.similarity}]`); // Original logging line

    // Sort filteredResults by similarity to easily pick the best one later.
    filteredResults.sort((a, b) => b.similarity - a.similarity);

    if (releaseYear) {
      const yearMatchedResults = filteredResults.filter(r => r.year === releaseYear);

      if (mediaType === 'movie') {
        // For movies, strict year match. If yearMatchedResults is empty, filteredResults becomes empty.
        // If not empty, take the best one (already sorted) if its similarity is good.
        if (yearMatchedResults.length > 0 && yearMatchedResults[0].similarity >= 0.80) {
          filteredResults = [yearMatchedResults[0]];
        } else {
          filteredResults = [];
        }
      } else if (mediaType === 'tv') { // Covers 'series', 'animes', 'doramas' via coflixTypes
        // For TV series, be strict about year matching to avoid wrong versions
        if (yearMatchedResults.length > 0 && yearMatchedResults[0].similarity >= 0.70) {
          // Use the best year match if similarity is decent
          filteredResults = [yearMatchedResults[0]];
        } else {
          // For TV series, do NOT use fallback to avoid wrong versions (like Shameless US 2011 instead of UK 2004)
          filteredResults = []; // No fallback for TV series
        }
      } else { // For any other specific types (e.g. 'anime' if not covered by 'tv' explicitly above for some reason)
        if (yearMatchedResults.length > 0 && yearMatchedResults[0].similarity >= 0.80) {
          filteredResults = [yearMatchedResults[0]];
        } else {
          filteredResults = [];
        }
      }
    } else { // No releaseYear specified
      // Use the best item from the type-filtered list if similarity is good.
      if (filteredResults.length > 0 && filteredResults[0].similarity > 0.80) {
        filteredResults = [filteredResults[0]];
      } else {
        // If no release year, and best type-match is not good enough, or list is empty
        filteredResults = [];
      }
    }

    // Return the filtered results
    return filteredResults;

  } catch (error) {
    // Affichage propre de l'erreur Coflix
    console.error(`Erreur lors de la recherche sur Coflix pour ${title}: ${formatCoflixError(error)}`);
    throw error;
  }
}
// Fonction utilitaire pour calculer la similarité entre deux titres
function calculateTitleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;

  const t1 = title1.toLowerCase();
  const t2 = title2.toLowerCase();

  // Normaliser les titres (enlever les accents, etc.)
  const normalize = (str) => str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/[®™©]/g, "") // remove trademark-like symbols
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // replace other punctuation with space
    .replace(/\s+/g, " ")
    .trim();
  const norm1 = normalize(t1);
  const norm2 = normalize(t2);

  // Exact match priorité absolue - Vérification stricte d'égalité
  if (norm1 === norm2) {
    return 1.0;
  }

  // Vérification stricte pour les numéros de suite et sous-titres
  // Extraire les numéros de suite (ex: "3", "2", etc.)
  const extractNumbers = (str) => {
    const numbers = str.match(/\b\d+\b/g);
    return numbers ? numbers.map(n => parseInt(n)) : [];
  };

  const numbers1 = extractNumbers(norm1);
  const numbers2 = extractNumbers(norm2);

  // Si un titre a un numéro et l'autre non, ou si les numéros sont différents, pénaliser fortement
  if (numbers1.length > 0 || numbers2.length > 0) {
    const hasCommonNumbers = numbers1.length > 0 && numbers2.length > 0 &&
      numbers1.some(n1 => numbers2.some(n2 => n1 === n2));

    // Si un titre a un numéro et l'autre non, ou si les numéros sont différents
    if (!hasCommonNumbers) {
      return 0.2; // Forte pénalité pour numéros différents ou manquants
    }
  }

  // Vérifier les sous-titres (après ":" ou " - ")
  const extractSubtitles = (str) => {
    const parts = str.split(/[:|]/);
    return parts.length > 1 ? parts[1].trim() : "";
  };

  const subtitle1 = extractSubtitles(norm1);
  const subtitle2 = extractSubtitles(norm2);

  // Si les titres ont des sous-titres différents, pénaliser
  if (subtitle1 && subtitle2 && subtitle1 !== subtitle2) {
    // Vérifier si les sous-titres sont similaires (même ville, même concept)
    const subtitleWords1 = subtitle1.split(/\s+/).filter(w => w.length > 2);
    const subtitleWords2 = subtitle2.split(/\s+/).filter(w => w.length > 2);
    const commonSubtitleWords = subtitleWords1.filter(w1 =>
      subtitleWords2.some(w2 => w1.includes(w2) || w2.includes(w1))
    );

    if (commonSubtitleWords.length === 0) {
      return 0.3; // Pénalité pour sous-titres complètement différents
    }
  }

  // Vérification spéciale pour les titres avec des mots-clés de différenciation
  // Si un titre contient des mots comme "londres", "paris", "new york" et l'autre non
  const locationKeywords = ['londres', 'paris', 'new york', 'tokyo', 'berlin', 'rome', 'madrid', 'barcelone'];
  const hasLocation1 = locationKeywords.some(keyword => norm1.includes(keyword));
  const hasLocation2 = locationKeywords.some(keyword => norm2.includes(keyword));

  if (hasLocation1 !== hasLocation2) {
    return 0.25; // Pénalité si un titre a une localisation et l'autre non
  }

  // Gestion spéciale pour les titres courts (≤ 10 caractères) - À FAIRE EN PREMIER
  if (norm1.length <= 10 || norm2.length <= 10) {
    // Pour les titres courts, être plus strict avec l'inclusion pour éviter les faux positifs
    if (norm2.includes(norm1) || norm1.includes(norm2)) {
      const shorter = norm1.length <= norm2.length ? norm1 : norm2;
      const longer = norm1.length <= norm2.length ? norm2 : norm1;
      const lengthRatio = shorter.length / longer.length;

      // Être beaucoup plus strict pour éviter les correspondances comme "Alice" vs "Alice in Borderland"
      if (lengthRatio >= 0.8) {
        return 0.85;
      } else if (lengthRatio >= 0.6) {
        return 0.7;
      } else if (lengthRatio >= 0.4) {
        return 0.5;
      }
      // Pour les ratios très faibles (< 0.4), pénaliser fortement
      return 0.2;
    }
  }

  // Boost si le titre recherché est un token de tête du résultat (ex: "f1" vs "f1 le film")
  if (norm2.startsWith(norm1 + " ") || norm1.startsWith(norm2 + " ")) {
    return 0.9;
  }

  // Si les titres ne sont pas exactement identiques, on utilise une similarité inférieure à 1.0
  if (norm2.includes(norm1) || norm1.includes(norm2)) {
    if (norm1.length < norm2.length && norm2.includes(norm1)) {
      const lengthRatio = norm1.length / norm2.length;
      // Être plus strict avec les correspondances partielles
      if (lengthRatio >= 0.6) {
        return 0.8 * lengthRatio;
      } else if (lengthRatio >= 0.4) {
        return 0.6 * lengthRatio;
      }
      return 0.3; // Pénalité forte pour les correspondances très partielles
    }
    // Si le titre trouvé est plus court et inclus dans la recherche
    else if (norm2.length < norm1.length && norm1.includes(norm2)) {
      const lengthRatio = norm2.length / norm1.length;
      if (lengthRatio >= 0.6) {
        return 0.75 * lengthRatio;
      } else if (lengthRatio >= 0.4) {
        return 0.55 * lengthRatio;
      }
      return 0.3; // Pénalité forte pour les correspondances très partielles
    }
    return 0.6; // Score réduit pour inclusion partielle générale
  }

  // Diviser en mots et filtrer les mots courts (articles, etc.)
  const filterShortWords = words => words.filter(w => w.length > 3);
  const words1 = filterShortWords(norm1.split(/\s+/));
  const words2 = filterShortWords(norm2.split(/\s+/));

  // Si pas de mots significatifs, utiliser les mots originaux
  const finalWords1 = words1.length ? words1 : norm1.split(/\s+/);
  const finalWords2 = words2.length ? words2 : norm2.split(/\s+/);

  // Calculer le pourcentage de mots correspondants avec un poids plus élevé pour l'ordre
  let matches = 0;
  let orderBonus = 0;

  finalWords1.forEach((word, index) => {
    const matchIndex = finalWords2.findIndex(w => w.includes(word) || word.includes(w));
    if (matchIndex !== -1) {
      matches++;
      // Bonus si les mots sont dans un ordre similaire
      if (Math.abs(index - matchIndex) < 2) {
        orderBonus += 0.1;
      }
    }
  });

  const baseScore = matches / Math.max(finalWords1.length, finalWords2.length, 1);
  return Math.min(baseScore + orderBonus, 0.95); // Maximum 0.95 pour les correspondances non exactes
}

// Fonction pour filtrer les lecteurs emmmmbed.com et lecteur6.com des données
function filterEmmmmbedReaders(data) {
  if (!data) return data;

  // Fonction récursive pour parcourir l'objet
  function filterObject(obj) {
    if (Array.isArray(obj)) {
      return obj.map(item => filterObject(item));
    } else if (obj && typeof obj === 'object') {
      const filtered = {};
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'player_links' && Array.isArray(value)) {
          // Filtrer les lecteurs lecteur1.xtremestream.xyz
          filtered[key] = value.filter(link =>
            !link.decoded_url ||
            !link.decoded_url.includes('lecteur1.xtremestream.xyz')
          );
        } else {
          filtered[key] = filterObject(value);
        }
      }
      return filtered;
    }
    return obj;
  }

  return filterObject(data);
}

// Fonction pour extraire les données des films depuis Coflix
async function getMovieDataFromCoflix(url) {
  let cachedData = null;
  let hadCache = false;
  try {
    // Générer une clé de cache basée sur l'URL
    const cacheKey = generateCacheKey({ url: url, type: 'movie' });

    // Vérifier le cache sans expiration (stale-while-revalidate)
    cachedData = await getFromCacheNoExpiration(CACHE_DIR.COFLIX, cacheKey);
    hadCache = !!cachedData; // Mémoriser si on avait un cache
    if (cachedData) {
      // Ne pas utiliser le cache si player_links est vide — re-fetcher pour tenter d'obtenir les liens
      if (!cachedData.player_links || cachedData.player_links.length === 0) {
        console.log(`[COFLIX MOVIE] Cache ignoré (player_links vide) pour ${url} — re-fetch en cours`);
      } else {
        return cachedData;
      }
    }

    // Convertir l'URL complète en chemin relatif pour axiosCoflix
    const relativePath = url.replace(/^https:\/\/coflix\.mov/, '');
    const proxiedUrl = `${url}`;
    //console.log(`Récupération des données du film depuis ${proxiedUrl}`);
    const response = await axiosCoflixRequest({ method: 'get', url: relativePath });
    const $ = cheerio.load(response.data);

    // Récupérer l'iframe
    let iframe = $('main div div div article div:nth-child(2) div:nth-child(1) aside div div iframe');
    if (!iframe.length) {
      iframe = $('article iframe');
    }
    if (!iframe.length) {
      iframe = $('iframe');
    }

    let iframeSrc = null;
    let playerLinks = [];

    if (iframe.length > 0) {
      iframeSrc = iframe.attr('src');

      // Accéder à la page de l'iframe pour récupérer les liens des lecteurs
      if (iframeSrc) {
        try {
          const iframePageResponse = await axiosLecteurVideoRequest({ method: 'get', url: iframeSrc });
          const iframePage$ = cheerio.load(iframePageResponse.data);

          // Extraire les liens des lecteurs
          let playerItems = iframePage$('li[onclick*="showVideo"]');
          if (!playerItems.length) {
            playerItems = iframePage$('div li[onclick]');
          }

          if (playerItems.length === 0) {
            const bodyHtml = iframePage$('body').html() || '';
            console.warn(`[COFLIX MOVIE] ⚠️ Aucun playerItem — iframe: ${iframeSrc}, status: ${iframePageResponse.status}, taille: ${(iframePageResponse.data || '').length} chars, aperçu HTML: ${bodyHtml.substring(0, 500)}`);
          }

          playerItems.each((i, element) => {
            try {
              const $element = iframePage$(element);
              const onClickAttr = $element.attr('onclick') || '';

              const base64Match = onClickAttr.match(/showVideo\(['"]([^'\"]+)['"]/);

              if (base64Match && base64Match[1]) {
                const base64Url = base64Match[1];

                let decodedUrl;
                try {
                  decodedUrl = Buffer.from(base64Url, 'base64').toString('utf-8');
                } catch (decodeError) {
                  decodedUrl = null;
                }

                const quality = $element.find('span').text().trim();

                let language = 'Unknown';
                const info = $element.find('p').text().trim();
                if (info.toLowerCase().includes('french')) {
                  language = 'French';
                } else if (info.toLowerCase().includes('english')) {
                  language = 'English';
                } else if (info.toLowerCase().includes('vostfr')) {
                  language = 'VOSTFR';
                }

                playerLinks.push({
                  // Supprimer le lien encodé en base64
                  // base64_url: base64Url,
                  decoded_url: decodedUrl, // Garder le lien décodé
                  quality: quality,
                  language: language
                });
              }
            } catch (playerError) {
              const errorCode = playerError.response?.status || playerError.code || 'unknown';
              console.error(`erreur: ${errorCode}`);
            }
          });
        } catch (iframePageError) {
          const errorCode = iframePageError.response?.status || iframePageError.code || 'unknown';
          console.error(`[COFLIX MOVIE] ❌ Erreur requête iframe ${iframeSrc} — code: ${errorCode}, message: ${iframePageError.message}`);
        }
      }
    } else {
      console.log(`Aucun iframe trouvé pour l'URL ${url}`);
    }

    const result = {
      // Ne pas exposer l'URL de l'iframe si elle contient coflix
      iframe_src: iframeSrc && !iframeSrc.includes('coflix') ? iframeSrc : null,
      player_links: playerLinks
    };

    // Sauvegarder dans le cache
    await saveToCache(CACHE_DIR.COFLIX, cacheKey, result);

    return result;
  } catch (error) {
    // En cas d'erreur HTTP/Axios (ex: 403), vérifier si on avait un cache
    if (error && (error.isAxiosError || (error.response && error.response.status))) {
      console.error(`Erreur lors de la récupération des données du film Coflix: ${formatCoflixError(error)}`);
      // Si on avait un cache, retourner le cache au lieu de propager l'erreur
      if (hadCache) {
        console.log(`[COFLIX] Cache préservé malgré l'erreur pour ${url}`);
        return cachedData;
      }
      throw error;
    }
    console.error(`Erreur lors de la récupération des données du film Coflix: ${formatCoflixError(error)}`);
    // Pour les autres erreurs non HTTP, vérifier si on avait un cache
    if (hadCache) {
      console.log(`[COFLIX] Cache préservé malgré l'erreur pour ${url}`);
      return cachedData;
    }
    // Si pas de cache, retourner une structure vide sans bloquer
    return { iframe_src: null, player_links: [] };
  }
}
// Nouvelle fonction pour récupérer les épisodes via l'API Coflix
async function fetchCoflixSeriesEpisodes(postId, seasonNumber) {
  try {
    const apiUrl = `https://coflix.observer/wp-json/apiflix/v1/series/${postId}/${seasonNumber}`;

    const response = await axiosCoflixRequest({ method: 'get', url: `/wp-json/apiflix/v1/series/${postId}/${seasonNumber}` });
    if (response.data && Array.isArray(response.data.episodes)) {
      return response.data;
    }
    return null;
  } catch (error) {
    // Affichage propre de l'erreur Coflix
    console.error(`Erreur lors de la récupération des épisodes Coflix: ${formatCoflixError(error)}`);
    return null;
  }
}
// Fonction pour extraire les données des séries depuis Coflix
async function getTvDataFromCoflix(url, seasonNumber, episodeNumber) {
  let cachedData = null;
  let hadCache = false;
  try {
    // Générer une clé de cache basée sur l'URL, saison et épisode
    const cacheKey = generateCacheKey({ url: url, season: seasonNumber, episode: episodeNumber, type: 'tv' });

    // Vérifier le cache sans expiration (stale-while-revalidate)
    cachedData = await getFromCacheNoExpiration(CACHE_DIR.COFLIX, cacheKey);
    hadCache = !!cachedData; // Mémoriser si on avait un cache
    if (cachedData) {
      //console.log(`Données de la série Coflix récupérées depuis le cache pour ${url}`);
      return cachedData;
    }

    // Convertir l'URL complète en chemin relatif pour axiosCoflix
    const relativePath = url.replace(/^https:\/\/coflix\.mov/, '');
    const proxiedUrl = `${url}`;
    const response = await axiosCoflixRequest({ method: 'get', url: relativePath });
    const $ = cheerio.load(response.data);

    // Récupérer les saisons
    const seasonItems = $('article section div aside div ul li');

    if (!seasonItems.length) {
      console.log(`[ERROR] Aucune saison trouvée pour ${url}`);

      // Essayer d'autres sélecteurs possibles pour diagnostiquer
      const altSelectors = [
        'ul li',
        '.seasons li',
        '.season-list li',
        '[data-season]',
        'input[data-season]'
      ];

      for (const selector of altSelectors) {
        const altItems = $(selector);
        if (altItems.length > 0) {
        }
      }

      // Afficher un échantillon du HTML pour diagnostic
      const bodyContent = $('body').html();
      if (bodyContent) {
        const truncatedContent = bodyContent.substring(0, 500);
      }

      return {
        seasons: [],
        current_episode: null
      };
    }

    // Extraire les saisons
    const seasons = [];
    let targetSeason = null;
    let postId = null;

    for (let i = 0; i < seasonItems.length; i++) {
      const $seasonElement = $(seasonItems[i]);
      const $label = $seasonElement.find('label');
      const $input = $label.find('input');

      const sNumber = $input.attr('data-season');
      const seriesId = $input.attr('data-id');
      const currentPostId = $input.attr('post-id');
      const seasonName = $label.find('span').text().trim();

      const season = {
        season_number: parseInt(sNumber),
        name: seasonName,
        data_id: seriesId,
        post_id: currentPostId,
        episodes: []
      };

      seasons.push(season);

      // Si c'est la saison recherchée, la marquer
      if (parseInt(sNumber) === seasonNumber) {
        targetSeason = season;
        postId = currentPostId;
      }
    }

    // Extraire le slug de la série pour construire les URLs des épisodes
    const slugMatch = url.match(/\/serie\/([^/]+)/);
    const animeMatch = url.match(/\/animes\/([^/]+)/);
    const seriesSlug = slugMatch ? slugMatch[1] : (animeMatch ? animeMatch[1] : '');

    // Si une saison et un épisode spécifiques sont demandés
    if (targetSeason && episodeNumber) {
      // Tenter de récupérer les épisodes via l'API si on a un post_id
      let episodeApiData = null;
      let episodeUrl = null;

      if (postId) {
        const apiData = await fetchCoflixSeriesEpisodes(postId, seasonNumber);
        if (apiData && apiData.episodes) {
          // Chercher l'épisode spécifique dans les données de l'API
          const episode = apiData.episodes.find(ep => parseInt(ep.number) === parseInt(episodeNumber));
          if (episode && episode.links) {
            // Convertir l'URL pour utiliser le proxy si c'est une URL coflix.observer
            episodeUrl = episode.links.startsWith('https://coflix.observer')
              ? `${episode.links}`
              : episode.links;
            // console.log(`URL d'épisode trouvée via l'API: ${episodeUrl}`);
          }
        }
      }

      // Si l'URL n'a pas été trouvée via l'API, utiliser la méthode classique
      if (!episodeUrl) {
        // Pour tous les types de contenu (séries et animes), utiliser le format NxN
        episodeUrl = `https://coflix.observer/episode/${seriesSlug}-${seasonNumber}x${episodeNumber}/`;
        // console.log(`URL d'épisode construite manuellement: ${episodeUrl}`);
      }

      try {
        // console.log(`Récupération des données de l'épisode depuis ${episodeUrl}`);
        // Utiliser directement makeCoflixRequest pour toutes les URLs
        const episodePageResponse = await makeCoflixRequest(episodeUrl, { headers: coflixHeaders, timeout: 15000 });
        const episodePage$ = cheerio.load(episodePageResponse.data);

        // Extraire le titre de l'épisode
        const episodeTitle = episodePage$('article header h1').text().trim();
        const episodePlayerLinks = [];

        // Trouver l'iframe dans la page de l'épisode
        let episodeIframe = episodePage$('main div div div article div iframe');
        if (!episodeIframe.length) {
          episodeIframe = episodePage$('article iframe');
        }
        if (!episodeIframe.length) {
          episodeIframe = episodePage$('iframe');
        }

        let episodeIframeSrc = null;

        if (episodeIframe.length > 0) {
          episodeIframeSrc = episodeIframe.attr('src');
          // console.log(`Iframe trouvé pour l'épisode: ${episodeIframeSrc}`);

          // Accéder à la page de l'iframe pour l'épisode
          if (episodeIframeSrc) {
            try {
              const iframePageResponse = await axiosLecteurVideoRequest({ method: 'get', url: episodeIframeSrc });
              const iframePage$ = cheerio.load(iframePageResponse.data);

              // Extraire les liens des lecteurs depuis la page de l'iframe
              let playerItems = iframePage$('li[onclick*="showVideo"]');
              if (!playerItems.length) {
                playerItems = iframePage$('div li[onclick]');
              }

              playerItems.each((i, element) => {
                try {
                  const $element = iframePage$(element);
                  const onClickAttr = $element.attr('onclick') || '';

                  const base64Match = onClickAttr.match(/showVideo\(['"]([^'\"]+)['"]/);

                  if (base64Match && base64Match[1]) {
                    const base64Url = base64Match[1];

                    let decodedUrl;
                    try {
                      decodedUrl = Buffer.from(base64Url, 'base64').toString('utf-8');
                    } catch (decodeError) {
                      decodedUrl = null;
                    }

                    const quality = $element.find('span').text().trim();

                    let language = 'Unknown';
                    const info = $element.find('p').text().trim();
                    if (info.toLowerCase().includes('french')) {
                      language = 'French';
                    } else if (info.toLowerCase().includes('english')) {
                      language = 'English';
                    } else if (info.toLowerCase().includes('vostfr')) {
                      language = 'VOSTFR';
                    }

                    episodePlayerLinks.push({
                      // Supprimer le lien encodé en base64
                      // base64_url: base64Url,
                      decoded_url: decodedUrl, // Garder le lien décodé
                      quality: quality,
                      language: language
                    });
                  }
                } catch (playerError) {
                  const errorCode = playerError.response?.status || playerError.code || 'unknown';
                  console.error(`erreur: ${errorCode}`);
                }
              });
            } catch (iframePageError) {
              const errorCode = iframePageError.response?.status || iframePageError.code || 'unknown';
              console.error(`erreur: ${errorCode}`);
            }
          }
        }

        return {
          seasons: seasons,
          current_episode: {
            season_number: seasonNumber,
            episode_number: episodeNumber,
            title: episodeTitle,
            // Ne pas inclure l'URL de l'épisode
            // url: episodeUrl,
            // Ne pas exposer l'URL de l'iframe si elle contient coflix
            iframe_src: episodeIframeSrc && !episodeIframeSrc.includes('coflix') ? episodeIframeSrc : null,
            player_links: episodePlayerLinks
          }
        };
      } catch (episodeError) {
        console.error(`Erreur lors de la récupération des données de l'épisode: ${formatCoflixError(episodeError)}`);
        return {
          seasons: seasons,
          current_episode: null
        };
      }
    }

    const result = {
      seasons: seasons,
      current_episode: null
    };

    // Sauvegarder dans le cache
    await saveToCache(CACHE_DIR.COFLIX, cacheKey, result);

    return result;
  } catch (error) {
    // En cas d'erreur HTTP/Axios (ex: 403), vérifier si on avait un cache
    if (error && (error.isAxiosError || (error.response && error.response.status))) {
      console.error(`Erreur lors de la récupération des données de la série Coflix: ${formatCoflixError(error)}`);
      // Si on avait un cache, retourner le cache au lieu de propager l'erreur
      if (hadCache) {
        console.log(`[COFLIX] Cache préservé malgré l'erreur pour ${url}`);
        return cachedData;
      }
      throw error;
    }
    console.error(`Erreur lors de la récupération des données de la série Coflix: ${formatCoflixError(error)}`);
    // Pour les autres erreurs non HTTP, vérifier si on avait un cache
    if (hadCache) {
      console.log(`[COFLIX] Cache préservé malgré l'erreur pour ${url}`);
      return cachedData;
    }
    // Si pas de cache, retourner une structure vide sans bloquer
    return { seasons: [], current_episode: null };
  }
}

// Route pour récupérer les liens à partir d'un ID TMDB
app.get('/api/tmdb/:type/:id', async (req, res) => {
  const { id, type } = req.params;

  // Bloquer certains IDs TMDB spécifiques (comme demandé pour le movie 771)
  if (type === 'movie' && id === '771') {
    return res.status(404).json({ error: 'Not found' });
  }
  const { season, episode } = req.query;
  const cacheKey = generateCacheKey(`tmdb_links_${type}_${id}_${season || ''}_${episode || ''}`);

  try {
    // 1. Vérifier le cache sans expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(CACHE_DIR.COFLIX, cacheKey);
    const hadCache = !!cachedData; // Mémoriser si on avait un cache
    let dataReturned = false;
    if (cachedData) {
      res.json(filterEmmmmbedReaders(cachedData)); // 2. Retourner les données en cache immédiatement (filtrées)
      dataReturned = true;

      // Lancer la mise à jour en arrière-plan si nécessaire (vérifie 2 heures pour LecteurVideo)
      (async () => {
        try {
          // Vérifier si le cache doit être mis à jour (2 heures pour LecteurVideo)
          const shouldUpdate = await shouldUpdateCacheLecteurVideo(CACHE_DIR.COFLIX, cacheKey);
          if (!shouldUpdate) {
            return; // Ne pas mettre à jour le cache
          }

          // Lancer la mise à jour
          await updateCache();
        } catch (err) {
          console.error("Erreur non gérée dans updateCache (TMDB):", err);
        }
      })();
    }

    // 3. Fonction pour récupérer les données fraîches et mettre à jour le cache
    const updateCache = async () => {
      try {
        // Vérifier que le type est valide
        if (type !== 'movie' && type !== 'tv') {
          if (!dataReturned) {
            res.status(400).json({ message: 'Type de média non valide' });
          }
          return;
        }

        // Pour les séries, vérifier que la saison et l'épisode sont fournis pour la mise à jour
        if (type === 'tv' && (!season || !episode)) {
          if (!dataReturned) {
            res.status(400).json({ message: 'Paramètres de saison/épisode manquants' });
          }
          return;
        }

        // Récupérer les détails TMDB
        const tmdbDetails = await getTMDBDetails(id, type);
        if (!tmdbDetails) {
          if (!dataReturned) {
            res.status(404).json({ message: 'Contenu non trouvé sur TMDB' });
          }
          return;
        }

        // Extraire l'année de la date de sortie
        const releaseYear = tmdbDetails.release_date ? parseInt(tmdbDetails.release_date.split('-')[0]) : null;

        // Rechercher sur Coflix avec le titre international d'abord
        let coflixResults = await searchCoflixByTitle(tmdbDetails.title, type, releaseYear);
        let bestResults = coflixResults;

        // Si aucun résultat trouvé avec le titre principal, essayer avec le titre original
        if ((!coflixResults || !coflixResults.length || (coflixResults[0] && coflixResults[0].similarity < 0.8)) && tmdbDetails.original_title && tmdbDetails.original_title !== tmdbDetails.title) {
          const originalResults = await searchCoflixByTitle(tmdbDetails.original_title, type, releaseYear);

          // Comparer les résultats et garder les meilleurs
          if (originalResults && originalResults.length > 0) {
            if (!bestResults || !bestResults.length) {
              bestResults = originalResults;
            } else {
              // Garder le résultat avec la meilleure similarité
              const bestSimilarity = Math.max(
                bestResults[0]?.similarity || 0,
                originalResults[0]?.similarity || 0
              );
              if (bestSimilarity === (originalResults[0]?.similarity || 0)) {
                bestResults = originalResults;
              }
            }
          }
        }

        // Si toujours pas de bon résultat, essayer avec le titre français localisé
        if ((!bestResults || !bestResults.length || (bestResults[0] && bestResults[0].similarity < 0.8))) {
          try {
            const frenchResponse = await axios.get(`${TMDB_API_URL}/${type}/${id}`, {
              params: {
                api_key: TMDB_API_KEY,
                language: 'fr-FR'
              }
            });

            if (frenchResponse.data) {
              const frenchTitle = type === 'movie' ? frenchResponse.data.title : frenchResponse.data.name;
              if (frenchTitle && frenchTitle !== tmdbDetails.title && frenchTitle !== tmdbDetails.original_title) {
                const frenchResults = await searchCoflixByTitle(frenchTitle, type, releaseYear);

                // Comparer et garder les meilleurs
                if (frenchResults && frenchResults.length > 0) {
                  if (!bestResults || !bestResults.length) {
                    bestResults = frenchResults;
                  } else {
                    const bestSimilarity = Math.max(
                      bestResults[0]?.similarity || 0,
                      frenchResults[0]?.similarity || 0
                    );
                    if (bestSimilarity === (frenchResults[0]?.similarity || 0)) {
                      bestResults = frenchResults;
                    }
                  }
                }
              }
            }
          } catch (error) {
            console.log(`[TMDB API] ⚠️ Impossible de récupérer le titre français pour ${id}`);
          }
        }

        // Utiliser les meilleurs résultats trouvés
        coflixResults = bestResults;

        // Gérer le cas où aucun résultat n'est trouvé sur Coflix OU si la meilleure correspondance n'est pas assez bonne
        const similarityThreshold = 0.8; // Seuil de similarité minimum requis

        // Debug logging pour Alice
        if (tmdbDetails.title.toLowerCase().includes('alice')) {
          if (coflixResults && coflixResults.length > 0) {
          }
        }

        if (!coflixResults || !coflixResults.length || (coflixResults[0] && coflixResults[0].similarity < similarityThreshold)) {
          if (!coflixResults || !coflixResults.length) {
          } else {
          }

          const unavailableResult = {
            message: 'Contenu non disponible',
            tmdb_id: id,
            tmdb_details: tmdbDetails
          };
          // Sauvegarder le statut "non disponible" dans le cache
          await saveToCache(CACHE_DIR.COFLIX, cacheKey, unavailableResult);
          if (!dataReturned) {
            res.status(200).json(filterEmmmmbedReaders(unavailableResult)); // Retourner 200 OK avec le message (filtré)
          }
          return; // Arrêter le traitement pour cette mise à jour
        }

        // Utiliser le premier résultat trouvé (maintenant garanti d'avoir une similarité suffisante)
        const coflixUrl = coflixResults[0].url;

        let result = {
          tmdb_details: tmdbDetails
        };

        // Récupérer les données spécifiques selon le type
        if (type === 'movie') {
          const movieData = await getMovieDataFromCoflix(coflixUrl);
          result = {
            ...result,
            ...movieData
          };
        } else if (type === 'tv') {
          const seasonNum = parseInt(season);
          const episodeNum = parseInt(episode);
          const tvData = await getTvDataFromCoflix(coflixUrl, seasonNum, episodeNum);
          result = {
            ...result,
            ...tvData
          };
        }

        // 4. Vérifier si les résultats sont valides avant de sauvegarder
        // Ne pas sauvegarder si on a des données vides ET qu'un cache existait déjà
        const isEmptyResult = (type === 'movie' && (!result.player_links || result.player_links.length === 0)) ||
          (type === 'tv' && (!result.seasons || result.seasons.length === 0));

        if (isEmptyResult) {
          console.warn(`[TMDB ${type} ${id}] ⚠️ Aucun lien trouvé (player_links vide) — titre: ${tmdbDetails.title || tmdbDetails.original_title}, coflix URL: ${coflixResults[0]?.url || 'N/A'}`);
        }

        if (!isEmptyResult || !dataReturned) {
          // Sauvegarder en cache seulement si les résultats sont valides OU si aucun cache n'existait
          await saveToCache(CACHE_DIR.COFLIX, cacheKey, result);
          // console.log(`Cache mis à jour pour TMDB ${id} (${type})`);
        } else {
        }

        // Si les données n'avaient pas été retournées initialement (pas de cache), les retourner maintenant
        if (!dataReturned) {
          res.json(filterEmmmmbedReaders(result));
        }

      } catch (updateError) {
        // Log only error message and code to avoid dumping large HTML or sensitive data
        if (updateError && updateError.isAxiosError) {
          // AxiosError: affiche code, message, et url de la requête
          const url = updateError.config && updateError.config.url ? updateError.config.url : '';
          console.error(
            `Erreur lors de la mise à jour du cache TMDB ${id} (${type}): [AxiosError] ${updateError.code || ''} ${updateError.message} ${url}`
          );
        } else {
          // Autre erreur: affiche juste le message ou la string
          const msg = updateError && updateError.message
            ? updateError.message
            : (typeof updateError === 'string'
              ? updateError
              : JSON.stringify(updateError));
          console.error(`Erreur lors de la mise à jour du cache TMDB ${id} (${type}): ${msg}`);
        }
        // Si les données n'avaient pas été retournées et que la mise à jour échoue
        if (!dataReturned) {
          res.status(200).json({
            message: 'Contenu non disponible en raison d\'une erreur',
            tmdb_id: id
          });
        }
      }
    };

    // Si pas de données en cache, faire la requête normale
    if (!dataReturned) {
      // Lancer la mise à jour du cache
      await updateCache();
    }

    // Si les données du cache ont déjà été envoyées, la fonction se termine ici.
    // Sinon, la réponse sera envoyée à la fin de updateCache.

  } catch (error) {
    console.error(`Erreur lors de la récupération des liens TMDB ${id} (${type}):`, error);
    // Ne renvoyer une erreur que si aucune donnée n'a encore été envoyée
    if (!res.headersSent) {
      res.status(200).json({
        message: 'Contenu non disponible en raison d\'une erreur',
        tmdb_id: id
      });
    }
  }
});

// Create a cache directory for FrenchCloud data
const FRENCHCLOUD_CACHE_DIR = path.join(__dirname, 'cache', 'frenchcloud');
(async () => {
  try {
    await fsp.access(FRENCHCLOUD_CACHE_DIR);
  } catch {
    await fsp.mkdir(FRENCHCLOUD_CACHE_DIR, { recursive: true });
  }
})();
// Function to extract movie iframe from FrenchStream
async function getFrenchStreamMovie(imdbId) {
  try {
    const searchUrl = `https://fr.french-stream.sbs/xfsearch/${imdbId}`;
    // console.log(`Searching for movie at ${searchUrl}`);

    const searchResponse = await makeRequestWithCorsFallback(searchUrl, { timeout: 5000, decompress: true });
    const $search = cheerio.load(searchResponse.data);

    // Find the movie link in search results
    let movieLink = null;
    $search('.short').each((index, element) => {
      const $element = $search(element);
      const link = $element.find('.short-poster').attr('href');
      // Assuming the first result is the correct one or add more logic if needed
      if (link && !movieLink) {
        movieLink = link;
      }
    });

    if (!movieLink) {
      return { error: 'Movie not found on FrenchStream' };
    }

    // console.log(`Found movie link: ${movieLink}`);
    const movieResponse = await makeRequestWithCorsFallback(movieLink, { timeout: 5000, decompress: true });
    const $movie = cheerio.load(movieResponse.data);

    // Extract iframe src using the specified XPath logic
    // XPath: /html/body/div[2]/div[1]/div/article/div[1]/div/div/div[1]/div/div/div/iframe
    // Equivalent CSS selector: body > div:nth-child(2) > div:nth-child(1) > div > article > div:nth-child(1) > div > div > div:nth-child(1) > div > div > div > iframe

    // Trying a few selectors to be robust
    let iframeSrc = $movie('body > div:nth-child(2) > div:nth-child(1) > div > article > div:nth-child(1) > div > div > div:nth-child(1) > div > div > div > iframe').attr('src');

    if (!iframeSrc) {
      // Fallback selectors
      iframeSrc = $movie('iframe[src*="frenchcloud.cam"]').attr('src');
    }

    if (!iframeSrc) {
      // Try finding it in the tabs content if the structure is slightly different
      iframeSrc = $movie('.tabs-content iframe').attr('src');
    }

    if (!iframeSrc) {
      return { error: 'Iframe not found on movie page' };
    }

    // Fetch the iframe content (FrenchCloud page)
    const iframeResponse = await axios.get(iframeSrc, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://fr.french-stream.sbs/'
      },
      decompress: true
    });

    const $iframe = cheerio.load(iframeResponse.data);
    const playerLinks = [];

    $iframe('._player-mirrors li').each((index, element) => {
      const $element = $iframe(element);
      const dataLink = $element.attr('data-link');
      const playerName = $element.text().trim();
      const isHD = $element.hasClass('fullhd');

      // Skip links that contain frenchcloud.cam (often the embed itself)
      if (!dataLink || dataLink.includes('frenchcloud.cam')) {
        return;
      }

      // Add protocol to links that start with //
      let formattedLink = dataLink;
      if (dataLink.startsWith('//')) {
        formattedLink = 'https:' + dataLink;
      }

      playerLinks.push({
        player: playerName,
        link: formattedLink,
        is_hd: isHD
      });
    });

    return {
      iframe_src: iframeSrc,
      player_links: playerLinks
    };

  } catch (error) {
    return { error: `Failed to fetch movie data: ${error.message}` };
  }
}

// --- Define the consolidated cache directory ---
const LINK_CACHE_DIR = path.join(__dirname, 'cache', 'links');
(async () => {
  try {
    await fsp.access(LINK_CACHE_DIR);
  } catch {
    await fsp.mkdir(LINK_CACHE_DIR, { recursive: true });
  }
})();
const CACHE_EXPIRATION_6H = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

// Route to get movie/show links using IMDB ID (Movies) or FrenchStream ID (TV)
app.get('/api/imdb/:type/:id', async (req, res) => {
  const { id, type } = req.params;
  // Return 404 for specific blocked IMDB ids
  const blockedImdbIds = new Set([
    'tt7069210',
    'tt0325980',
    'tt0383574',
    'tt0449088',
    'tt1298650',
    'tt1790809',
    'tt0099785'
  ]);
  if (blockedImdbIds.has(id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const cacheKey = type === 'movie' ?
    generateCacheKey(`imdb_movie_${id}`) :
    generateCacheKey(`frenchstream_${id}`); // Use consistent key logic
  const cacheDir = LINK_CACHE_DIR; // Use consolidated cache dir

  try {
    // 1. Check cache without expiration
    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    let dataReturned = false;
    if (cachedData) {
      // console.log(`Links/Data for ${type} ${id} retrieved from cache (stale-while-revalidate)`);
      // Clean cached TV data if needed before returning
      const dataToSend = type === 'tv' ? cleanTvCacheData(cachedData) : cachedData;
      res.json(dataToSend);
      dataReturned = true;
    }

    // 3. Function to fetch fresh data and update cache
    const updateCache = async () => {
      try {
        // console.log(`Mise à jour du cache en arrière-plan pour ${type} ${id}`);

        // Vérifier si le cache doit être mis à jour (pour TV uniquement, avec délai de 20 minutes)
        if (type === 'tv') {
          const shouldUpdate = await shouldUpdateCacheFrenchStream(cacheDir, cacheKey);
          if (!shouldUpdate) {
            // console.log(`Cache French-Stream ${cacheKey} modifié il y a moins de 20 minutes, pas de mise à jour en arrière-plan`);
            return; // Ne pas mettre à jour le cache
          }
        }

        let responseData = {};

        if (type === 'movie') {
          // --- Handle Movies (using FrenchStream scraping) ---
          const movieData = await getFrenchStreamMovie(id);
          if (movieData.error) {
            responseData = { message: 'Contenu non disponible', french_stream_id: id, details: movieData.error };
          } else {
            responseData = {
              ...movieData
            };
          }

        } else if (type === 'tv') {
          // --- Handle TV Series (using FrenchStream ID and FrenchStream logic) ---
          const frenchStreamId = id; // ID is treated as FrenchStream ID for TV type
          const seriesList = await getFrenchStreamSeries(frenchStreamId);

          if (!seriesList || (Array.isArray(seriesList) && seriesList.length === 0)) {
            // Optional: Delete cache entry if source no longer exists?
            // deleteFromCache(cacheDir, cacheKey);
            responseData = { message: 'Contenu non disponible', french_stream_id: frenchStreamId }; // Simpler message instead of error
          } else if (seriesList.error) {
            // Check if it's a 404 error
            if (seriesList.error.includes('404')) {
              responseData = { message: 'Contenu non disponible', french_stream_id: frenchStreamId };
            } else {
              responseData = { error: 'Failed to retrieve series list from FrenchStream', details: seriesList.error, french_stream_id: frenchStreamId };
            }
          } else {
            const MAX_SERIES = 10;
            const seriesToProcess = seriesList.slice(0, MAX_SERIES);

            // Limiter la concurrence à 3 requêtes simultanées pour éviter de surcharger le serveur
            await Promise.all(seriesToProcess.map(series => limitConcurrency3(async () => {
              if (series.link) {
                try {
                  const seriesDetails = await getFrenchStreamSeriesDetails(series.link, series.title);
                  if (!seriesDetails.error) {
                    series.seasons = seriesDetails.seasons;
                    series.release_date = seriesDetails.release_date;
                    series.summary = seriesDetails.summary;
                    series.tmdb_data = seriesDetails.tmdb_data;
                    const { baseName, partNumber } = extractSeriesInfo(series.title);
                    series.baseName = baseName;
                    series.partNumber = partNumber;
                  } else {
                    console.warn(`Could not fetch details for series: ${series.title} (${series.link}), Error: ${seriesDetails.error}`);
                    series.seasons = [];
                  }
                } catch (detailsError) {
                  console.error(`Exception fetching details for ${series.title} (${series.link}):`, detailsError);
                  series.seasons = [];
                }
              } else {
                series.seasons = [];
              }
            })));

            // Group and Merge Series Parts
            const seriesGroups = {};
            seriesToProcess.forEach(series => {
              if (series.baseName) {
                if (!seriesGroups[series.baseName]) {
                  seriesGroups[series.baseName] = [];
                }
                seriesGroups[series.baseName].push(series);
              }
            });

            const mergedSeriesList = [];
            for (const baseName in seriesGroups) {
              const merged = mergeSeriesParts(seriesGroups[baseName]);
              if (merged) {
                mergedSeriesList.push(merged);
              }
            }

            // Clean the merged list for the final result
            const cleanedSeries = cleanTvCacheData({ series: mergedSeriesList }); // Reuse cleaning function

            responseData = {
              type: 'tv',
              series: cleanedSeries.series // Use the cleaned list
            };
          }
        } else {
          console.error(`Type invalide pour la mise à jour du cache: ${type}`);
          return; // Should not happen due to initial check
        }

        // 4. Save to cache (only if no error occurred during fetch)
        if (!responseData.error) {
          await saveToCache(cacheDir, cacheKey, responseData);
          // console.log(`Cache mis à jour pour ${type} ${id}`);
        } else {
        }

        // If data was not returned initially, return it now
        if (!dataReturned) {
          if (responseData.error) {
            // Determine appropriate status code based on error
            const statusCode = responseData.error.includes('No series found') ? 404 : 500;
            res.status(statusCode).json(responseData); // Return the error info
          } else if (responseData.message === 'Contenu non disponible') {
            // Return 200 status with message instead of error
            res.status(200).json(responseData);
          } else {
            res.json(responseData); // Return the freshly fetched data
          }
        }

      } catch (updateError) {
        console.error(`Erreur lors de la mise à jour du cache ${type} ${id}:`, updateError);
        if (!dataReturned && !res.headersSent) { // Check headersSent again
          // Check if the error includes a 404
          if (updateError.message && updateError.message.includes('404')) {
            res.status(200).json({ message: 'Contenu non disponible', french_stream_id: id });
          } else {
            res.status(500).json({ error: 'Erreur lors de la mise à jour du cache', details: updateError.message });
          }
        }
      }
    };

    // Run cache update in the background
    updateCache().catch(err => console.error(`Erreur non gérée dans updateCache (${type} ${id}):`, err));

    // If cached data was already sent, the function ends here.
    // Otherwise, the response will be sent at the end of updateCache.

  } catch (error) {
    console.error(`Erreur initiale dans /api/imdb/${type}/${id}:`, error);
    if (!res.headersSent) {
      // Check if the error includes a 404
      if (error.message && error.message.includes('404')) {
        res.status(200).json({ message: 'Contenu non disponible', french_stream_id: id });
      } else {
        res.status(500).json({ error: 'Erreur serveur interne lors du traitement initial', details: error.message });
      }
    }
  }
});

// Helper function to clean TV cache data before sending
const cleanTvCacheData = (cachedData) => {
  if (!cachedData || !cachedData.series) {
    return cachedData; // Return as is if structure is unexpected
  }
  return {
    type: cachedData.type || 'tv', // ensure type is present
    series: (cachedData.series || []).map(s => ({
      title: s.title || s.baseName, // Use baseName if available
      audio_type: s.audio_type,
      episode_count: s.episode_count,
      release_date: s.release_date,
      summary: s.summary,
      tmdb_data: s.tmdb_data ? {
        id: s.tmdb_data.id,
        name: s.tmdb_data.name,
        overview: s.tmdb_data.overview,
        first_air_date: s.tmdb_data.first_air_date,
        poster_path: s.tmdb_data.poster_path,
        backdrop_path: s.tmdb_data.backdrop_path,
        vote_average: s.tmdb_data.vote_average,
        match_score: s.tmdb_data.match_score,
        is_season_part: s.tmdb_data.is_season_part, // Include season part info
        season_offset: s.tmdb_data.season_offset
      } : null,
      seasons: s.seasons || []
    }))
  };
};
// ... (getFrenchStreamSeries function remains the same) ...
async function getFrenchStreamSeries(id) {
  try {
    const targetUrl = `https://fr.french-stream.sbs/xfsearch/${id}`;

    const response = await makeRequestWithCorsFallback(targetUrl, {
      timeout: 5000,
      decompress: true
    });

    const $ = cheerio.load(response.data);

    // Find all series in the search results
    const seriesList = [];
    $('.short').each(async (index, element) => {
      try {
        const $element = $(element);
        const link = $element.find('.short-poster').attr('href');
        const title = $element.find('.short-title').text().trim();

        // Skip items that don't have "saison" in their title
        if (!title.toLowerCase().includes('saison')) {
          return;
        }

        const posterImg = $element.find('.short-poster img').attr('src');
        const poster = posterImg ? (posterImg.startsWith('/') ? 'https://fr.french-stream.sbs' + posterImg : posterImg) : null;
        const audioType = $element.find('.film-verz a').text().trim();

        // Extract episode count if available
        let episodeCount = null;
        const episodeElement = $element.find('.mli-eps i');
        if (episodeElement.length > 0) {
          episodeCount = parseInt(episodeElement.text().trim());
        }

        seriesList.push({
          title,
          link,
          poster,
          audio_type: audioType,
          episode_count: episodeCount,
          seasons: []  // Will be populated later for each series
        });
      } catch (error) {
        console.error(`Error parsing series element:`, error);
      }
    });

    return seriesList;
  } catch (error) {
    return { error: `Erreur lors de la récupération des séries: ${error.message}` };
  }
}
// ... (getFrenchStreamSeriesDetails function remains the same) ...
async function getFrenchStreamSeriesDetails(seriesUrl, originalTitle) {
  try {
    // Convertir l'URL si elle utilise encore .gratis ou .legal
    const targetUrl = seriesUrl.replace('french-stream.gratis', 'fr.french-stream.sbs').replace('french-stream.legal', 'fr.french-stream.sbs');

    const response = await makeRequestWithCorsFallback(targetUrl, {
      timeout: 5000,
      decompress: true
    });

    const $ = cheerio.load(response.data);

    const seriesTitle = originalTitle;

    // Extract release date from <span class="release"> 2023 - </span>
    let releaseDate = null;

    // Essayer plusieurs sélecteurs possibles pour la date de sortie
    const releaseSelectors = [
      'article div.fmain div.fleft div.poster span.release',
      'span.release',
      'article div.container div div span.release',
      'div.poster span.release',
      '.release'
    ];

    // Essayer chaque sélecteur jusqu'à ce qu'on trouve la date
    for (const selector of releaseSelectors) {
      const releaseElement = $(selector);
      if (releaseElement.length > 0) {
        const releaseDateText = releaseElement.text().trim();
        // Extract year from text like "2023 - "
        const yearMatch = releaseDateText.match(/(\d{4})/);
        if (yearMatch) {
          releaseDate = yearMatch[1];
          break;
        }
      }
    }

    // Si toujours pas trouvé, chercher dans toute la page
    if (!releaseDate) {
      // Chercher tout texte contenant 4 chiffres qui pourrait être une année
      const allText = $('body').text();
      const yearMatches = allText.match(/\b(19\d{2}|20\d{2})\b/g);
      if (yearMatches && yearMatches.length > 0) {
        // Prendre la première année trouvée dans la page
        releaseDate = yearMatches[0];
      }
    }

    // Extract summary from <p> inside #s-desc element
    let summary = null;

    // Essayer différentes approches pour trouver le résumé
    const summarySelectorApproaches = [
      // Approche 1: XPath complet converti en sélecteur CSS
      () => {
        const summaryElement = $('body > div:nth-child(2) > div > div > article > div:nth-child(3) > div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > p:nth-child(2)');
        return summaryElement.length > 0 ? summaryElement.text().trim() : null;
      },

      // Approche 2: Recherche dans la zone principale du contenu
      () => {
        const mainContent = $('.finfo, .fcontent, .fdesc, #s-desc');
        if (mainContent.length > 0) {
          const paragraphs = mainContent.find('p');
          // Récupérer le paragraphe le plus long (probablement le résumé)
          let longestText = "";
          paragraphs.each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > longestText.length &&
              !text.includes("Résumé du film") &&
              !text.includes("streaming complet")) {
              longestText = text;
            }
          });
          return longestText.length > 100 ? longestText : null;
        }
        return null;
      },

      // Approche 3: Recherche par mots-clés
      () => {
        // Mots-clés qui indiquent probablement un résumé
        const summaryKeywords = ["histoire", "série", "saison", "épisode", "personnage", "aventure"];
        const paragraphs = $('p');
        let bestMatch = null;
        let bestScore = 0;

        paragraphs.each((i, el) => {
          const text = $(el).text().trim();
          if (text.length < 100) return; // Trop court pour être un résumé

          // Calculer un score basé sur les mots-clés présents
          let score = 0;
          const lowerText = text.toLowerCase();
          summaryKeywords.forEach(keyword => {
            if (lowerText.includes(keyword)) score++;
          });

          // Bonus pour la longueur (résumés typiquement plus longs)
          score += Math.min(text.length / 200, 3);

          // Malus pour les textes génériques
          if (text.includes("streaming") || text.includes("vostfr") ||
            text.includes("gratuit") || text.includes("Résumé du film")) {
            score -= 5;
          }

          if (score > bestScore) {
            bestScore = score;
            bestMatch = text;
          }
        });

        return bestScore > 2 ? bestMatch : null;
      },

      // Approche 4: Recherche directe du texte après les divs de métadonnées
      () => {
        // Trouver une div qui contient la date de sortie, puis chercher un paragraphe après
        const releaseDiv = $('span.release').closest('div');
        if (releaseDiv.length > 0) {
          // Chercher le premier paragraphe substantiel après cette div
          let currentElement = releaseDiv;
          let found = false;

          // Parcourir jusqu'à 10 éléments suivants
          for (let i = 0; i < 10 && !found; i++) {
            currentElement = currentElement.next();
            if (currentElement.length === 0) break;

            // Si c'est un paragraphe, vérifier son contenu
            if (currentElement.is('p')) {
              const text = currentElement.text().trim();
              if (text.length > 100 &&
                !text.includes("Résumé du film") &&
                !text.includes("streaming complet")) {
                found = true;
                return text;
              }
            }

            // Si c'est une div, chercher des paragraphes à l'intérieur
            const innerP = currentElement.find('p');
            if (innerP.length > 0) {
              const text = innerP.first().text().trim();
              if (text.length > 100 &&
                !text.includes("Résumé du film") &&
                !text.includes("streaming complet")) {
                found = true;
                return text;
              }
            }
          }
        }
        return null;
      }
    ];

    // Essayer chaque approche jusqu'à trouver un résumé
    for (const approach of summarySelectorApproaches) {
      try {
        const result = approach();
        if (result) {
          summary = result;
          break;
        }
      } catch (error) {
        console.error(`Erreur lors de l'extraction du résumé: ${error.message}`);
      }
    }

    // Dernière tentative: analyse du HTML brut
    if (!summary) {
      try {
        const htmlContent = response.data;

        // Chercher le texte qui pourrait être un résumé après des marqueurs communs
        const resumeMarkers = [
          '<div class="fdesc">',
          '<div id="s-desc">',
          '<h2>Synopsis</h2>',
          '<h3>Synopsis</h3>',
          'Synopsis :'
        ];

        for (const marker of resumeMarkers) {
          const markerIndex = htmlContent.indexOf(marker);
          if (markerIndex !== -1) {
            // Chercher le premier paragraphe substantiel après ce marqueur
            const afterMarker = htmlContent.substring(markerIndex + marker.length);
            const paragraphMatch = afterMarker.match(/<p[^>]*>([^<]{100,})<\/p>/);

            if (paragraphMatch && paragraphMatch[1]) {
              summary = paragraphMatch[1].trim();
              break;
            }
          }
        }
      } catch (error) {
        console.error(`Erreur lors de l'analyse du HTML brut: ${error.message}`);
      }
    }

    // Valider que le résumé n'est pas un texte par défaut
    if (summary && (
      summary.includes("Résumé du film") ||
      summary.includes("streaming complet") ||
      summary.includes("vf et vostfr") ||
      summary.includes("vod gratuit sans limite")
    )) {
      summary = null;
    }

    // Find series on TMDB using the extracted info
    let tmdbData = null;
    if (seriesTitle) {
      // Pass the original title from FrenchStream; findTvSeriesOnTMDB will clean it
      tmdbData = await findTvSeriesOnTMDB(seriesTitle, releaseDate, summary);
    }

    // Find all seasons using the new structure
    const seasons = [];
    const seasonsContainer = $('.tab-content > .tab-pane'); // Updated selector

    seasonsContainer.each((seasonIndex, seasonElement) => {
      try {
        const $seasonElement = $(seasonElement);
        const seasonId = $seasonElement.attr('id'); // e.g., season-1
        const seasonNumberMatch = seasonId ? seasonId.match(/\d+$/) : null;
        const seasonNumber = seasonNumberMatch ? parseInt(seasonNumberMatch[0]) : seasonIndex + 1; // Fallback to index if ID parsing fails
        const seasonTitle = `Saison ${seasonNumber}`; // Construct title

        const episodesMap = new Map(); // Use a map to group by episode number

        // Find all episodes in this season
        const episodeElements = $seasonElement.find('ul li'); // Selector seems correct based on provided HTML

        episodeElements.each((episodeIndex, episodeElement) => {
          try {
            const $episodeElement = $(episodeElement);
            const episodeLink = $episodeElement.find('a').first();

            // Extract episode info
            const episodeNumStr = episodeLink.text().trim();
            // Try to extract the base episode number if it contains non-digits (like '1 Special')
            const episodeNumMatch = episodeNumStr.match(/^\d+/);
            const episodeNum = episodeNumMatch ? episodeNumMatch[0] : episodeNumStr; // Use matched number or original string

            const episodeTitle = episodeLink.attr('data-title') || `Episode ${episodeNumStr}`;
            const isVOSTFR = episodeTitle.includes('VOSTFR');
            const langKey = isVOSTFR ? 'vostfr' : 'vf';

            // Get player links
            const players = [];
            $episodeElement.find('.mirrors a').each((playerIndex, playerElement) => {
              const $playerElement = $(playerElement);
              const playerName = $playerElement.text().trim();
              const playerLink = $playerElement.attr('data-link');

              if (playerLink) {
                players.push({
                  name: playerName,
                  link: playerLink
                });
              }
            });

            // Get or create the entry for this episode number
            if (!episodesMap.has(episodeNum)) {
              episodesMap.set(episodeNum, {
                number: episodeNum,
                versions: {}
              });
            }

            // Add the current language version
            episodesMap.get(episodeNum).versions[langKey] = {
              title: episodeTitle,
              players: players
            };

          } catch (error) {
            console.error(`Error parsing episode element (Index ${episodeIndex}) in ${seriesUrl}:`, error.message);
          }
        });

        // Convert map values to array and sort numerically by episode number
        const episodes = Array.from(episodesMap.values()).sort((a, b) => {
          const numA = parseInt(a.number);
          const numB = parseInt(b.number);
          if (isNaN(numA) || isNaN(numB)) return a.number.localeCompare(b.number); // Fallback for non-numeric eps
          return numA - numB;
        });

        seasons.push({
          number: seasonNumber,
          title: seasonTitle,
          episodes: episodes // Use the structured episodes
        });
      } catch (error) {
        console.error(`Error parsing season element (ID ${seasonId || 'unknown'}) in ${seriesUrl}:`, error.message); // Improved error log
      }
    });

    return {
      title: seriesTitle,
      release_date: releaseDate,
      summary: summary,
      tmdb_data: tmdbData,
      seasons: seasons
    };
  } catch (error) {
    return { error: `Failed to fetch series details: ${error.message}` };
  }
}
// Helper function to extract base name and part number from series title
const extractSeriesInfo = (title) => {
  let baseName = title;
  let partNumber = 1; // Default to part 1
  let seasonInfo = {}; // Store season range if present

  // Match "Part X (Saison Y - Z)"
  const partMatch = title.match(/\s*Part\s+(\d+)\s*\(Saison\s+(\d+)\s*-\s*(\d+)\)/i);
  if (partMatch) {
    partNumber = parseInt(partMatch[1]);
    seasonInfo = {
      part: partNumber,
      start: parseInt(partMatch[2]),
      end: parseInt(partMatch[3])
    };
    // Remove the Part info from the base name
    baseName = baseName.replace(/\s*Part\s+\d+\s*\(Saison\s+\d+\s*-\s*\d+\)/i, '');
  }

  // Remove trailing "- Saison X"
  baseName = baseName.replace(/\s*-\s*Saison\s+\d+$/i, '');

  // Remove potential year in parenthesis if not already removed by part info
  baseName = baseName.replace(/\s*\(\d{4}\)/, '');

  return { baseName: baseName.trim(), partNumber, seasonInfo };
};

// Helper function to merge series parts
const mergeSeriesParts = (parts) => {
  if (!parts || parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    return parts[0]; // Nothing to merge
  }

  // Sort parts by partNumber (extracted during grouping)
  parts.sort((a, b) => a.partNumber - b.partNumber);

  const mainPart = parts[0];
  const mergedSeasons = [...(mainPart.seasons || [])]; // Start with seasons from part 1


  // Track the maximum season number added so far
  let maxSeasonNumberSoFar = 0;
  if (mergedSeasons.length > 0) {
    maxSeasonNumberSoFar = Math.max(...mergedSeasons.map(s => s.number));
  }

  for (let i = 1; i < parts.length; i++) {
    const currentPart = parts[i];

    // Calculate the adjustment based on the max season number from the *previous* merged parts
    const adjustment = maxSeasonNumberSoFar;

    if (!currentPart.seasons || currentPart.seasons.length === 0) {
      console.log(`    Part ${currentPart.partNumber} has no seasons to merge.`);
      continue;
    }

    console.log(`    Adjusting ${currentPart.seasons.length} season(s) for Part ${currentPart.partNumber}.`);

    let partMaxSeason = 0; // Track max season added *in this part*
    currentPart.seasons.forEach(season => {
      const originalSeasonNumber = season.number;
      // The adjusted season number is the previous max + the original number from this part
      const adjustedSeasonNumber = adjustment + originalSeasonNumber;
      console.log(`      Merging Season ${originalSeasonNumber} -> ${adjustedSeasonNumber}`);

      // Create a new season object to avoid modifying the original
      const adjustedSeason = {
        ...season,
        number: adjustedSeasonNumber,
        // Adjust title like "Saison X"
        title: `Saison ${adjustedSeasonNumber}`
      };
      mergedSeasons.push(adjustedSeason);
      if (adjustedSeasonNumber > partMaxSeason) {
        partMaxSeason = adjustedSeasonNumber;
      }
    });
    // Update the overall max season number
    maxSeasonNumberSoFar = partMaxSeason;
  }

  // Return the main part with merged seasons
  // Ensure seasons are sorted correctly after merging
  mergedSeasons.sort((a, b) => a.number - b.number);

  return {
    ...mainPart, // Use metadata from the main part
    seasons: mergedSeasons
  };
};

async function checkFrenchStreamVersion(imdbId) {
  try {
    const url = `https://fr.french-stream.sbs/xfsearch/${imdbId}`;
    const response = await axiosFrenchStreamRequest({ method: 'get', url });
    const $ = cheerio.load(response.data);

    // Recherche de la version du film avec le XPath fourni
    const versionElement = $('*[id="dle-content"] div div span:nth-child(2) a');
    const version = versionElement.text().trim();

    return {
      version: version || 'Unknown',
      url: versionElement.attr('href') || null
    };
  } catch (error) {
    // console.error(`Erreur m3u8: ${error.response?.status || 'Erreur réseau'}`);
    return { version: 'Unknown', url: null };
  }
}

// Search endpoint that looks for both movies and TV series on TMDB
app.get('/search/:query', async (req, res) => {
  try {
    const { query } = req.params;

    // Get current date for release date filtering
    const today = new Date();
    const formattedDate = today.toISOString().split('T')[0]; // Format: YYYY-MM-DD

    // Search for movies
    const movieResponse = await axios.get(`${TMDB_API_URL}/search/movie`, {
      params: {
        api_key: TMDB_API_KEY,
        query: query,
        language: 'fr-FR',
        page: 1,
        include_adult: false,
        sort_by: 'popularity.desc'
      }
    });

    // Search for TV series
    const tvResponse = await axios.get(`${TMDB_API_URL}/search/tv`, {
      params: {
        api_key: TMDB_API_KEY,
        query: query,
        language: 'fr-FR',
        page: 1,
        include_adult: false,
        sort_by: 'popularity.desc'
      }
    });

    // Process and filter movie results
    const moviePromises = movieResponse.data.results.map(async movie => {
      // Skip the hasPlayerLinks check and only filter based on TMDB metadata
      if (movie.overview && movie.vote_average > 0 && movie.release_date && movie.release_date <= formattedDate) {
        return {
          id: movie.id,
          title: movie.title,
          original_title: movie.original_title,
          type: 'movie',
          release_date: movie.release_date,
          poster_path: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
          backdrop_path: movie.backdrop_path ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}` : null,
          overview: movie.overview,
          vote_average: movie.vote_average,
          popularity: movie.popularity,
          movix_url: `https://www.movix.blog/movie/${movie.id}`
        };
      }
      return null; // Exclude if no links or fails other filters
    });
    // Function to check if a string uses primarily Latin characters
    const isMainlyLatinCharacters = (str) => {
      if (!str) return false;
      // Check if at least 70% of characters are Latin
      const latinChars = str.match(/[A-Za-z0-9\s\p{P}\p{S}]/gu) || [];
      return latinChars.length / str.length >= 0.7;
    };

    // Sort movies by popularity after filtering and remove non-Latin titles
    const finalMovies = (await Promise.all(moviePromises))
      .filter(Boolean)
      .filter(movie => isMainlyLatinCharacters(movie.title) && isMainlyLatinCharacters(movie.original_title))
      .sort((a, b) => b.popularity - a.popularity);

    // Process and filter TV series results
    const tvSeriesPromises = tvResponse.data.results.map(async seriesItem => {
      // Skip the hasPlayerLinks check and only filter based on TMDB metadata
      if (seriesItem.overview && seriesItem.vote_average > 0 && seriesItem.first_air_date && seriesItem.first_air_date <= formattedDate) {
        return {
          id: seriesItem.id,
          title: seriesItem.name,
          original_title: seriesItem.original_name,
          type: 'tv',
          release_date: seriesItem.first_air_date,
          poster_path: seriesItem.poster_path ? `https://image.tmdb.org/t/p/w500${seriesItem.poster_path}` : null,
          backdrop_path: seriesItem.backdrop_path ? `https://image.tmdb.org/t/p/original${seriesItem.backdrop_path}` : null,
          overview: seriesItem.overview,
          vote_average: seriesItem.vote_average,
          popularity: seriesItem.popularity,
          movix_url: `https://www.movix.blog/tv/${seriesItem.id}`
        };
      }
      return null; // Exclude if no links or fails other filters
    });
    // Sort TV series by popularity after filtering and remove non-Latin titles
    const finalTvSeries = (await Promise.all(tvSeriesPromises))
      .filter(Boolean)
      .filter(series => isMainlyLatinCharacters(series.title) && isMainlyLatinCharacters(series.original_title))
      .sort((a, b) => b.popularity - a.popularity);

    // Structure the results
    const structuredResults = {
      movies: finalMovies,
      tv: finalTvSeries
    };

    res.json(structuredResults);
  } catch (error) {
    console.error(`Erreur m3u8: ${error.response?.status || 'Erreur réseau'}`);
    console.error(`Error searching TMDB for query "${req.params.query}":`, error.message);
    if (error.response) {
      console.error('TMDB API Response Error:', error.response.status, error.response.data);
    }
    res.status(500).json({ error: 'Failed to search TMDB', details: error.message });
  }
});

// User Data Configuration
const USER_DATA_DIR = path.join(__dirname, 'data');
(async () => {
  try {
    await fsp.access(USER_DATA_DIR);
  } catch {
    await fsp.mkdir(USER_DATA_DIR, { recursive: true });
  }
})();
// Create guests directory
const GUESTS_DIR = path.join(USER_DATA_DIR, 'guests');
(async () => {
  try {
    await fsp.access(GUESTS_DIR);
  } catch {
    await fsp.mkdir(GUESTS_DIR, { recursive: true });
  }
})();

// Create users directory
const USERS_DIR = path.join(USER_DATA_DIR, 'users');
(async () => {
  try {
    await fsp.access(USERS_DIR);
  } catch {
    await fsp.mkdir(USERS_DIR, { recursive: true });
  }
})();


// Lecture directe sans cache pour les données utilisateur
async function readUserData(userType, userId) {
  let filePath;
  if (userType === 'guest') {
    filePath = path.join(GUESTS_DIR, `guest-${userId}.json`);
  } else if (userType === 'oauth') {
    filePath = path.join(USERS_DIR, `${userId}.json`);
  } else if (userType === 'bip39') {
    filePath = path.join(USERS_DIR, `bip39-${userId}.json`);
  } else {
    return null;
  }

  try {
    // Lecture directe sans verrou pour la lecture (plus rapide)
    const fileContent = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(fileContent);

    // Sanitize data (avatars) on read
    if (data.profiles && Array.isArray(data.profiles)) {
      data.profiles.forEach(profile => {
        if (profile.avatar && !profile.avatar.startsWith('/avatars/') && profile.avatar !== '') {
          // Invalid avatar, fallback to default
          profile.avatar = '/avatars/disney/disney_avatar_1.png';
        }
      });
    }

    return data;
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Fichier n'existe pas, retourner objet vide
      return {};
    }
    console.error(`Erreur lors de la lecture des données utilisateur ${userType}:${userId}:`, e.message);
    return {};
  }
}

// Fonction d'écriture directe sans cache
async function writeUserData(userType, userId, data) {
  let filePath;
  if (userType === 'guest') {
    filePath = path.join(GUESTS_DIR, `guest-${userId}.json`);
  } else if (userType === 'oauth') {
    filePath = path.join(USERS_DIR, `${userId}.json`);
  } else if (userType === 'bip39') {
    filePath = path.join(USERS_DIR, `bip39-${userId}.json`);
  } else {
    console.error(`Type d'utilisateur invalide: ${userType}`);
    return false;
  }

  try {
    // Valider les données avant l'écriture
    if (!data || typeof data !== 'object') {
      throw new Error('Données invalides: les données doivent être un objet non-null');
    }

    // Utiliser l'écriture atomique sécurisée
    const success = await safeWriteJsonFile(filePath, data);
    if (!success) {
      console.error(`Erreur de sauvegarde atomique pour ${userType}:${userId}`);
    }
    return success;
  } catch (e) {
    console.error(`Erreur de sauvegarde pour ${userType}:${userId}:`, e.message);
    return false;
  }
}


// === GESTION DU GRACEFUL SHUTDOWN ===

// Compteur d'opérations en cours
let activeOperations = 0;

// Fonction pour marquer le début d'une opération
function startOperation() {
  if (isShuttingDown) {
    throw new Error('Server is shutting down');
  }
  activeOperations++;
}

// Fonction pour marquer la fin d'une opération
function endOperation() {
  activeOperations--;
  if (isShuttingDown && activeOperations === 0) {
    console.log('All operations completed, server can shutdown safely');
    process.exit(0);
  }
}

// Fonction pour attendre que toutes les opérations se terminent
function waitForOperations() {
  return new Promise((resolve) => {
    if (activeOperations === 0) {
      resolve();
      return;
    }

    const checkInterval = setInterval(() => {
      if (activeOperations === 0) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
  });
}

// Gestion des signaux de shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, starting graceful shutdown...');
  isShuttingDown = true;
  await waitForOperations();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, starting graceful shutdown...');
  isShuttingDown = true;
  await waitForOperations();
  process.exit(0);
});

process.on('SIGHUP', async () => {
  console.log('SIGHUP received, starting graceful shutdown...');
  isShuttingDown = true;
  await waitForOperations();
  process.exit(0);
});

// User data sync endpoints
// POST sync - requires JWT for oauth/bip39; guests sync is disabled
// Supports both legacy (without profileId) and new (with profileId) methods
app.post('/api/sync', async (req, res) => {
  const startTime = Date.now();
  try {
    // Vérifier si le serveur est en cours d'arrêt
    if (isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down' });
    }

    // Marquer le début de l'opération
    startOperation();

    const { userType, userId, profileId, ops } = req.body;

    // Check for required parameters - profileId is optional for legacy support
    if (!userType || !Array.isArray(ops)) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Determine if this is a legacy request (without profileId)
    const isLegacyRequest = !profileId;

    // Reject guest sync requests
    if (userType === 'guest') {
      return res.status(403).json({ error: 'Guest sync is disabled' });
    }

    // For oauth/bip39 users, extract userId from JWT if not provided
    let finalUserId = userId;
    let authInfo = null;

    if (['oauth', 'bip39'].includes(userType)) {
      const authStart = Date.now();
      authInfo = await getAuthIfValid(req);
      if (!authInfo || authInfo.userType !== userType) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Use userId from JWT if not provided in request body
      if (!finalUserId) {
        finalUserId = authInfo.userId;
      } else if (authInfo.userId !== finalUserId) {
        return res.status(401).json({ error: 'UserId mismatch' });
      }
    } else if (!finalUserId) {
      // For other user types, userId is still required
      return res.status(400).json({ error: 'Missing userId' });
    }

    if (userType === 'vip') {
      return res.status(200).json({ success: true, message: 'VIP users data is not persisted' });
    }

    // Note: updateSessionAccess est déjà appelé dans getAuthIfValid, pas besoin de le rappeler

    // Read current data from server - use legacy or profile method
    let serverData;
    const readStart = Date.now();
    if (isLegacyRequest) {
      // Legacy method: read from user data directly
      serverData = (await readUserData(userType, finalUserId)) || {};
    } else {
      // New method: read from profile data
      serverData = (await readProfileData(userType, finalUserId, profileId)) || {};
    }

    // Keys to ignore from persistence
    const excluded = new Set(['session_id', 'guest_uuid', 'auth_token', 'access_token']);

    // Helper to safely parse JSON
    const safeParse = (str, fallback) => {
      try { return JSON.parse(str); } catch { return fallback; }
    };

    // Apply each operation sequentially
    for (const op of ops) {
      if (!op || !op.key || excluded.has(op.key)) continue;
      const key = op.key;
      const currentRaw = serverData[key];

      switch (op.op) {
        case 'set': {
          if (typeof op.value === 'string') {
            serverData[key] = op.value;
          }
          break;
        }
        case 'remove': {
          delete serverData[key];
          break;
        }
        case 'arrayAdd': {
          const value = op.value;
          const arr = safeParse(currentRaw, []);
          if (Array.isArray(arr)) {
            let next = arr.slice();
            const exists = (item) => {
              if (value && typeof value === 'object' && 'id' in value) {
                return item && typeof item === 'object' && item.id === value.id;
              }
              return JSON.stringify(item) === JSON.stringify(value);
            };
            if (!next.some(exists)) next.push(value);
            serverData[key] = JSON.stringify(next);
          }
          break;
        }
        case 'arrayRemove': {
          const arr = safeParse(currentRaw, []);
          const value = op.value;
          if (Array.isArray(arr)) {
            const next = arr.filter(item => {
              if (value && typeof value === 'object' && 'id' in value) {
                return !(item && typeof item === 'object' && item.id === value.id);
              }
              return JSON.stringify(item) !== JSON.stringify(value);
            });
            serverData[key] = JSON.stringify(next);
          }
          break;
        }
        case 'arrayClear': {
          serverData[key] = '[]';
          break;
        }
        case 'objPatch': {
          const obj = safeParse(currentRaw, {});
          const sets = (op.delta && op.delta.set) || {};
          const removes = (op.delta && op.delta.remove) || [];
          if (typeof obj === 'object' && obj) {
            for (const [k, v] of Object.entries(sets)) {
              // Generic nested array merge support when value contains __arrayPatch
              if (
                v &&
                typeof v === 'object' &&
                v.__arrayPatch
              ) {
                const patch = v.__arrayPatch;
                const currentArrRaw = Array.isArray(obj[k]) ? obj[k] : (() => { try { return JSON.parse(obj[k]); } catch (e) { return []; } })();
                const currentArr = Array.isArray(currentArrRaw) ? currentArrRaw : [];

                const byId = new Map();
                currentArr.forEach((it) => {
                  if (it && typeof it === 'object' && it.id) {
                    byId.set(it.id, it);
                  }
                });

                // Apply patch operations
                if (patch.add) {
                  patch.add.forEach((item) => {
                    if (item && typeof item === 'object' && item.id) {
                      byId.set(item.id, item);
                    }
                  });
                }
                if (patch.update) {
                  patch.update.forEach((item) => {
                    if (item && typeof item === 'object' && item.id) {
                      byId.set(item.id, item);
                    }
                  });
                }
                if (patch.remove) {
                  patch.remove.forEach((item) => {
                    if (item && typeof item === 'object' && item.id) {
                      byId.delete(item.id);
                    }
                  });
                }
                if (patch.removeIds) {
                  patch.removeIds.forEach((id) => {
                    byId.delete(id);
                  });
                }

                obj[k] = Array.from(byId.values());
              } else {
                obj[k] = v;
              }
            }
            removes.forEach((k) => delete obj[k]);
            serverData[key] = JSON.stringify(obj);
          }
          break;
        }
      }
    }

    // Save data back to server
    const writeStart = Date.now();
    let writeSuccess;
    if (isLegacyRequest) {
      writeSuccess = await writeUserData(userType, finalUserId, serverData);
    } else {
      writeSuccess = await writeProfileData(userType, finalUserId, profileId, serverData);
    }

    if (!writeSuccess) {
      console.error(`[SYNC] Échec de l'écriture pour ${userType}:${finalUserId}${profileId ? ':' + profileId : ''}`);
      await logSyncErrorToDiscord('Échec de l\'écriture des données', { userType, userId: finalUserId, profileId, payload: req.body });
      return res.status(500).json({ success: false, error: 'Failed to save data' });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Erreur de sauvegarde:', error);
    const { userType, userId, profileId } = req.body || {};
    await logSyncErrorToDiscord('Exception lors de la synchronisation', { userType, userId, profileId, error: error.message, payload: req.body });
    res.status(500).json({ error: 'Failed to sync data' });
  } finally {
    // Marquer la fin de l'opération
    endOperation();
  }
});

// GET sync - requires JWT for oauth/bip39; guests sync is disabled
// Supports both legacy (without profileId) and new (with profileId) methods
app.get('/api/sync/:userType/:userId/:profileId?', async (req, res) => {
  try {
    // Vérifier si le serveur est en cours d'arrêt
    if (isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down' });
    }

    // Marquer le début de l'opération
    startOperation();

    const { userType, userId, profileId } = req.params;

    // Reject guest sync requests
    if (userType === 'guest') {
      return res.status(403).json({ error: 'Guest sync is disabled' });
    }

    // Enforce JWT for oauth/bip39
    if (['oauth', 'bip39'].includes(userType)) {
      const auth = await getAuthIfValid(req);
      if (!auth || auth.userType !== userType || auth.userId !== userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    if (!userType || !userId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Determine if this is a legacy request (without profileId)
    const isLegacyRequest = !profileId;
    if (userType === 'vip') {
      return res.status(200).json({ success: true, data: {} });
    }

    // Read data using appropriate method
    let data;
    if (isLegacyRequest) {
      // Legacy method: read from user data directly
      data = await readUserData(userType, userId);
    } else {
      // New method: read from profile data
      data = await readProfileData(userType, userId, profileId);
    }

    // Ensure timestamp is a number before sending to client
    if (data && data.lastUpdated) {
      if (typeof data.lastUpdated === 'string') {
        data.lastUpdated = new Date(data.lastUpdated).getTime();
      }
    } else if (data) {
      data.lastUpdated = 0;
    }

    res.status(200).json({ success: true, data: data || {} });
  } catch (error) {
    console.error('Erreur de lecture:', error);
    res.status(500).json({ error: 'Failed to retrieve data' });
  } finally {
    // Marquer la fin de l'opération
    endOperation();
  }
});

// Generate UUID for guest users
app.get('/api/guest/uuid', (req, res) => {
  const uuid = uuidv4();
  res.status(200).json({ uuid });
});

// Profile Management Endpoints

// Helper function to read profile data - lecture directe sans cache
async function readProfileData(userType, userId, profileId) {
  const profileDir = path.join(USERS_DIR, 'profiles', userType, userId);
  const profilePath = path.join(profileDir, `${profileId}.json`);

  try {
    // Lecture directe sans verrou pour la lecture (plus rapide)
    const fileContent = await fsp.readFile(profilePath, 'utf8');
    const data = JSON.parse(fileContent);
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Fichier n'existe pas, retourner objet vide
      return {};
    }
    console.error(`Erreur lors de la lecture des données de profil ${userType}:${userId}:${profileId}:`, e.message);
    return {};
  }
}

// Helper function to write profile data - écriture directe sans cache
async function writeProfileData(userType, userId, profileId, data) {
  const profileDir = path.join(USERS_DIR, 'profiles', userType, userId);
  const profilePath = path.join(profileDir, `${profileId}.json`);

  try {
    // Valider les données avant l'écriture
    if (!data || typeof data !== 'object') {
      throw new Error('Données de profil invalides: les données doivent être un objet non-null');
    }

    // Utiliser l'écriture atomique sécurisée (crée le répertoire automatiquement)
    const success = await safeWriteJsonFile(profilePath, data);
    if (!success) {
      console.error(`Erreur de sauvegarde atomique pour le profil ${profileId}`);
    }
    return success;
  } catch (e) {
    console.error('Error writing profile data:', e);
    return false;
  }
}

// GET /api/profiles - Get all profiles for authenticated user
app.get('/api/profiles', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userData = await readUserData(auth.userType, auth.userId);
    const profiles = userData.profiles || [];

    res.status(200).json({ success: true, profiles });
  } catch (error) {
    console.error('Error getting profiles:', error);
    res.status(500).json({ error: 'Failed to get profiles' });
  }
});

// POST /api/profiles - Create new profile (max 5 per user)
app.post('/api/profiles', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name, avatar } = req.body;
    if (!name || !avatar) {
      return res.status(400).json({ error: 'Name and avatar are required' });
    }

    // Validate avatar format (must be a local path starting with /avatars/)
    if (avatar && !avatar.startsWith('/avatars/') && avatar !== '') {
      return res.status(400).json({ error: 'Invalid avatar URL. Must be a local path starting with /avatars/' });
    }

    const userData = await readUserData(auth.userType, auth.userId);
    const profiles = userData.profiles || [];

    // Check if user already has 5 profiles
    if (profiles.length >= 5) {
      return res.status(400).json({ error: 'Maximum 5 profiles allowed' });
    }

    // Generate new profile ID
    const profileId = uuidv4();
    const newProfile = {
      id: profileId,
      name: name.trim(),
      avatar,
      createdAt: new Date().toISOString(),
      isDefault: profiles.length === 0 // First profile is default
    };

    // Add profile to user data
    userData.profiles = [...profiles, newProfile];
    userData.lastUpdated = Date.now();

    const success = await writeUserData(auth.userType, auth.userId, userData);
    if (!success) {
      return res.status(500).json({ error: 'Failed to create profile' });
    }

    res.status(200).json({ success: true, profile: newProfile });
  } catch (error) {
    console.error('Error creating profile:', error);
    res.status(500).json({ error: 'Failed to create profile' });
  }
});

// PUT /api/profiles/:profileId - Update profile (name, avatar)
app.put('/api/profiles/:profileId', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { profileId } = req.params;
    const { name, avatar } = req.body;

    if (!name && !avatar) {
      return res.status(400).json({ error: 'Name or avatar is required' });
    }

    // Validate avatar format if provided
    if (avatar && !avatar.startsWith('/avatars/') && avatar !== '') {
      return res.status(400).json({ error: 'Invalid avatar URL. Must be a local path starting with /avatars/' });
    }

    const userData = await readUserData(auth.userType, auth.userId);
    const profiles = userData.profiles || [];

    const profileIndex = profiles.findIndex(p => p.id === profileId);
    if (profileIndex === -1) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Update profile
    if (name) profiles[profileIndex].name = name.trim();
    if (avatar) profiles[profileIndex].avatar = avatar;

    userData.profiles = profiles;
    userData.lastUpdated = Date.now();

    const success = await writeUserData(auth.userType, auth.userId, userData);
    if (!success) {
      return res.status(500).json({ error: 'Failed to update profile' });
    }

    res.status(200).json({ success: true, profile: profiles[profileIndex] });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// DELETE /api/profiles/:profileId - Delete profile (except last one)
app.delete('/api/profiles/:profileId', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { profileId } = req.params;

    const userData = await readUserData(auth.userType, auth.userId);
    const profiles = userData.profiles || [];

    // If this is the last profile, we'll allow deletion and create a new default profile
    const isLastProfile = profiles.length <= 1;

    const profileIndex = profiles.findIndex(p => p.id === profileId);
    if (profileIndex === -1) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Check if deleted profile was default BEFORE removing it
    const wasDefault = profiles[profileIndex]?.isDefault;

    // Remove profile from user data
    profiles.splice(profileIndex, 1);

    // If this was the last profile, create a new default profile
    if (isLastProfile) {
      // Get user's account info for new default profile
      let defaultName = 'Profil';
      let defaultAvatar = '/avatars/disney/disney_avatar_1.png';

      if (auth.userType === 'bip39' && userData.auth) {
        try {
          const authData = JSON.parse(userData.auth);
          if (authData.userProfile) {
            defaultName = authData.userProfile.username || 'Profil';
            defaultAvatar = authData.userProfile.avatar || defaultAvatar;
          }
        } catch (e) {
          console.log('Could not parse auth data for new default profile');
        }
      }

      // Create new default profile
      const newProfileId = uuidv4();
      const newDefaultProfile = {
        id: newProfileId,
        name: defaultName,
        avatar: defaultAvatar,
        createdAt: new Date().toISOString(),
        isDefault: true
      };

      profiles.push(newDefaultProfile);
    } else if (wasDefault && profiles.length > 0) {
      // If deleted profile was default and there are remaining profiles, make first remaining profile default
      profiles[0].isDefault = true;
    }

    userData.profiles = profiles;
    userData.lastUpdated = Date.now();

    const success = await writeUserData(auth.userType, auth.userId, userData);
    if (!success) {
      return res.status(500).json({ error: 'Failed to delete profile' });
    }

    // Delete profile data file
    const profileDir = path.join(USERS_DIR, 'profiles', auth.userType, auth.userId);
    const profilePath = path.join(profileDir, `${profileId}.json`);
    try {
      await fsp.unlink(profilePath);
    } catch (e) {
      // Ignore if file doesn't exist
    }

    res.status(200).json({
      success: true,
      newDefaultProfile: isLastProfile ? profiles[profiles.length - 1] : null
    });
  } catch (error) {
    console.error('Error deleting profile:', error);
    res.status(500).json({ error: 'Failed to delete profile' });
  }
});
// GET /api/profiles/:profileId/data - Get profile-specific data
app.get('/api/profiles/:profileId/data', async (req, res) => {
  try {
    // Vérifier si le serveur est en cours d'arrêt
    if (isShuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down' });
    }

    // Marquer le début de l'opération
    startOperation();

    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { profileId } = req.params;

    // Verify profile exists
    const userData = await readUserData(auth.userType, auth.userId);
    const profiles = userData.profiles || [];
    const profile = profiles.find(p => p.id === profileId);

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // Read profile data
    const profileData = await readProfileData(auth.userType, auth.userId, profileId);

    res.status(200).json({ success: true, data: profileData });
  } catch (error) {
    console.error('Error getting profile data:', error);
    res.status(500).json({ error: 'Failed to get profile data' });
  } finally {
    // Marquer la fin de l'opération
    endOperation();
  }
});

// POST /api/profiles/migrate - Migrate existing user data to default profile
app.post('/api/profiles/migrate', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth || !['oauth', 'bip39'].includes(auth.userType)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { userData } = req.body;

    // Check if user already has profiles
    const existingUserData = await readUserData(auth.userType, auth.userId);
    if (existingUserData.profiles && existingUserData.profiles.length > 0) {
      return res.status(400).json({ error: 'User already has profiles' });
    }

    // Get user's account info for default profile
    let defaultName = 'Profil';
    let defaultAvatar = '/avatars/disney/disney_avatar_1.png';

    if (auth.userType === 'bip39' && existingUserData.auth) {
      try {
        const authData = JSON.parse(existingUserData.auth);
        if (authData.userProfile) {
          defaultName = authData.userProfile.username || 'Profil';
          defaultAvatar = authData.userProfile.avatar || defaultAvatar;
        }
      } catch (e) {
        console.log('Could not parse auth data for default profile');
      }
    } else if (auth.userType === 'oauth') {
      // For Discord/Google users, we'll use generic defaults
      defaultName = 'Profil';
    }

    // Create default profile
    const profileId = uuidv4();
    const defaultProfile = {
      id: profileId,
      name: defaultName,
      avatar: defaultAvatar,
      createdAt: new Date().toISOString(),
      isDefault: true
    };

    // Keys to exclude from migration
    const excludedKeys = new Set([
      'auth_token', 'session_id', 'guest_uuid', 'access_token',
      'discord_token', 'google_token', 'auth', 'discord_auth',
      'google_auth', 'bip39_auth', 'discord_user', 'google_user',
      'episodeAlertsLastCheck', 'lastUpdated', 'sessions'
    ]);

    // Migrate user data to profile
    const profileData = {};
    if (userData && typeof userData === 'object') {
      Object.entries(userData).forEach(([key, value]) => {
        if (!excludedKeys.has(key) && typeof value === 'string') {
          profileData[key] = value;
        }
      });
    }

    // Save profile data
    const profileSuccess = await writeProfileData(auth.userType, auth.userId, profileId, profileData);
    if (!profileSuccess) {
      return res.status(500).json({ error: 'Failed to save profile data' });
    }

    // Update user data with profiles list
    existingUserData.profiles = [defaultProfile];
    existingUserData.lastUpdated = Date.now();

    const userSuccess = await writeUserData(auth.userType, auth.userId, existingUserData);
    if (!userSuccess) {
      return res.status(500).json({ error: 'Failed to save user data' });
    }

    res.status(200).json({ success: true, profile: defaultProfile });
  } catch (error) {
    console.error('Error migrating profile:', error);
    res.status(500).json({ error: 'Failed to migrate profile' });
  }
});

// BIP39 Authentication Routes

// Generate a new 12-word mnemonic phrase in French
app.get('/api/auth/bip39/generate', (req, res) => {
  try {
    const mnemonic = bip39.generateMnemonic(128); // 128 bits = 12 words
    res.status(200).json({
      success: true,
      mnemonic: mnemonic
    });
  } catch (error) {
    console.error('Error generating mnemonic:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la génération de la phrase secrète'
    });
  }
});

// Create account with BIP39 mnemonic (returns JWT)
app.post('/api/auth/bip39/create', async (req, res) => {
  try {
    const { mnemonic, username, avatar } = req.body;

    if (!mnemonic || !username) {
      return res.status(400).json({ success: false, error: 'Phrase secrète et nom d\'utilisateur requis' });
    }

    // Normalize mnemonic: lowercase, trim, and collapse multiple spaces to single space
    const normalizedMnemonic = mnemonic.normalize('NFKD').toLowerCase().trim().replace(/\s+/g, ' ');

    // Validate mnemonic
    if (!bip39.validateMnemonic(normalizedMnemonic)) {
      return res.status(400).json({ success: false, error: 'Phrase secrète invalide' });
    }

    // Generate user ID from normalized mnemonic hash
    const userId = crypto.createHash('sha256').update(normalizedMnemonic).digest('hex').substring(0, 16);

    // Create user profile
    const userProfile = {
      id: userId,
      username: username.trim(),
      avatar: avatar || 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp',
      provider: 'bip39',
      createdAt: new Date().toISOString()
    };

    // Create session for BIP39 user
    const sessionId = await createUserSession('bip39', userId, req);
    const token = issueJwt('bip39', userId, sessionId);

    // Save user profile in user data
    let userData = await readUserData('bip39', userId) || {};
    userData.auth = JSON.stringify({
      userProfile,
      provider: 'bip39'
    });
    userData.bip39_auth = 'true';
    userData.lastUpdated = Date.now();
    await writeUserData('bip39', userId, userData);

    res.status(200).json({
      success: true,
      userProfile,
      sessionId,
      token,
      message: 'Compte créé avec succès'
    });
  } catch (error) {
    console.error('Error creating BIP39 account:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la création du compte' });
  }
});

// Login with BIP39 mnemonic (returns JWT)
app.post('/api/auth/bip39/login', async (req, res) => {
  try {
    const { mnemonic } = req.body;

    if (!mnemonic) {
      return res.status(400).json({ success: false, error: 'Phrase secrète requise' });
    }

    // Normalize mnemonic: NFKD (standard BIP39), lowercase, trim, and collapse multiple spaces to single space
    const normalizedMnemonic = mnemonic.normalize('NFKD').toLowerCase().trim().replace(/\s+/g, ' ');

    // Validate mnemonic
    if (!bip39.validateMnemonic(normalizedMnemonic)) {
      return res.status(400).json({ success: false, error: 'Phrase secrète invalide' });
    }

    // Generate user ID from normalized mnemonic hash
    const userId = crypto.createHash('sha256').update(normalizedMnemonic).digest('hex').substring(0, 16);

    // Try to get existing user profile from stored data
    let userProfile = null;
    let userData = await readUserData('bip39', userId) || {};

    try {
      if (userData && userData.auth) {
        const authData = JSON.parse(userData.auth);
        if (authData && authData.userProfile) {
          userProfile = authData.userProfile;
        }
      }
    } catch (error) {
      console.log('No existing user profile found, will create default');
    }

    // If no existing profile found, create a default one and save it
    if (!userProfile) {
      userProfile = {
        id: userId,
        username: `Utilisateur-${userId.substring(0, 8)}`,
        avatar: 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp',
        provider: 'bip39',
        createdAt: new Date().toISOString()
      };

      // Save the default profile to user data
      userData.auth = JSON.stringify({
        userProfile,
        provider: 'bip39'
      });
      userData.bip39_auth = 'true';
      userData.lastUpdated = Date.now();
      await writeUserData('bip39', userId, userData);
    }

    // Create session for BIP39 user
    const sessionId = await createUserSession('bip39', userId, req);
    const token = issueJwt('bip39', userId, sessionId);

    res.status(200).json({
      success: true,
      userId,
      sessionId,
      token,
      userProfile,
      message: 'Connexion réussie'
    });
  } catch (error) {
    console.error('Error logging in with BIP39:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la connexion' });
  }
});

// Discord authentication: verify access_token and issue JWT
app.post('/api/auth/discord/verify', async (req, res) => {
  try {
    const { access_token } = req.body || {};
    if (!access_token) {
      return res.status(400).json({ success: false, error: 'access_token requis' });
    }
    // Verify with Discord API
    const resp = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const user = resp.data;
    if (!user || !user.id) {
      return res.status(401).json({ success: false, error: 'Token Discord invalide' });
    }
    const userId = String(user.id);
    const sessionId = await createUserSession('oauth', userId, req);
    const token = issueJwt('oauth', userId, sessionId);
    return res.status(200).json({ success: true, sessionId, token, user });
  } catch (error) {
    console.error('Discord verify error:', error.response?.status || error.message);
    return res.status(401).json({ success: false, error: 'Échec de vérification Discord' });
  }
});

// Google authentication: verify access_token and issue JWT
app.post('/api/auth/google/verify', async (req, res) => {
  try {
    const { access_token } = req.body || {};
    if (!access_token) {
      return res.status(400).json({ success: false, error: 'access_token requis' });
    }
    // Verify with Google API
    const resp = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const data = resp.data;
    if (!data || !data.sub) {
      return res.status(401).json({ success: false, error: 'Token Google invalide' });
    }
    const userId = String(data.sub);
    const sessionId = await createUserSession('oauth', userId, req);
    const token = issueJwt('oauth', userId, sessionId);
    return res.status(200).json({ success: true, sessionId, token, user: data });
  } catch (error) {
    console.error('Google verify error:', error.response?.status || error.message);
    return res.status(401).json({ success: false, error: 'Échec de vérification Google' });
  }
});

// Session Management Routes

// Utility function to generate device fingerprint
const generateDeviceFingerprint = (userAgent, ip) => {
  const crypto = require('crypto');
  const fingerprint = crypto.createHash('sha256')
    .update(`${userAgent}-${ip || 'unknown'}-${Date.now()}`)
    .digest('hex')
    .substring(0, 32);
  return fingerprint;
};

// Utility function to encrypt device info
const encryptDeviceInfo = (deviceInfo) => {
  const crypto = require('crypto');
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync('movix-session-key', 'salt', 32);
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(deviceInfo, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  return `${iv.toString('base64')}.${encrypted}`;
};



// Create a new session for a user (MySQL)
const createUserSession = async (userType, userId, req) => {
  try {
    if (!pool) {
      console.error('MySQL pool not ready for session creation');
      return null;
    }

    const userAgent = req.headers['user-agent'] || 'Unknown';
    const ip = req.ip || req.connection.remoteAddress || 'Unknown';

    // Generate session ID
    const sessionId = uuidv4();

    // Create encrypted device fingerprint
    const deviceInfo = generateDeviceFingerprint(userAgent, ip);
    const encryptedDevice = encryptDeviceInfo(deviceInfo);

    // Insert session into MySQL
    await pool.execute(
      'INSERT INTO user_sessions (id, user_id, user_type, device, user_agent) VALUES (?, ?, ?, ?, ?)',
      [sessionId, userId, userType, encryptedDevice, userAgent]
    );

    console.log(`[SESSION] Created new session ${sessionId} for ${userType}:${userId}`);
    return sessionId;
  } catch (error) {
    console.error('Error creating user session:', error);
    return null;
  }
};

// Update session access time (MySQL)
const updateSessionAccess = async (userType, userId, sessionId) => {
  try {
    if (!pool) {
      return false;
    }

    // Fire-and-forget: ne pas bloquer le flux principal
    pool.execute(
      'UPDATE user_sessions SET accessed_at = NOW() WHERE id = ? AND user_id = ? AND user_type = ?',
      [sessionId, userId, userType]
    ).catch(err => console.error('Error updating session access:', err));

    return true;
  } catch (error) {
    console.error('Error updating session access:', error);
    return false;
  }
};

// Get user sessions - JWT required (MySQL)
app.get('/api/sessions', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { userType, userId } = auth;

    // Only allow sessions for oauth, bip39 users
    if (!['oauth', 'bip39'].includes(userType)) {
      return res.status(400).json({ success: false, error: 'Type d\'utilisateur non supporté pour les sessions' });
    }

    if (!pool) {
      return res.status(503).json({ success: false, error: 'Service temporairement indisponible' });
    }

    // Get sessions from MySQL
    const [rows] = await pool.execute(
      'SELECT id, device, user_agent as userAgent, created_at as createdAt, accessed_at as accessedAt FROM user_sessions WHERE user_id = ? AND user_type = ? ORDER BY accessed_at DESC',
      [userId, userType]
    );

    const sessions = rows.map(row => ({
      id: row.id,
      userId: userId,
      device: row.device,
      userAgent: row.userAgent,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
      accessedAt: row.accessedAt ? new Date(row.accessedAt).toISOString() : null
    }));

    res.status(200).json({ success: true, data: { count: sessions.length, items: sessions } });
  } catch (error) {
    console.error('Error getting sessions:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la récupération des sessions' });
  }
});

// Delete a specific session - JWT required; user can only delete own session (MySQL)
app.post('/api/sessions/delete', async (req, res) => {
  try {
    const auth = await getAuthIfValid(req);
    if (!auth) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { userType, userId } = auth;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'ID de session requis' });
    }

    if (!['oauth', 'bip39'].includes(userType)) {
      return res.status(400).json({ success: false, error: 'Type d\'utilisateur non supporté pour les sessions' });
    }

    if (!pool) {
      return res.status(503).json({ success: false, error: 'Service temporairement indisponible' });
    }

    // Delete session from MySQL
    const [result] = await pool.execute(
      'DELETE FROM user_sessions WHERE id = ? AND user_id = ? AND user_type = ?',
      [sessionId, userId, userType]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, error: 'Session non trouvée' });
    }

    res.status(200).json({ success: true, message: 'Session supprimée avec succès' });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la suppression de la session' });
  }
});

// Route pour proxy HTML brut (remplace l'ancienne route /proxy)
app.get(/^\/proxy\/(.*)/, async (req, res) => {
  try {
    // Extract the target URL after /proxy/
    let targetUrl = req.url.slice(7); // Remove '/proxy/'

    // Decode the URL recursively if it's encoded (handles double/triple encoding)
    try {
      let decoded = targetUrl;
      let previousDecoded = '';
      // Keep decoding until the URL doesn't change anymore (handles multiple encodings)
      while (decoded !== previousDecoded) {
        previousDecoded = decoded;
        try {
          decoded = decodeURIComponent(decoded);
        } catch (e) {
          // If decoding fails, break the loop
          break;
        }
      }
      targetUrl = decoded;
    } catch (decodeError) {
      // If decoding fails, use the original URL
      console.warn('Failed to decode URL:', targetUrl, decodeError.message);
    }

    // Fix recursive proxying issue - remove any localhost/proxy/ patterns
    const localhostProxyPattern = /localhost(:\d+)?\/proxy\//i;
    if (localhostProxyPattern.test(targetUrl)) {
      console.log(`Detected recursive proxy request in: ${targetUrl}`);
      targetUrl = targetUrl.replace(localhostProxyPattern, '');
      console.log(`Corrected to: ${targetUrl}`);
    }

    // Check if the URL starts with http(s)://, if not, prepend https://
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }

    // === TVDIRECT SPECIAL HANDLING ===
    if (targetUrl.includes('tvdirect.ddns')) {
      try {
        const cacheKey = crypto.createHash('md5').update(targetUrl).digest('hex');
        // Ensure directory exists
        await fsp.mkdir(CACHE_DIR.TVDIRECT, { recursive: true });
        const cacheFile = path.join(CACHE_DIR.TVDIRECT, `${cacheKey}.json`);

        // Helper to fetch external resource
        const fetchTvDirect = async () => {
          console.log(`[TVDIRECT] Fetching ${targetUrl}`);
          const resp = await axios.get(targetUrl, {
            headers: {
              'User-Agent': 'stremio',
              'Accept': '*/*'
            },
            responseType: 'text',
            timeout: 15000
          });
          return {
            data: resp.data,
            headers: resp.headers,
            timestamp: Date.now()
          };
        };

        // Try to read from cache
        let cachedEntry = null;
        try {
          const fileContent = await fsp.readFile(cacheFile, 'utf8');
          cachedEntry = JSON.parse(fileContent);
        } catch (e) { /* No cache or invalid */ }

        const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
        const now = Date.now();

        if (cachedEntry && cachedEntry.data) {
          // Serve cached response
          if (cachedEntry.headers && cachedEntry.headers['content-type']) {
            res.setHeader('Content-Type', cachedEntry.headers['content-type']);
          }
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.send(cachedEntry.data);

          // Check if stale for background update
          if (now - cachedEntry.timestamp > CACHE_TTL) {
            console.log(`[TVDIRECT] Cache stale for ${targetUrl}, updating in background...`);
            // Background update (no await)
            fetchTvDirect().then(async (newData) => {
              await safeWriteJsonFile(cacheFile, newData);
              console.log(`[TVDIRECT] Background update success for ${targetUrl}`);
            }).catch(err => console.error(`[TVDIRECT] Background update failed: ${err.message}`));
          }
          return; // Exit route
        }

        // No cache, fetch synchronously
        const newData = await fetchTvDirect();
        await safeWriteJsonFile(cacheFile, newData);

        if (newData.headers && newData.headers['content-type']) {
          res.setHeader('Content-Type', newData.headers['content-type']);
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(newData.data);
        return; // Exit route
      } catch (error) {
        console.error(`[TVDIRECT] Error handling request:`, error);
        return res.status(502).json({ error: 'TVDirect proxy failed', details: error.message });
      }
    }

    // Préparer les headers à forwarder
    let refererOrigin;
    let targetHost;
    try {
      const urlObj = new URL(targetUrl);
      refererOrigin = urlObj.origin;
      targetHost = urlObj.host;
    } catch (urlError) {
      // Si l'URL est invalide, utiliser une valeur par défaut
      console.warn('Invalid URL for referer:', targetUrl, urlError.message);
      refererOrigin = 'https://vmwesa.online';
      targetHost = 'vmwesa.online';
    }

    // Headers spécifiques pour vmwesa/vidmoly et certains CDN (ex: getromes.space)
    const isVmwesa = /vmwesa\.online|vidmoly|getromes\.space/i.test(targetUrl);

    // Headers spécifiques pour dropcdn
    const isDropcdn = /dropcdn/i.test(targetUrl);

    // Headers spécifiques pour serversicuro
    const isServersicuro = /serversicuro/i.test(targetUrl);

    // Headers spécifiques pour coflix
    const isCoflix = /coflix\.(bet|si|boo|io)/i.test(targetUrl);

    const headers = isCoflix ? {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.7',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Priority': 'u=0, i',
      'Referer': 'https://coflix.observer/',
      'Sec-CH-UA': '"Brave";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Storage-Access': 'none',
      'Sec-GPC': '1',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    } : isVmwesa ? {
      'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'fr-FR,fr;q=0.8',
      'Connection': 'keep-alive',
      'Host': targetHost,
      'Origin': 'https://vidmoly.net',
      'Referer': 'https://vidmoly.net/',
      'Sec-CH-UA': '"Not;A=Brand";v="99", "Brave";v="139", "Chromium";v="139"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-GPC': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
    } : isDropcdn ? {
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      'Connection': 'keep-alive',
      'Host': targetHost,
      'Origin': 'https://dropload.tv',
      'Referer': 'https://dropload.tv/',
      'Sec-CH-UA': '"Not;A=Brand";v="99", "Brave";v="139", "Chromium";v="139"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-GPC': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
    } : isServersicuro ? {
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'fr-FR,fr;q=0.8',
      'Connection': 'keep-alive',
      'Host': targetHost,
      'Origin': 'https://supervideo.cc',
      'Referer': 'https://supervideo.cc/',
      'Sec-CH-UA': '"Not;A=Brand";v="99", "Brave";v="139", "Chromium";v="139"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-GPC': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
    } : {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Referer': refererOrigin,
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Encoding': req.headers['accept-encoding'] || 'gzip, deflate, br',
      'Connection': 'keep-alive',
    };
    // Forward Range header if present (important for video streaming)
    if (req.headers['range']) {
      headers['Range'] = req.headers['range'];
    }

    // Détecter si c'est un .m3u8 (playlist HLS)
    const isM3U8 = targetUrl.toLowerCase().includes('.m3u8') || (req.headers.accept && req.headers.accept.includes('application/vnd.apple.mpegurl'));

    // Faire la requête distante avec l'agent de streaming pour le proxy
    const response = await axios({
      method: 'get',
      url: targetUrl,
      responseType: isM3U8 ? 'text' : 'stream',
      headers,
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: status => true, // On gère nous-même les codes d'erreur
      decompress: true // Disable automatic decompression for better performance
    });

    // Copier les headers utiles
    Object.entries(response.headers).forEach(([key, value]) => {
      // Éviter certains headers problématiques
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS', 'DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');

    // Si c'est un .m3u8, retourner le contenu original sans modification
    if (isM3U8 && typeof response.data === 'string') {
      const contentType = response.headers['content-type'] || '';
      const bodyText = response.data;

      // Retourner le contenu M3U8 original sans modification
      if (contentType) res.setHeader('content-type', contentType);
      res.status(response.status).send(bodyText);
      return;
    }

    // Gestion du code de retour (206 pour Range, sinon code d'origine)
    res.status(response.status);

    // Détecter si c'est un flux vidéo (.m3u8, .ts) pour appliquer le throttle approprié
    const isVideoStream = targetUrl.toLowerCase().includes('.m3u8') ||
      targetUrl.toLowerCase().includes('.ts') ||
      (req.headers.accept && req.headers.accept.includes('application/vnd.apple.mpegurl'));

    if (isVideoStream) {
      response.data.pipe(res);
    } else {
      response.data.pipe(res);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    if (error.response) {
      res.status(error.response.status).json({
        error: `Target server responded with ${error.response.status}`,
        message: error.message
      });
    } else if (error.request) {
      res.status(504).json({
        error: 'Gateway Timeout',
        message: 'No response received from target server'
      });
    } else {
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
      });
    }
  }
});

app.get('/api/darkino/download-premium/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Effectuer la requête POST sans payload, juste les cookies
    const response = await axiosDarkinoRequest({ method: 'post', url: `/api/v1/download-premium/${id}` });
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Erreur lors de la requête download-premium:', error.response?.status || error.message);
    if (error.response) {
      res.status(error.response.status).json({ error: error.response.data || 'Erreur lors de la requête download-premium' });
    } else {
      res.status(500).json({ error: 'Erreur lors de la requête download-premium' });
    }
  }
});

// Fonction utilitaire pour paginer intelligemment sur l'API Darkibox
async function findDarkiboxEntriesForEpisode({ titleId, seasonId, episodeId, perPage = 100, maxPages = 10 }) {
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
      // Utiliser la nouvelle fonction de requête
      const resp = await axiosDarkinoRequest({
        method: 'get',
        url: url,
        headers: darkiHeaders
      });
      const data = resp.data?.pagination?.data || [];
      // Cherche les entrées correspondant à l'épisode
      const matching = data.filter(entry =>
        entry.host && entry.host.id_host === 2 && entry.host.name === 'darkibox' &&
        (entry.episode_id == episodeId || entry.episode == episodeId || entry.episode_number == episodeId)
      );
      if (matching.length > 0) {
        foundEntries = matching;
        break;
      }
      // Pagination intelligente :
      const nextPage = resp.data?.pagination?.next_page;
      if (!nextPage) {
        shouldContinue = false;
      } else {
        page = nextPage;
      }
    } catch (error) {
      console.error(`[DARKIBOX] Erreur lors de la recherche des liens (page ${page}):`, error.message);
      shouldContinue = false;
    }
  }
  return foundEntries;
}

// Variable pour suivre le dernier appel à la page d'accueil de Darkino
let lastDarkinoHomeRequest = 0;
const DARKINO_SESSION_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes en millisecondes

// Fonction pour rafraîchir la session Darkino seulement si nécessaire
const refreshDarkinoSessionIfNeeded = async () => {
  const now = Date.now();
  if (now - lastDarkinoHomeRequest > DARKINO_SESSION_REFRESH_INTERVAL) {
    try {
      // Utiliser la nouvelle fonction de requête
      await axiosDarkinoRequest({ method: 'get', url: '/' });
      lastDarkinoHomeRequest = now;
      console.log('[DARKINO] Session refreshed');
    } catch (error) {
      // Ne pas logger les erreurs 500/403 pour DARKINO session refresh
      if (!error.response || (error.response.status !== 500 && error.response.status !== 403)) {
        console.error('[DARKINO] Failed to refresh session:', error.message);
      }
    }
  }
};
app.get('/api/titles/:id/download', async (req, res) => {
  if (DARKINO_MAINTENANCE) {
    return res.status(200).json({ error: 'Service Darkino temporairement indisponible (maintenance)' });
  }
  try {
    const { id } = req.params;

    // Generate cache key
    const cacheKey = generateCacheKey(`titles_download_${id}`);

    // Check if results are in cache
    const cachedData = await getFromCacheNoExpiration(DARKINOS_CACHE_DIR, cacheKey);
    const M3U8_CACHE_EXPIRY = 8 * 60 * 60 * 1000; // 8 hours in milliseconds

    let dataReturned = false;
    if (cachedData && cachedData.sources !== undefined) {
      // console.log(`[API/TITLES/DOWNLOAD] Found cached data for ${id}`);

      const now = Date.now();
      const needM3u8Refresh = !cachedData.m3u8Timestamp || (now - cachedData.m3u8Timestamp > M3U8_CACHE_EXPIRY);
      let sourcesWithM3u8 = cachedData.sourcesWithM3u8 || [];

      if (needM3u8Refresh) {
        // console.log(`[API/TITLES/DOWNLOAD] Refreshing M3U8 URLs for ${id}`);
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
        // Mise à jour du cache avec les URLs m3u8 rafraîchies
        await saveToCache(DARKINOS_CACHE_DIR, cacheKey, {
          sources: cachedData.sources,
          sourcesWithM3u8: sourcesWithM3u8,
          m3u8Timestamp: now
        });
      }

      // Déduplication des sources par m3u8
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
      // Déduplication supplémentaire sur src (pour éviter les doublons d'URL)
      const finalSources = [];
      for (const source of dedupedSources) {
        if (!seenSrc.has(source.src)) {
          seenSrc.add(source.src);
          finalSources.push(source);
        }
      }
      // Filtrer les sources avec m3u8: null avant de retourner
      const filteredSources = finalSources.filter(source => source.m3u8 !== null);
      // Retourner les sources dédupliquées et filtrées
      res.status(200).json({ sources: filteredSources });
      dataReturned = true;
      (async () => {
        try {
          // Vérifier si le cache doit être mis à jour
          const shouldUpdate = await shouldUpdateCache(DARKINOS_CACHE_DIR, cacheKey);
          if (!shouldUpdate) {
            return; // Ne pas mettre à jour le cache
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
    // Si pas de cache valide, comportement normal (requête Darkino)
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
        if (error.response?.data?.message === "Il y a eu un problème. Veuillez réessayer plus tard.") {
          throw error;
        }

        // Arrêter immédiatement sur les erreurs 500/403
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
    // ... existing code ...

  } catch (error) {
    console.error(`Erreur lors de la récupération des liens de téléchargement:`, error);
    res.status(500).json({ error: 'Erreur lors de la récupération des liens de téléchargement' });
  }
});

// Supprime le cache d'un film
app.delete('/api/films/download/:id/cache', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = generateCacheKey(`films_download_${id}`);
    const cacheFile = path.join(DARKINOS_CACHE_DIR, `${cacheKey}.json`);
    await fsp.unlink(cacheFile);
    return res.status(200).json({ success: true, message: `Cache film ${id} supprimé.` });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Cache introuvable.' });
    }
    console.error('Erreur suppression cache film :', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});

// Supprime le cache d'un épisode de série
app.delete('/api/series/download/:titleId/season/:seasonId/episode/:episodeId/cache', async (req, res) => {
  try {
    const { titleId, seasonId, episodeId } = req.params;
    const cacheKey = generateCacheKey(`series_download_${titleId}_${seasonId}_${episodeId}`);
    const cacheFile = path.join(DARKINOS_CACHE_DIR, `${cacheKey}.json`);
    await fsp.unlink(cacheFile);
    return res.status(200).json({ success: true, message: `Cache épisode ${titleId}/${seasonId}/${episodeId} supprimé.` });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Cache introuvable.' });
    }
    console.error('Erreur suppression cache épisode :', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur.' });
  }
});





// Liste des proxies SOCKS5 (avec authentification)
const parseJsonArrayEnv = (envName, fallback = []) => {
  const rawValue = process.env[envName];
  if (!rawValue) return fallback;
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const PROXIES = parseJsonArrayEnv('SOCKS5_PROXIES', []);



// Liste des proxies HTTP spécifiques pour Darkino/Darkiworld
const DARKINO_HTTP_PROXIES = [
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px023004.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px023005.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px016007.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px016008.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px022505.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px022507.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px016501.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px016006.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px051005.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px052001.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px051003.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px043005.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px090404.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px043006.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px043004.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px410701.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px015601.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px200401.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px032004.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px014004.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px490701.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px032002.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px013601.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px580801.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px210404.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px591701.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px591801.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px711001.pointtoserver.com:10780',
  'http://purevpn0s7397024:6CU9ZvexLGTqpB@px510201.pointtoserver.com:10780'
];

// Convertir les proxies HTTP en objets pour Darkino
const DARKINO_PROXIES = DARKINO_HTTP_PROXIES.map(proxyStr => {
  // Parser l'URL HTTP: http://user:pass@host:port
  if (proxyStr.includes('://')) {
    // Format: http://user:pass@host:port
    const match = proxyStr.match(/^(\w+):\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
    if (match) {
      return {
        host: match[4],
        port: parseInt(match[5]),
        auth: match[2] && match[3] ? `${match[2]}:${match[3]}` : undefined,
        type: match[1]
      };
    }
  }
  // Format HTTP simple: host:port
  const [host, port] = proxyStr.split(':');
  return { host, port: parseInt(port), type: 'http' };
});

// Fonction utilitaire pour choisir aléatoirement un proxy (toujours utiliser un proxy)
function pickRandomProxyOrNone() {
  // Sélectionner toujours un proxy aléatoire parmi la liste
  const idx = Math.floor(Math.random() * PROXIES.length);
  return PROXIES[idx];
}

// Fonction utilitaire pour créer un agent proxy SOCKS5 (avec cache)
function getProxyAgent(proxy) {
  if (!proxy) return null;
  const auth = proxy.auth ? `${proxy.auth}@` : '';
  const cacheKey = `${proxy.host}:${proxy.port}:${auth}`;

  // Vérifier le cache d'abord
  if (proxyAgentCache.has(cacheKey)) {
    return proxyAgentCache.get(cacheKey);
  }

  const proxyUrl = `socks5h://${auth}${proxy.host}:${proxy.port}`;
  // Utilisation de SocksProxyAgent pour les proxies SOCKS5
  const agent = new SocksProxyAgent(proxyUrl);

  // Mettre en cache l'agent
  proxyAgentCache.set(cacheKey, agent);
  return agent;
}

// Fonction utilitaire pour créer un agent proxy (pour Darkino) - avec cache
function getDarkinoHttpProxyAgent(proxy) {
  if (!proxy) return null;
  const auth = proxy.auth ? `${proxy.auth}@` : '';
  const cacheKey = `${proxy.type}:${proxy.host}:${proxy.port}:${auth}`;

  // Vérifier le cache d'abord
  if (darkinoProxyAgentCache.has(cacheKey)) {
    return darkinoProxyAgentCache.get(cacheKey);
  }

  let agents;
  if (proxy.type === 'socks5h' || proxy.type === 'socks5') {
    // Utilisation de SocksProxyAgent pour les proxies SOCKS5
    const proxyUrl = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
    const agent = new SocksProxyAgent(proxyUrl);
    agents = {
      httpAgent: agent,
      httpsAgent: agent
    };
  } else {
    // Utilisation de HttpProxyAgent et HttpsProxyAgent pour les proxies HTTP
    // IMPORTANT: Inclure l'authentification dans l'URL du proxy
    const proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`;
    agents = {
      httpAgent: new HttpProxyAgent(proxyUrl),
      httpsAgent: new HttpsProxyAgent(proxyUrl)
    };
  }

  // Mettre en cache les agents
  darkinoProxyAgentCache.set(cacheKey, agents);
  return agents;
}

// Fonction utilitaire pour générer le referer dynamiquement
function generateDarkiReferer(url) {
  const baseUrl = 'https://darkiworld2026.com';

  if (url.includes('/season/') && url.includes('/episode/') && url.includes('/download')) {
    // Pour les épisodes de séries: /titles/{titleId}/season/{seasonId}/episode/{episodeId}/download
    const match = url.match(/\/titles\/(\d+)\/season\/(\d+)\/episode\/(\d+)\/download/);
    if (match) {
      const [, titleId, seasonId, episodeId] = match;
      return `${baseUrl}/titles/${titleId}/season/${seasonId}/episode/${episodeId}/download?filters=W3sia2V5IjoiaWRfaG9zdCIsInZhbHVlIjoyLCJpc0luYWN0aXZlIjpmYWxzZSwidmFsdWVLZXkiOjJ9XQ%3D%3D`;
    }
  } else if (url.includes('/titles/') && url.includes('/download')) {
    // Pour les films: /titles/{id}/download
    const match = url.match(/\/titles\/(\d+)\/download/);
    if (match) {
      const [, titleId] = match;
      return `${baseUrl}/titles/${titleId}/download`;
    }
  } else if (url.includes('/search/')) {
    // Pour la recherche
    return `${baseUrl}/search`;
  }

  // Par défaut, utiliser l'URL de base
  return baseUrl;
}
// Fonction utilitaire pour requêtes Darkino avec proxies (SOCKS5h)
async function axiosDarkinoRequest(config) {
  // Vérifier si on est en cooldown après une erreur 403
  if (Date.now() < darkino403CooldownUntil) {
    const remainingMs = darkino403CooldownUntil - Date.now();
    const remainingMin = Math.ceil(remainingMs / 60000);
    const error = new Error(`Darkino en cooldown (403 Cloudflare). Réessayez dans ${remainingMin} minute(s).`);
    error.isDarkinoCooldown = true;
    error.response = { status: 403 };
    throw error;
  }

  const requestUrl = `https://darkiworld2026.com${config.url}`;

  // Générer le referer dynamiquement selon l'URL
  const dynamicReferer = generateDarkiReferer(config.url);

  // Headers pour les requêtes Darkino
  const darkinoRequestHeaders = {
    ...darkiHeaders,
    'referer': dynamicReferer,
    ...config.headers,
  };

  if (!ENABLE_DARKINO_PROXY) {
    // Si le proxy est désactivé, faire la requête directe
    try {
      const response = await axios({
        ...config,
        url: requestUrl,
        headers: darkinoRequestHeaders,
        timeout: 15000,
        withCredentials: false,
        decompress: true
      });

      const setCookieHeader = response.headers['set-cookie'];
      if (setCookieHeader) {
        await Promise.all(setCookieHeader.map(cookie => cookieJar.setCookie(cookie, 'https://darkiworld2026.com')));
      }
      return response;
    } catch (error) {
      if (error.response && error.response.headers['set-cookie']) {
        const setCookieHeader = error.response.headers['set-cookie'];
        await Promise.all(setCookieHeader.map(cookie => cookieJar.setCookie(cookie, 'https://darkiworld2026.com')));
      }
      // En cas d'erreur 403, activer le cooldown
      if (error.response?.status === 403) {
        darkino403CooldownUntil = Date.now() + DARKINO_403_COOLDOWN_MS;
        console.log(`[DARKINO] Erreur 403 détectée (direct) - Cooldown activé pour 5 minutes`);
      }
      throw error;
    }
  }

  // Utiliser les proxies HTTP spécifiques de Darkino avec rotation aléatoire
  const darkinoProxies = [...DARKINO_PROXIES]; // Copie pour pouvoir mélanger

  // Mélanger aléatoirement les proxies
  for (let i = darkinoProxies.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [darkinoProxies[i], darkinoProxies[j]] = [darkinoProxies[j], darkinoProxies[i]];
  }

  let lastError = null;
  const maxRetries = 1; // Une seule tentative

  for (let i = 0; i < maxRetries; i++) {
    const proxy = darkinoProxies[i];
    const agents = getDarkinoHttpProxyAgent(proxy);

    try {
      const response = await axios({
        ...config,
        method: config.method || 'get',
        url: requestUrl,
        headers: darkinoRequestHeaders,
        timeout: 20000,
        withCredentials: false,
        decompress: true,
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent,
        proxy: false
      });

      // Mettre à jour le cookieJar avec la réponse
      const setCookieHeader = response.headers['set-cookie'];
      if (setCookieHeader) {
        await Promise.all(setCookieHeader.map(cookie => cookieJar.setCookie(cookie, 'https://darkiworld2026.com')));
      }
      return response;
    } catch (error) {
      lastError = error;
      const statusCode = error.response?.status;

      // Mettre à jour les cookies même en cas d'erreur si le header est présent
      if (error.response && error.response.headers['set-cookie']) {
        const setCookieHeader = error.response.headers['set-cookie'];
        await Promise.all(setCookieHeader.map(cookie => cookieJar.setCookie(cookie, 'https://darkiworld2026.com')));
      }

      // En cas d'erreur 429 (Too Many Requests), essayer avec le prochain proxy si disponible
      if (statusCode === 429) {
        continue;
      }

      // En cas d'erreur 403 (Cloudflare challenge), activer le cooldown de 5 minutes
      if (statusCode === 403) {
        darkino403CooldownUntil = Date.now() + DARKINO_403_COOLDOWN_MS;
        throw error;
      }

      // Pour les autres erreurs (400, 500, etc.), arrêter immédiatement
      if (statusCode && statusCode !== 429) {
        throw error;
      }
    }
  }

  // Si on arrive ici, tous les proxies ont échoué
  throw lastError || new Error('Tous les proxies Darkino ont échoué');
}

// Fonction utilitaire pour requêtes Coflix avec proxies Cloudflare Workers
async function axiosCoflixRequest(config) {
  // Détection robuste du domaine cible (coflix.observer, coflix.si, coflix.cc, coflix.boo). Si URL relative, on considère que c'est Coflix.
  const targetUrl = config.url || '';
  const isAbsolute = /^https?:\/\//i.test(targetUrl);
  const isCoflixDomain = isAbsolute ? /(coflix\.(observer|bz|fi|si|boo|io|foo))/i.test(targetUrl) : true;

  try {
    if (!ENABLE_COFLIX_PROXY || !isCoflixDomain) {
      return await axiosCoflix({ ...config });
    }

    // Utiliser makeCoflixRequest avec les proxies Cloudflare Workers
    const absoluteUrl = isAbsolute
      ? targetUrl
      : `${COFLIX_BASE_URL}${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;

    return await makeCoflixRequest(absoluteUrl, {
      headers: { ...coflixHeaders, ...(config.headers || {}) },
      timeout: config.timeout || 7000,
      decompress: true,
      responseType: config.responseType
    });
  } catch (error) {
    // Logger les erreurs 403
    if (error.response?.status === 403) {
      console.log(`[Coflix] Erreur 403 Forbidden dans axiosCoflixRequest`);
      console.log(`[Coflix] URL: ${targetUrl}`);
    }
    throw error;
  }
}

// Fonction utilitaire pour requêtes French-Stream (SPA) via CORS fallback
async function axiosFrenchStreamRequest(config) {
  const targetUrl = config.url || '';
  const isAbsolute = /^https?:\/\//i.test(targetUrl);
  const baseMatches = config.baseURL && /french-?stream/i.test(config.baseURL);
  const isFrenchStream = /french-?stream/i.test(targetUrl) || baseMatches;

  if (!ENABLE_FRENCH_STREAM_PROXY || !isFrenchStream) {
    return axios({ ...config });
  }

  const absoluteUrl = isAbsolute
    ? targetUrl
    : (config.baseURL ? `${config.baseURL.replace(/\/$/, '')}/${targetUrl.replace(/^\//, '')}` : targetUrl);

  return makeRequestWithCorsFallback(absoluteUrl, {
    headers: { ...(config.headers || {}) },
    timeout: config.timeout || 5000,
    decompress: true,
    responseType: config.responseType
  });
}

// Fonction utilitaire pour requêtes LecteurVideo avec proxies Wiflix
async function axiosLecteurVideoRequest(config) {
  const urlStr = config.url || '';
  const isLecteur = /lecteurvideo|lecteur-video|lecteur/i.test(urlStr) || (config.baseURL && /lecteurvideo|lecteur-video|lecteur/i.test(config.baseURL));

  if (!ENABLE_LECTEURVIDEO_PROXY || !isLecteur) {
    return axios({ ...config });
  }

  try {
    // Construire l'URL absolue si nécessaire
    let absoluteUrl = config.url;
    if (config.baseURL && !config.url.startsWith('http')) {
      // Nettoyer les URLs avant la concaténation pour éviter les espaces
      const cleanBaseURL = config.baseURL.trim();
      const cleanUrl = config.url.trim();
      absoluteUrl = cleanBaseURL + cleanUrl;
    }

    // Utiliser makeLecteurVideoRequest avec les proxies Wiflix
    return await makeLecteurVideoRequest(absoluteUrl, {
      timeout: config.timeout || 5000,
      headers: config.headers,
      decompress: config.decompress !== false,
      responseType: config.responseType,
      responseEncoding: config.responseEncoding
    });
  } catch (error) {
    throw error;
  }
}

// Fonction utilitaire pour requêtes FStream avec proxy (sans retry)
async function axiosFStreamRequest(config) {
  const urlStr = config.url || '';
  const isFStream = urlStr.includes(FSTREAM_BASE_URL.replace('https://', '').replace('http://', '')) ||
    (config.baseURL && config.baseURL.includes(FSTREAM_BASE_URL.replace('https://', '').replace('http://', '')));

  if (!ENABLE_FSTREAM_PROXY || !isFStream) {
    // S'assurer que la session est valide et attacher le cookie automatiquement
    await ensureFStreamSession();
    const existingHeaders = config.headers || {};
    const cookieHeader = Object.entries(fstreamCookies)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const response = await axiosFStream({
      ...config,
      timeout: 8000,
      headers: {
        ...existingHeaders,
        'Cookie': existingHeaders['Cookie'] || cookieHeader
      }
    });
    // Incrémenter le compteur après une requête réussie
    fstreamRequestCounter++;
    return response;
  }

  // Utiliser un seul proxy aléatoire sans retry
  const shuffledProxies = [...PROXIES].sort(() => Math.random() - 0.5);
  const proxy = shuffledProxies[0]; // Prendre seulement le premier proxy

  try {
    const agent = getProxyAgent(proxy);
    // S'assurer que la session est valide et attacher le cookie automatiquement
    await ensureFStreamSession();
    const existingHeaders = config.headers || {};
    const cookieHeader = Object.entries(fstreamCookies)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const response = await axiosFStream({
      ...config,
      timeout: 6000, // Timeout strict de 6 secondes
      decompress: true,
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false
      ,
      headers: {
        ...existingHeaders,
        'Cookie': existingHeaders['Cookie'] || cookieHeader
      }
    });
    // Incrémenter le compteur après une requête réussie
    fstreamRequestCounter++;
    return response;
  } catch (error) {
    // Pas de retry, jeter directement l'erreur
    throw error;
  }
}

// Fonction utilitaire pour requêtes AnimeSama avec proxy
async function axiosAnimeSamaRequest(config) {
  let urlStr = config.url || '';

  // Nettoyage automatique des URLs supprimé comme demandé:
  // On utilise désormais directement l'URL fournie (qui doit être correcte via ANIME_SAMA_URL)
  
  const isAnimeSama = urlStr.includes('anime-sama.si') || urlStr.includes('anime-sama.fr') ||
    (config.baseURL && (config.baseURL.includes('anime-sama.si') || config.baseURL.includes('anime-sama.fr')));

  if (!ENABLE_ANIME_PROXY || !isAnimeSama) {
    return axiosAnimeSama({ ...config, timeout: 30000 });
  }

  // Filtrer les proxies disponibles (non en cooldown)
  const availableProxies = getAvailableProxies(CLOUDFLARE_WORKERS_PROXIES);

  // Construire l'URL complète
  let absoluteUrl = urlStr;
  if (config.baseURL && !urlStr.startsWith('http')) {
    absoluteUrl = config.baseURL + urlStr;
  } else if (!urlStr.startsWith('http') && !absoluteUrl.startsWith('http')) {
    // Si l'URL n'est pas complète et qu'on n'a pas de baseURL, utiliser ANIME_SAMA_URL
    absoluteUrl = ANIME_SAMA_URL + (urlStr.startsWith('/') ? urlStr.substring(1) : urlStr);
  }

  // Headers pour les requêtes Anime-Sama via proxy
  const animeSamaHeaders = {
    'Accept-Language': 'fr-FR,fr;q=0.6',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Priority': 'u=0, i',
    'Sec-CH-UA': '"Chromium";v="142", "Brave";v="142", "Not_A Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Sec-GPC': '1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  };

  // Supprimer les headers liés à l'IP d'origine pour éviter de les transmettre
  const headersToRemove = ['X-Forwarded-For', 'X-Real-IP', 'X-Client-IP', 'CF-Connecting-IP', 'True-Client-IP', 'X-Original-Forwarded-For'];
  const cleanHeaders = { ...animeSamaHeaders };

  // Si config.headers existe, le nettoyer aussi
  if (config.headers) {
    const configHeaders = { ...config.headers };
    headersToRemove.forEach(header => {
      delete configHeaders[header];
      delete configHeaders[header.toLowerCase()];
    });
    Object.assign(cleanHeaders, configHeaders);
  }

  // Choisir un proxy SOCKS5h aléatoire
  const socks5Proxy = pickRandomProxyOrNone();
  const proxyAgent = socks5Proxy ? getProxyAgent(socks5Proxy) : null;

  let lastError = null;

  // Essayer chaque proxy Cloudflare jusqu'à ce qu'un fonctionne
  for (let i = 0; i < availableProxies.length; i++) {
    const cloudflareProxy = availableProxies[i];
    const proxiedUrl = `${cloudflareProxy}${absoluteUrl}`;

    try {
      const response = await axiosAnimeSama({
        ...config,
        url: proxiedUrl,
        headers: cleanHeaders,
        timeout: 30000,
        decompress: true,
        ...(proxyAgent ? { httpAgent: proxyAgent, httpsAgent: proxyAgent, proxy: false } : {})
      });

      // Succès : marquer le proxy comme sain
      markProxyAsHealthy(cloudflareProxy);
      return response;
    } catch (error) {
      lastError = error;
      const statusCode = error.response?.status;
      const errorCode = statusCode || error.code || 'unknown';

      // En cas d'erreur 429 (Too Many Requests), marquer le proxy et essayer le suivant
      if (statusCode === 429) {
        markProxyAsErrored(cloudflareProxy, 429);
        continue;
      }

      // En cas d'erreur 5xx, marquer le proxy et essayer le suivant
      if (statusCode >= 500 && statusCode < 600) {
        markProxyAsErrored(cloudflareProxy, statusCode);
        continue;
      }

      // En cas de timeout, marquer le proxy et essayer le suivant
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        markProxyAsErrored(cloudflareProxy, errorCode);
        continue;
      }

      // Pour les autres erreurs, throw immédiatement sans essayer d'autres proxies
      throw error;
    }
  }

  // Si on arrive ici, tous les proxies ont échoué
  if (lastError) {
    throw lastError;
  }

  // Fallback si aucune erreur n'a été capturée (ne devrait jamais arriver)
  throw new Error('Erreur inconnue lors de la requête Anime Sama');
}


// === UTILITY: Fusion des streaming_links par langue ===
function mergeStreamingLinks(oldLinks, newLinks) {
  // oldLinks et newLinks sont des tableaux d'objets { language, players }
  const merged = {};

  // D'abord, copier les anciens liens
  (oldLinks || []).forEach(l => {
    merged[l.language] = Array.isArray(l.players) ? [...l.players] : [];
  });

  // Ensuite, remplacer par les nouveaux liens si disponibles
  (newLinks || []).forEach(l => {
    if (l.players && l.players.length > 0) {
      // Si on a de nouveaux lecteurs, on remplace complètement les anciens
      merged[l.language] = Array.isArray(l.players) ? [...l.players] : [];
    }
  });

  // Retourne sous forme d'array d'objets
  return Object.entries(merged).map(([language, players]) => ({ language, players }));
}

// === UTILITY: Migration des anciens fichiers de cache séparés vers le cache unifié ===
async function migrateOldCacheFiles(safeAnimeName, animeCacheDir) {
  try {
    const allCacheFiles = await fsp.readdir(animeCacheDir).catch(() => []);
    const oldSeasonFiles = allCacheFiles.filter(f => f.startsWith(safeAnimeName + '_') && f.endsWith('.json'));

    if (oldSeasonFiles.length === 0) return;


    const migratedSeasons = {};

    for (const seasonFile of oldSeasonFiles) {
      try {
        const seasonContent = await fsp.readFile(path.join(animeCacheDir, seasonFile), 'utf-8');
        const seasonCache = JSON.parse(seasonContent);
        const seasonName = seasonFile.replace(safeAnimeName + '_', '').replace('.json', '');

        migratedSeasons[seasonName] = {
          timestamp: seasonCache.timestamp || Date.now(),
          episodes: seasonCache.episodes || []
        };
      } catch (e) {
      }
    }

    if (Object.keys(migratedSeasons).length > 0) {
      const unifiedCacheData = {
        timestamp: Date.now(),
        seasons: migratedSeasons
      };

      const animeCachePath = path.join(animeCacheDir, `${safeAnimeName}.json`);
      await writeFileAtomic(animeCachePath, JSON.stringify(unifiedCacheData), 'utf-8');

      // Nettoyer les anciens fichiers après migration réussie
      await cleanupOldCacheFiles(safeAnimeName, animeCacheDir);
    }
  } catch (e) {
  }
}

// === UTILITY: Nettoyage des anciens fichiers de cache séparés ===
async function cleanupOldCacheFiles(safeAnimeName, animeCacheDir) {
  try {
    const allCacheFiles = await fsp.readdir(animeCacheDir).catch(() => []);
    const oldSeasonFiles = allCacheFiles.filter(f => f.startsWith(safeAnimeName + '_') && f.endsWith('.json'));

    for (const oldFile of oldSeasonFiles) {
      try {
        await fsp.unlink(path.join(animeCacheDir, oldFile));
      } catch (e) {
      }
    }
  } catch (e) {
  }
}

// Fonction pour supprimer les lecteurs fsvid des réponses FStream
function removeFsvidPlayers(data, isVip = false) {
  // Log de débogage

  // Si pas de données, retourner tel quel
  if (!data) {
    return data;
  }

  // Si l'utilisateur est VIP, ne pas filtrer les lecteurs fsvid
  if (isVip) {
    return data;
  }

  // Par défaut, toujours filtrer les lecteurs fsvid (même si remove_fsvid est false)

  // Pour les films : filtrer players.organized
  if (data.players && typeof data.players === 'object') {
    const filteredPlayers = {};
    let totalPlayers = 0;

    Object.keys(data.players).forEach(playerType => {
      if (Array.isArray(data.players[playerType])) {
        // Filtrer les lecteurs dont l'URL contient "fsvid"
        const filteredPlayerList = data.players[playerType].filter(player => {
          return !player.url || !player.url.includes('fsvid');
        });

        if (filteredPlayerList.length > 0) {
          filteredPlayers[playerType] = filteredPlayerList;
          totalPlayers += filteredPlayerList.length;
        }
      } else {
        // Si ce n'est pas un array, garder tel quel
        filteredPlayers[playerType] = data.players[playerType];
      }
    });

    return {
      ...data,
      players: filteredPlayers,
      total: totalPlayers,
      metadata: {
        ...data.metadata,
        fsvidFiltered: true
      }
    };
  }

  // Pour les séries : filtrer episodes
  if (data.episodes && typeof data.episodes === 'object') {
    const filteredEpisodes = {};
    let totalPlayers = 0;

    Object.keys(data.episodes).forEach(episodeKey => {
      const episode = data.episodes[episodeKey];
      if (episode && typeof episode === 'object') {
        const filteredEpisode = { ...episode };

        // Vérifier si l'épisode a une structure "languages"
        if (episode.languages && typeof episode.languages === 'object') {
          const filteredLanguages = {};

          Object.keys(episode.languages).forEach(languageKey => {
            const languagePlayers = episode.languages[languageKey];

            if (Array.isArray(languagePlayers)) {
              // Filtrer les lecteurs dont l'URL contient "fsvid"
              const filteredPlayerList = languagePlayers.filter(player => {
                return !player.url || !player.url.includes('fsvid');
              });

              if (filteredPlayerList.length > 0) {
                filteredLanguages[languageKey] = filteredPlayerList;
                totalPlayers += filteredPlayerList.length;
              }
            } else {
              // Si ce n'est pas un array, garder tel quel
              filteredLanguages[languageKey] = languagePlayers;
            }
          });

          filteredEpisode.languages = filteredLanguages;
        } else {
          // Structure ancienne sans "languages" - filtrer directement
          Object.keys(episode).forEach(playerType => {
            if (Array.isArray(episode[playerType])) {
              // Filtrer les lecteurs dont l'URL contient "fsvid"
              const filteredPlayerList = episode[playerType].filter(player => {
                return !player.url || !player.url.includes('fsvid');
              });

              if (filteredPlayerList.length > 0) {
                filteredEpisode[playerType] = filteredPlayerList;
                totalPlayers += filteredPlayerList.length;
              }
            }
          });
        }

        // Garder l'épisode seulement s'il a encore des lecteurs
        if (episode.languages ? Object.keys(filteredEpisode.languages).length > 0 : Object.keys(filteredEpisode).some(key => Array.isArray(filteredEpisode[key]) && filteredEpisode[key].length > 0)) {
          filteredEpisodes[episodeKey] = filteredEpisode;
        }
      }
    });

    return {
      ...data,
      episodes: filteredEpisodes,
      total: totalPlayers,
      metadata: {
        ...data.metadata,
        fsvidFiltered: true
      }
    };
  }

  return data;
}

/* === ROUTE FSTREAM === */

const FSTREAM_BASE_URL = 'https://french-stream.one/';
const FSTREAM_SEARCH_URL = `${FSTREAM_BASE_URL}/engine/ajax/search.php`;

// Configuration des cookies FStream (PHPSESSID sera récupéré dynamiquement via login)
const fstreamCookies = {
  'PHPSESSID': '',
  'dle_user_id': '',
  'dle_password': '',
  'dle_skin': 'VFV25',
  'dle_newpm': '0',
  '__cf_logged_in': '1',
  'CF_VERIFIED_DEVICE_ae9bb95a6761c08a92f916b7ed7d2c4a985eb220591d1410240412c516f37b0c': '1756239054'
};

// Compteur de requêtes pour le système de session FStream (1 login pour 5 requêtes)
let fstreamRequestCounter = 0;
const MAX_REQUESTS_PER_SESSION = 5;

// Configuration axios pour FStream
const axiosFStream = axios.create({
  baseURL: FSTREAM_BASE_URL,
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

// === Authentification FStream (login pour récupérer le PHPSESSID) ===
const FSTREAM_LOGIN_NAME = 'Waltortue1234';
const FSTREAM_LOGIN_PASSWORD = 'Grenoble38@';

let fstreamLoginPromise = null;

function extractCookieValue(cookies, name) {
  if (!cookies || !Array.isArray(cookies)) return null;
  const target = cookies.find(c => typeof c === 'string' && c.startsWith(`${name}=`));
  if (!target) return null;
  const semi = target.indexOf(';');
  const pair = semi !== -1 ? target.slice(0, semi) : target;
  const idx = pair.indexOf('=');
  return idx !== -1 ? pair.slice(idx + 1) : null;
}

async function loginToFStream() {
  // Empêcher les connexions concurrentes
  if (fstreamLoginPromise) return fstreamLoginPromise;
  fstreamLoginPromise = (async () => {
    try {
      const formData = new URLSearchParams();
      formData.append('login_name', FSTREAM_LOGIN_NAME);
      formData.append('login_password', FSTREAM_LOGIN_PASSWORD);
      formData.append('login', 'submit');

      const response = await axiosFStream({
        method: 'post',
        url: '/',
        data: formData,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': FSTREAM_BASE_URL,
          'Referer': FSTREAM_BASE_URL
        },
        // Important: pas de proxy ni d'entêtes Cookie pour le login initial
        proxy: false
      });

      const setCookie = response.headers && (response.headers['set-cookie'] || response.headers['Set-Cookie']);
      const phpsessid = extractCookieValue(setCookie, 'PHPSESSID');
      const dleUserId = extractCookieValue(setCookie, 'dle_user_id');
      const dlePassword = extractCookieValue(setCookie, 'dle_password');
      const dleNewpm = extractCookieValue(setCookie, 'dle_newpm');

      if (phpsessid) {
        fstreamCookies['PHPSESSID'] = phpsessid;
      } else {
        throw new Error('PHPSESSID non présent dans set-cookie');
      }
      if (dleUserId) fstreamCookies['dle_user_id'] = dleUserId;
      if (dlePassword) fstreamCookies['dle_password'] = dlePassword;
      if (dleNewpm) fstreamCookies['dle_newpm'] = dleNewpm;
      console.log('[FSTREAM LOGIN] ✅ Connexion réussie, cookies récupérés');

      // Changer le skin vers VFV25 via POST (nécessaire pour obtenir le bon HTML)
      try {
        const skinCookieHeader = Object.entries(fstreamCookies)
          .filter(([, v]) => v !== '' && v != null)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

        const skinFormData = new URLSearchParams();
        skinFormData.append('skin_name', 'VFV25');
        skinFormData.append('action_skin_change', 'yes');

        await axiosFStream({
          method: 'post',
          url: '/',
          data: skinFormData,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': FSTREAM_BASE_URL,
            'Referer': FSTREAM_BASE_URL + '/',
            'Cookie': skinCookieHeader
          },
          proxy: false
        });

        fstreamCookies['dle_skin'] = 'VFV25';
        console.log('[FSTREAM LOGIN] ✅ Skin changé vers VFV25');
      } catch (skinError) {
        console.warn('[FSTREAM LOGIN] ⚠️ Erreur changement de skin:', skinError.message);
      }

      return true;
    } finally {
      // Réinitialiser la promesse pour permettre de relancer en cas d'erreur future
      fstreamLoginPromise = null;
    }
  })();
  return fstreamLoginPromise;
}

async function ensureFStreamSession() {
  // Vérifier si on a besoin d'un nouveau login (pas de PHPSESSID ou compteur dépassé)
  if (!fstreamCookies['PHPSESSID'] || fstreamRequestCounter >= MAX_REQUESTS_PER_SESSION) {
    await loginToFStream();
    // Réinitialiser le compteur après un nouveau login
    fstreamRequestCounter = 0;
  }
}

// Fonction pour récupérer les détails TMDB
async function getFStreamTMDBDetails(id, type) {
  try {
    // Exécuter les requêtes en parallèle pour réduire la latence
    const [response, noLangResponse] = await Promise.all([
      axios.get(`${TMDB_API_URL}/${type}/${id}`, {
        params: {
          api_key: TMDB_API_KEY,
          language: "fr-FR"
        }
      }).catch(err => {
        console.error(`Erreur TMDB main (fr-FR) pour ${id}:`, err.message);
        return null;
      }),

      axios.get(`${TMDB_API_URL}/${type}/${id}`, {
        params: {
          api_key: TMDB_API_KEY
        }
      }).catch(err => {
        // console.log(`Impossible de récupérer les données sans langue pour ${id}`);
        return null;
      })
    ]);

    if (!response || !response.data) {
      return null;
    }

    // Le 3ème appel était redondant (c'était exactement le même que le premier) -> Supprimé

    return {
      id: response.data.id,
      title: type === 'movie' ? response.data.title : response.data.name,
      original_title: type === 'movie' ? response.data.original_title : response.data.original_name,
      name_no_lang: noLangResponse?.data ? (type === 'movie' ? noLangResponse.data.title : noLangResponse.data.name) : null,
      release_date: type === 'movie' ? response.data.release_date : response.data.first_air_date,
      overview: response.data.overview // On a déjà récupéré la version FR dans response
    };
  } catch (error) {
    console.error(`Erreur lors de la récupération des détails TMDB pour ${id} (${type}):`, error);
    return null;
  }
}

// Fonction pour rechercher sur FStream
async function searchFStream(query, page = 1) {
  try {
    const formData = new URLSearchParams();
    formData.append('query', query);
    formData.append('page', page.toString());

    const response = await axiosFStreamRequest({
      method: 'post',
      url: FSTREAM_SEARCH_URL,
      data: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (response.status !== 200) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    return response.data;
  } catch (error) {
    // Gérer les erreurs spécifiques qui ne doivent pas être mises en cache
    if (error.response) {
      const status = error.response.status;
      if (status === 429 || status === 403 || status === 503 || status === 502) {
        // Relancer l'erreur pour qu'elle soit gérée par le cache
        throw error;
      }
    }

    console.error(`Erreur lors de la recherche FStream: ${error.message}`);
    throw error;
  }
}

// Fonction pour scraper les films récents depuis la page FStream
async function scrapeFStreamRecentMovies() {
  try {
    const response = await axiosFStreamRequest({
      method: 'get',
      url: 'https://french-stream.one/films/',
      timeout: 10000
    });

    if (response.status !== 200) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    if (!response.data || typeof response.data !== 'string') {
      throw new Error('La réponse n\'est pas du HTML valide');
    }

    const $ = cheerio.load(response.data);
    const movies = [];

    // Sélecteur précis pour les films dans l'élément dle-content
    // Sur la page /films/, tous les .short dans #dle-content sont des films
    const dleContent = $('#dle-content');
    let filmElements;

    if (dleContent.length > 0) {
      // Essayer d'abord .short.film (classes séparées)
      filmElements = dleContent.find('.short.film');

      // Si rien trouvé, essayer div.short.film
      if (filmElements.length === 0) {
        filmElements = dleContent.find('div.short.film');
      }

      // Si toujours rien, essayer avec attribut class contenant "short" et "film"
      if (filmElements.length === 0) {
        filmElements = dleContent.find('div[class*="short"][class*="film"]');
      }

      // Si toujours rien, utiliser tous les .short (sur /films/, ce sont tous des films)
      if (filmElements.length === 0) {
        const shortInDle = dleContent.find('.short');
        if (shortInDle.length > 0) {
          filmElements = shortInDle;
        }
      }
    } else {
      // Fallback: chercher directement dans tout le document
      filmElements = $('.short.film');

      if (filmElements.length === 0) {
        filmElements = $('div.short.film');
      }

      if (filmElements.length === 0) {
        filmElements = $('div[class*="short"][class*="film"]');
      }

      if (filmElements.length === 0) {
        const allShorts = $('.short');
        if (allShorts.length > 0) {
          filmElements = allShorts;
        }
      }
    }

    filmElements.each((index, element) => {
      try {
        const $el = $(element);

        // Extraire le titre depuis .short-title
        const titleElement = $el.find('.short-title');
        if (titleElement.length === 0) return;

        const title = titleElement.text().trim();
        if (!title) return;

        // Extraire le lien depuis a.short-poster
        const linkElement = $el.find('a.short-poster');
        if (linkElement.length === 0) return;

        const href = linkElement.attr('href');
        if (!href) return;

        // Construire l'URL complète
        const fullLink = href.startsWith('http')
          ? href
          : href.startsWith('/')
            ? `https://french-stream.one${href}`
            : `https://french-stream.one/${href}`;

        // Extraire l'ID du film depuis le lien (ex: /films/15123288-good-fortune.html -> 15123288)
        let movieId = null;
        const idMatch = href.match(/(\d+)/);
        if (idMatch) {
          movieId = idMatch[1];
        }

        // Extraire le trailer ID si disponible (dans span#trailer-{id})
        // Les IDs sont uniques dans le document, donc on peut chercher directement
        let trailerId = null;
        if (movieId) {
          // Chercher d'abord dans l'élément et ses descendants
          let trailerElement = $el.find(`span#trailer-${movieId}`);
          // Si non trouvé, chercher dans tout le document (les IDs sont uniques)
          if (trailerElement.length === 0) {
            trailerElement = $(`span#trailer-${movieId}`);
          }
          if (trailerElement.length > 0) {
            trailerId = trailerElement.text().trim();
          }
        }

        // Extraire la description si disponible (dans span#desc-{id})
        let description = null;
        if (movieId) {
          // Chercher d'abord dans l'élément et ses descendants
          let descElement = $el.find(`span#desc-${movieId}`);
          // Si non trouvé, chercher dans tout le document (les IDs sont uniques)
          if (descElement.length === 0) {
            descElement = $(`span#desc-${movieId}`);
          }
          if (descElement.length > 0) {
            description = descElement.text().trim();
          }
        }

        // Extraire la qualité et version
        const quality = $el.find('.film-quality a').text().trim() || null;
        const version = $el.find('.film-version a').text().trim() || null;

        // Extraire l'image pour obtenir l'URL du poster
        const imgElement = $el.find('img');
        let posterUrl = null;
        if (imgElement.length > 0) {
          posterUrl = imgElement.attr('src');
          if (posterUrl && !posterUrl.startsWith('http')) {
            posterUrl = posterUrl.startsWith('/')
              ? `https://french-stream.one${posterUrl}`
              : `https://french-stream.one/${posterUrl}`;
          }
        }

        // Extraire la note si disponible
        const ratingElement = $el.find('.vote-score');
        let rating = null;
        if (ratingElement.length > 0) {
          const ratingText = ratingElement.text().trim();
          const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
          if (ratingMatch) {
            rating = parseFloat(ratingMatch[1]);
          }
        }

        movies.push({
          title: title,
          link: fullLink,
          id: movieId,
          trailerId: trailerId,
          description: description,
          quality: quality,
          version: version,
          posterUrl: posterUrl,
          rating: rating,
          source: 'fstream_recent'
        });

      } catch (error) {
        console.error(`[FSTREAM RECENT] Erreur lors du parsing d'un film: ${error.message}`);
      }
    });

    return movies;

  } catch (error) {
    console.error(`[FSTREAM RECENT] Erreur lors du scraping: ${error.message}`);
    return [];
  }
}

// Fonction pour scraper les séries récentes depuis la page FStream
async function scrapeFStreamRecentSeries() {
  try {
    const response = await axiosFStreamRequest({
      method: 'get',
      url: 'https://french-stream.one/s-tv/',
      timeout: 10000
    });

    if (response.status !== 200) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    const $ = cheerio.load(response.data);
    const series = [];

    // Sélecteur pour les séries dans l'élément dle-content
    const seriesElements = $('#dle-content .short.serie');

    seriesElements.each((index, element) => {
      try {
        const $el = $(element);

        // Extraire le titre
        const titleElement = $el.find('.short-title');
        if (titleElement.length === 0) return;

        const title = titleElement.text().trim();
        if (!title) return;

        // Extraire le lien
        const linkElement = $el.find('a.short-poster');
        if (linkElement.length === 0) return;

        const href = linkElement.attr('href');
        if (!href) return;

        const fullLink = href.startsWith('http') ? href : `https://french-stream.one${href}`;

        // Extraire l'ID de la série depuis le lien
        let seriesId = null;
        const idMatch = href.match(/(\d+)/);
        if (idMatch) {
          seriesId = idMatch[1];
        }

        // Extraire l'image pour obtenir l'ID TMDB si possible
        const imgElement = $el.find('img');
        let tmdbId = null;
        if (imgElement.length > 0) {
          const imgSrc = imgElement.attr('src');
          if (imgSrc && imgSrc.includes('tmdb.org')) {
            const tmdbMatch = imgSrc.match(/\/t\/p\/w\d+\/([^\/]+)\.jpg/);
            if (tmdbMatch) {
              // L'ID TMDB est dans le nom du fichier, mais on ne peut pas l'extraire directement
              // On garde juste l'info qu'il y a une image TMDB
            }
          }
        }

        series.push({
          title: title,
          link: fullLink,
          id: seriesId,
          tmdbId: tmdbId,
          source: 'fstream_recent_series'
        });

      } catch (error) {
        console.error(`[FSTREAM RECENT SERIES] Erreur lors du parsing d'une série: ${error.message}`);
      }
    });

    return series;

  } catch (error) {
    console.error(`[FSTREAM RECENT SERIES] Erreur lors du scraping: ${error.message}`);
    return [];
  }
}

// Fonction pour rechercher un film dans les films récents
async function findMovieInRecentFStream(tmdbTitle, tmdbYear) {
  try {
    const recentMovies = await scrapeFStreamRecentMovies();

    if (recentMovies.length === 0) {
      return null;
    }

    // Fonction pour extraire et retirer l'année d'un titre
    const extractYear = (title) => {
      const yearMatch = title.match(/\((\d{4})\)/);
      return yearMatch ? yearMatch[1] : null;
    };

    const removeYear = (title) => {
      return title.replace(/\s*\((\d{4})\)\s*$/, '').trim();
    };

    // Normaliser le titre pour la comparaison (sans l'année)
    const normalizeTitle = (str) => {
      if (!str) return '';
      // Retirer l'année avant normalisation
      let cleaned = removeYear(str);
      return cleaned
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    // Extraire l'année du titre TMDB si elle n'est pas fournie
    let yearToMatch = tmdbYear;
    if (!yearToMatch) {
      yearToMatch = extractYear(tmdbTitle);
    }

    // Titre TMDB sans l'année
    const tmdbTitleWithoutYear = removeYear(tmdbTitle);
    const normalizedTmdbTitle = normalizeTitle(tmdbTitleWithoutYear);

    let bestMatch = null;
    let bestSimilarity = 0;

    // Chercher une correspondance exacte ou très proche
    for (const movie of recentMovies) {
      const normalizedMovieTitle = normalizeTitle(movie.title);

      // Correspondance exacte (sans année)
      if (normalizedMovieTitle === normalizedTmdbTitle) {
        return movie;
      }

      // Utiliser calculateTitleSimilarity pour une comparaison plus intelligente
      const similarity = calculateTitleSimilarity(normalizedTmdbTitle, normalizedMovieTitle);

      // Si la similarité est élevée, garder le meilleur match
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = movie;
      }
    }

    // Si on a un bon match (seuil réduit à 0.7 pour être plus permissif)
    if (bestMatch && bestSimilarity >= 0.7) {
      return bestMatch;
    }

    // Si pas de match mais qu'on a un titre très similaire, essayer quand même
    // (cas où le titre est presque identique mais avec une petite différence)
    if (bestMatch && bestSimilarity >= 0.6 && normalizedTmdbTitle.length > 3) {
      // Vérifier si le titre recherché contient le titre trouvé ou vice versa
      const tmdbWords = normalizedTmdbTitle.split(/\s+/).filter(w => w.length > 2);
      const movieWords = normalizeTitle(bestMatch.title).split(/\s+/).filter(w => w.length > 2);

      // Si tous les mots significatifs du titre TMDB sont dans le titre FStream ou vice versa
      const allWordsMatch = tmdbWords.length > 0 && (
        tmdbWords.every(word => movieWords.some(mw => mw.includes(word) || word.includes(mw))) ||
        movieWords.every(word => tmdbWords.some(tw => tw.includes(word) || word.includes(tw)))
      );

      if (allWordsMatch) {
        return bestMatch;
      }
    }

    return null;

  } catch (error) {
    console.error(`[FSTREAM RECENT] Erreur lors de la recherche: ${error.message}`);
    return null;
  }
}

// Fonction pour rechercher une série dans les séries récentes
async function findSeriesInRecentFStream(tmdbTitle, tmdbYear) {
  try {
    const recentSeries = await scrapeFStreamRecentSeries();

    if (recentSeries.length === 0) {
      return null;
    }

    // Normaliser le titre pour la comparaison
    const normalizeTitle = (str) => (str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const normalizedTmdbTitle = normalizeTitle(tmdbTitle);

    // Chercher une correspondance exacte ou très proche
    for (const series of recentSeries) {
      const normalizedSeriesTitle = normalizeTitle(series.title);

      // Correspondance exacte
      if (normalizedSeriesTitle === normalizedTmdbTitle) {
        return series;
      }

      // Correspondance partielle (au moins 80% de similarité)
      const similarity = calculateTitleSimilarity(normalizedTmdbTitle, normalizedSeriesTitle);
      if (similarity > 0.8) {
        return series;
      }
    }

    return null;

  } catch (error) {
    console.error(`[FSTREAM RECENT SERIES] Erreur lors de la recherche: ${error.message}`);
    return null;
  }
}

// Fonction pour rechercher sur FStream AVEC proxy (pour éviter les rate limits)
async function searchFStreamDirect(query, page = 1) {
  try {
    const formData = new URLSearchParams();
    formData.append('query', query);
    formData.append('page', page.toString());

    const response = await axiosFStreamRequest({
      method: 'post',
      url: FSTREAM_SEARCH_URL,
      data: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    if (response.status !== 200) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }

    return response.data;
  } catch (error) {
    // Gérer les erreurs spécifiques qui ne doivent pas être mises en cache
    if (error.response) {
      const status = error.response.status;
      if (status === 429 || status === 403 || status === 503 || status === 502) {
        // Relancer l'erreur pour qu'elle soit gérée par le cache
        throw error;
      }
    }

    throw error;
  }
}

async function fetchFStreamSeasonSearchResults(tmdbId, serieTitle) {
  try {
    const formData = new URLSearchParams();
    formData.append('serie_tag', `s-${tmdbId}`);

    const response = await axiosFStreamRequest({
      method: 'post',
      url: `${FSTREAM_BASE_URL}/engine/ajax/get_seasons.php`,
      data: formData,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 6000
    });

    let seasonsData = response.data;
    if (typeof seasonsData === 'string') {
      const trimmed = seasonsData.trim();
      if (!trimmed) {
        return [];
      }
      try {
        seasonsData = JSON.parse(trimmed);
      } catch (parseError) {
        console.error(`[FSTREAM TV] Impossible de parser les saisons pour ${tmdbId}: ${parseError.message}`);
        return [];
      }
    }

    if (!Array.isArray(seasonsData)) {
      return [];
    }

    const normalizedSerieTitle = serieTitle || '';

    return seasonsData
      .map((season) => {
        if (!season) return null;

        const rawTitle = season.title || '';
        const altName = season.alt_name || '';
        const seasonMatch = rawTitle.match(/Saison\s+(\d+)/i) || altName.match(/saison-(\d+)/i);
        if (!seasonMatch) {
          return null;
        }

        const seasonNumber = parseInt(seasonMatch[1], 10);
        if (Number.isNaN(seasonNumber)) {
          return null;
        }

        const rawYear = season.serie_anne;
        const year = rawYear && /^\d{4}$/.test(String(rawYear)) ? parseInt(rawYear, 10) : null;

        const fullUrl = (season.full_url || '').replace(/\\/g, '/');
        if (!fullUrl) {
          return null;
        }
        const normalizedLink = fullUrl.startsWith('http')
          ? fullUrl
          : `${FSTREAM_BASE_URL}${fullUrl.startsWith('/') ? '' : '/'}${fullUrl}`;

        const baseTitle = rawTitle || `Saison ${seasonNumber}`;
        const combinedTitle = normalizedSerieTitle ? `${normalizedSerieTitle} - ${baseTitle}` : baseTitle;

        return {
          title: combinedTitle,
          originalTitle: rawTitle || combinedTitle,
          link: normalizedLink,
          seasonNumber,
          year
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.error(`[FSTREAM TV] Erreur lors de la récupération des saisons pour ${tmdbId}: ${error.message}`);
    return [];
  }
}
// Fonction pour extraire les lecteurs vidéo depuis une page FStream
async function extractFStreamPlayers(htmlContent, isSeries = false) {
  try {
    const $ = cheerio.load(htmlContent);
    let players = [];

    if (isSeries) {
      // Pour les séries, utiliser la nouvelle fonction spécialisée
      return await extractFStreamSeriesPlayers(htmlContent);
    } else {
      // Pour les films

      // Nouvelle méthode: Extraction via #film-data
      const filmData = $('#film-data');
      if (filmData.length > 0) {
        const providers = ['premium', 'vidzy', 'uqload', 'dood', 'voe', 'filmoon', 'netu'];

        providers.forEach(provider => {
          // Vérifier chaque version
          const versions = {
            'vostfr': 'VOSTFR',
            'vff': 'VFF',
            'vfq': 'VFQ',
            '': 'Default'
          };

          Object.entries(versions).forEach(([suffix, label]) => {
            const attr = `data-${provider}${suffix}`;
            const value = filmData.attr(attr);

            if (value && value.trim() !== '') {
              let url = value;
              // Pour netu, la valeur est un ID (pas une URL), construire l'URL embed
              if (provider === 'netu' && !value.startsWith('http')) {
                url = `https://www.fembed.com/v/${value}`;
              }

              if (url.startsWith('http')) {
                players.push({
                  url: url,
                  type: 'embed',
                  quality: 'HD',
                  player: provider,
                  version: label
                });
              }
            }
          });
        });
      }

      // Ancienne méthode: extraire depuis le script JavaScript
      // Ne s'exécute que si on n'a pas encore trouvé de lecteurs (ou pour compléter)
      if (players.length === 0) {
        const scriptContent = $('script').text();

        // Chercher l'objet playerUrls dans le script
        const playerUrlsMatch = scriptContent.match(/var\s+playerUrls\s*=\s*({[\s\S]*?});/);

        if (playerUrlsMatch && playerUrlsMatch[1]) {
          try {
            // Essayer de parser l'objet JavaScript
            const playerUrlsStr = playerUrlsMatch[1];

            // Extraire toutes les versions de tous les lecteurs
            const playerPattern = /"([^"]+)":\s*{([^}]+)}/g;
            let playerMatch;

            while ((playerMatch = playerPattern.exec(playerUrlsStr)) !== null) {
              const playerName = playerMatch[1];
              const versionsStr = playerMatch[2];

              // Extraire toutes les versions pour ce lecteur
              const versionPattern = /"([^"]+)":\s*"([^"]*)"/g;
              let versionMatch;

              while ((versionMatch = versionPattern.exec(versionsStr)) !== null) {
                const version = versionMatch[1];
                const url = versionMatch[2];

                // Ne pas ajouter les URLs vides
                if (url && url.trim() !== '') {
                  players.push({
                    url: url,
                    type: 'embed',
                    quality: 'HD',
                    player: playerName,
                    version: version
                  });
                }
              }
            }

            // Si on n'a pas trouvé avec le pattern complexe, essayer un pattern plus simple
            if (players.length === 0) {
              const urlPattern = /"([^"]+)":\s*"([^"]+)"/g;
              while ((match = urlPattern.exec(playerUrlsStr)) !== null) {
                const key = match[1];
                const url = match[2];

                // Filtrer les clés qui ressemblent à des URLs
                if (url && url.includes('http') && !key.includes('Default') && !key.includes('VFQ') && !key.includes('VFF') && !key.includes('VOSTFR')) {
                  players.push({
                    url: url,
                    type: 'embed',
                    quality: 'HD',
                    player: key
                  });
                }
              }
            }

          } catch (parseError) {
            console.error('Erreur lors du parsing de playerUrls:', parseError.message);
          }
        }

        // Fallback: chercher des URLs directement dans le script
        if (players.length === 0) {
          const urlPattern = /https?:\/\/[^\s"']+/g;
          const urls = scriptContent.match(urlPattern);
          if (urls) {
            urls.forEach(url => {
              if (url.includes('embed') || url.includes('player')) {
                players.push({
                  url: url,
                  type: 'embed',
                  quality: 'HD'
                });
              }
            });
          }
        }
      }

      // Fallback final: chercher des iframes ou liens embed
      if (players.length === 0) {
        $('iframe[src], a[href*="embed"], a[href*="player"]').each((_, element) => {
          const $el = $(element);
          const src = $el.attr('src') || $el.attr('href');
          if (src && !src.includes('episodes-suivant')) {
            players.push({
              url: src.startsWith('http') ? src : `${FSTREAM_BASE_URL}${src}`,
              type: 'embed',
              quality: 'HD'
            });
          }
        });
      }
    }

    // Dédupliquer les URLs et organiser par langue
    const uniquePlayers = [];
    const seenUrls = new Set();

    players.forEach(player => {
      if (!seenUrls.has(player.url)) {
        seenUrls.add(player.url);
        uniquePlayers.push(player);
      }
    });

    // Organiser les lecteurs par langue/version
    const organizedPlayers = {
      VFQ: [],      // Version Française Qualité
      VFF: [],      // Version Française Film
      VOSTFR: [],   // Version Originale Sous-Titrée Français
      Default: []   // Version par défaut
    };

    uniquePlayers.forEach(player => {
      // Si la version est connue et existe dans notre structure, on l'utilise
      // Sinon on met dans Default
      const version = (player.version && organizedPlayers[player.version]) ? player.version : 'Default';

      organizedPlayers[version].push({
        url: player.url,
        type: player.type,
        quality: player.quality,
        player: player.player || 'Lecteur'
      });
    });

    // Retourner la structure organisée
    return {
      organized: organizedPlayers,
      total: uniquePlayers.length
    };
  } catch (error) {
    console.error(`Erreur lors de l'extraction des lecteurs FStream: ${error.message}`);
    // Retourner un objet vide mais structuré pour éviter les erreurs
    return {
      organized: { VFQ: [], VFF: [], VOSTFR: [], Default: [] },
      total: 0
    };
  }
}

// Nouvelle fonction spécialisée pour extraire les lecteurs des séries
async function extractFStreamSeriesPlayers(htmlContent) {
  try {
    const $ = cheerio.load(htmlContent);
    const episodes = {};

    // Extraire la date de sortie depuis le XPath spécifié
    let fstreamReleaseDate = null;

    // Essayer plusieurs sélecteurs pour trouver l'élément de date
    const selectors = [
      'html body div:nth-child(2) div div:nth-child(2) article div:nth-child(2) div:nth-child(1) div:nth-child(1) div:nth-child(1) span:nth-child(2)',
      'span.release',
      'div[class*="release"] span',
      'article div span[class*="release"]',
      'div[class*="info"] span[class*="release"]',
      'div[class*="meta"] span[class*="release"]'
    ];

    for (const selector of selectors) {
      const releaseSpan = $(selector);
      if (releaseSpan.length > 0) {
        const releaseText = releaseSpan.text().trim();

        // Extraire l'année du texte "2023 - " ou similaire
        const yearMatch = releaseText.match(/(\d{4})/);
        if (yearMatch) {
          fstreamReleaseDate = yearMatch[1];
          break;
        }
      }
    }

    // Si aucun sélecteur spécifique ne fonctionne, chercher dans tout le contenu
    if (!fstreamReleaseDate) {
      const allText = $.text();
      const yearMatches = allText.match(/(\d{4})\s*-\s*/g);
      if (yearMatches && yearMatches.length > 0) {
        // Prendre la première année trouvée qui semble être une date de sortie
        const firstYear = yearMatches[0].match(/(\d{4})/)[1];
        if (parseInt(firstYear) >= 1900 && parseInt(firstYear) <= new Date().getFullYear() + 2) {
          fstreamReleaseDate = firstYear;
        }
      }
    }

    // ============ NOUVELLE MÉTHODE (24/12/2025): Parsing via IDs HTML ============
    let foundEpisodesData = false;

    try {
      const versionMap = {
        '#episodes-vf-data': 'VF',
        '#episodes-vostfr-data': 'VOSTFR',
        '#episodes-vo-data': 'VOENG'
      };

      for (const [selector, langKey] of Object.entries(versionMap)) {
        const container = $(selector);
        if (container.length > 0) {
          container.children('div').each((_, element) => {
            const $el = $(element);
            const epNumStr = $el.attr('data-ep');

            if (!epNumStr) return;

            const epNum = parseInt(epNumStr);
            if (isNaN(epNum) || epNum === 0) return;

            // Mappage des attributs aux noms de lecteurs
            const attributes = {
              'data-premium': 'FSvid',
              'data-vidzy': 'Vidzy',
              'data-uqload': 'Uqload',
              'data-netu': 'Netu',
              'data-voe': 'Voe'
            };

            const playersToAdd = [];

            Object.entries(attributes).forEach(([attr, playerName]) => {
              const url = $el.attr(attr);
              if (url && url.startsWith('http')) {
                playersToAdd.push({
                  url: url,
                  type: 'embed',
                  quality: 'HD',
                  player: playerName
                });
              }
            });

            // Si des lecteurs ont été trouvés, on les ajoute
            if (playersToAdd.length > 0) {
              // Initialiser l'épisode si nécessaire
              if (!episodes[epNum]) {
                episodes[epNum] = {
                  number: epNum,
                  title: `Episode ${epNum}`,
                  languages: {
                    VF: [],
                    VOSTFR: [],
                    VOENG: [],
                    Default: []
                  }
                };
              }

              // Ajouter les lecteurs trouvés
              playersToAdd.forEach(player => {
                // Vérifier si le lien existe déjà pour éviter les doublons
                const exists = episodes[epNum].languages[langKey].some(p => p.url === player.url);
                if (!exists) {
                  episodes[epNum].languages[langKey].push(player);
                }
              });
            }
          });

          // Si on a trouvé des épisodes via cette méthodes, on peut considérer qu'on a des données
          if (Object.keys(episodes).length > 0) {
            foundEpisodesData = true;
          }
        }
      }

      if (foundEpisodesData) {
        console.log(`[FStream] ✅ Données trouvées via les IDs HTML (#episodes-*-data) : ${Object.keys(episodes).length} épisodes`);
      }
    } catch (newMethodError) {
      console.error(`[FStream] Erreur nouvelle méthode extraction: ${newMethodError.message}`);
    }

    // ============ ANCIENNE MÉTHODE: Parser episodesData depuis le script (Fallback) ============
    // Chercher le script contenant episodesData
    // (Ne s'exécutera que si foundEpisodesData est false si on ajoute une condition, mais ici on laisse tourner pour compléter potentiellement)

    $('script').each((_, scriptEl) => {
      const scriptContent = $(scriptEl).html() || '';

      // Chercher var episodesData = {...}
      const episodesDataMatch = scriptContent.match(/var\s+episodesData\s*=\s*(\{[\s\S]*?\});(?:\s*var|\s*\n\s*var|\s*\n\s*\n)/);

      if (episodesDataMatch && episodesDataMatch[1]) {
        try {
          // Nettoyer le JSON (remplacer les trailing commas, etc.)
          let jsonStr = episodesDataMatch[1];

          // Parser manuellement car ce n'est pas du JSON valide
          // Extraire VF
          const vfMatch = jsonStr.match(/vf:\s*\{([\s\S]*?)\},\s*(?:vostfr|vo):/);
          const vostfrMatch = jsonStr.match(/vostfr:\s*\{([\s\S]*?)\},\s*vo:/);
          const voMatch = jsonStr.match(/vo:\s*\{([\s\S]*?)\}\s*\}/);

          // Fonction pour parser les épisodes d'une langue
          const parseLanguageEpisodes = (langContent, langKey) => {
            if (!langContent) return;

            // Extraire chaque épisode: numéro: {player1:"url1", player2:"url2"}
            const episodePattern = /(\d+):\s*\{([^}]+)\}/g;
            let epMatch;

            while ((epMatch = episodePattern.exec(langContent)) !== null) {
              const epNum = parseInt(epMatch[1]);
              const playersContent = epMatch[2];

              // Créer l'entrée d'épisode si elle n'existe pas
              if (!episodes[epNum]) {
                episodes[epNum] = {
                  number: epNum,
                  title: `Episode ${epNum}`,
                  languages: {
                    VF: [],
                    VOSTFR: [],
                    VOENG: [],
                    Default: []
                  }
                };
              }

              // Extraire chaque player: nom:"url"
              const playerPattern = /(\w+):"([^"]+)"/g;
              let playerMatch;

              while ((playerMatch = playerPattern.exec(playersContent)) !== null) {
                const playerName = playerMatch[1];
                const playerUrl = playerMatch[2];

                // Ignorer les URLs invalides
                if (!playerUrl || playerUrl.includes('&#91;') || playerUrl.includes('xfvalue_')) {
                  continue;
                }

                // Déterminer le nom du player pour l'affichage
                let displayName = playerName.toUpperCase();
                if (playerName === 'vidzy') displayName = 'Vidzy';
                else if (playerName === 'uqload') displayName = 'Uqload';
                else if (playerName === 'netu') displayName = 'Netu';
                else if (playerName === 'voe') displayName = 'Voe';
                else if (playerName === 'premium') displayName = 'Premium';

                const player = {
                  url: playerUrl,
                  type: 'embed',
                  quality: 'HD',
                  player: displayName
                };

                // Ajouter au bon langKey
                const targetLang = langKey === 'vo' ? 'VOENG' : (langKey === 'vostfr' ? 'VOSTFR' : 'VF');

                // Éviter les doublons
                const exists = episodes[epNum].languages[targetLang].some(p => p.url === playerUrl);
                if (!exists) {
                  episodes[epNum].languages[targetLang].push(player);
                }
              }
            }
          };

          // Parser chaque langue
          if (vfMatch && vfMatch[1]) {
            parseLanguageEpisodes(vfMatch[1], 'vf');
          }
          if (vostfrMatch && vostfrMatch[1]) {
            parseLanguageEpisodes(vostfrMatch[1], 'vostfr');
          }
          if (voMatch && voMatch[1]) {
            parseLanguageEpisodes(voMatch[1], 'vo');
          }

          foundEpisodesData = Object.keys(episodes).length > 0;
          if (foundEpisodesData) {
            console.log(`[FStream] ✅ Parsed episodesData: ${Object.keys(episodes).length} episodes found`);
          }

        } catch (parseError) {
          console.error('[FStream] Erreur parsing episodesData:', parseError.message);
        }
      }
    });

    // ============ MÉTHODE LEGACY: Chercher dans le HTML si episodesData non trouvé ============
    if (!foundEpisodesData) {
      console.log('[FStream] episodesData non trouvé, utilisation de la méthode legacy...');

      // Chercher tous les divs fullsfeature (épisodes) - inclure tous les IDs, pas seulement "episode"
      $('div.fullsfeature').each((_, element) => {
        const $episode = $(element);
        const episodeId = $episode.attr('id');

        // Extraire le titre de l'épisode
        const titleSpan = $episode.find('.selink span').first();
        const episodeTitle = titleSpan.text().trim();

        // Vérifier que c'est un vrai épisode avec un titre valide
        if (!episodeTitle || episodeTitle.trim() === '') {
          return;
        }

        // Déterminer la langue/version basée sur le titre
        let language = 'Default';
        if (episodeTitle.toLowerCase().includes('vostfr')) {
          language = 'VOSTFR';
        } else if (episodeTitle.toLowerCase().includes('vf')) {
          language = 'VFF';
        }

        // Extraire le numéro d'épisode
        const episodeMatch = episodeTitle.match(/épisode\s+(\d+)/i);
        const episodeNumber = episodeMatch ? parseInt(episodeMatch[1]) : 1;

        // Extraire les lecteurs de cet épisode
        const episodePlayers = [];
        $episode.find('ul.btnss a.fsctab').each((_, linkElement) => {
          const $link = $(linkElement);
          const href = $link.attr('href');
          const playerName = $link.text().trim();

          if (href && href.startsWith('http') && !href.includes('episodes-suivant')) {
            episodePlayers.push({
              url: href,
              type: 'embed',
              quality: 'HD',
              player: playerName
            });
          }
        });

        // Ajouter l'épisode à la structure seulement s'il a des lecteurs
        if (episodePlayers.length > 0) {
          if (!episodes[episodeNumber]) {
            episodes[episodeNumber] = {
              number: episodeNumber,
              title: episodeTitle,
              languages: {
                VF: [],
                VOSTFR: [],
                VOENG: [],
                Default: []
              }
            };
          }

          // Ajouter les lecteurs à la langue appropriée
          const langKey = language === 'VOSTFR' ? 'VOSTFR' : 'VF';
          episodes[episodeNumber].languages[langKey] = episodePlayers;
        }
      });

      // Chercher aussi les épisodes VOENG dans div.elink
      $('div.elink a.fstab').each((_, linkElement) => {
        const $link = $(linkElement);
        const href = $link.attr('href');
        const linkText = $link.text().trim();
        const dataEpisodeId = $link.attr('data-episode-id');

        // Vérifier que c'est un lien valide
        if (!href || !href.startsWith('http') || linkText.trim() === '') {
          return;
        }

        // Extraire le numéro d'épisode du texte
        const episodeMatch = linkText.match(/episode\s+(\d+)/i);
        if (!episodeMatch) {
          return;
        }

        const episodeNumber = parseInt(episodeMatch[1]);

        // Déterminer la langue/version
        let language = 'Default';
        const lowerText = linkText.toLowerCase();
        if (lowerText.includes('vosteng') || lowerText.includes('voeng')) {
          language = 'VOENG';
        } else if (lowerText.includes('vostfr')) {
          language = 'VOSTFR';
        } else if (lowerText.includes('vf')) {
          language = 'VFF';
        }

        // Déterminer le nom du player depuis l'URL
        let playerName = 'Unknown';
        if (href.includes('fsvid.lol')) {
          playerName = 'FSvid';
        } else if (href.includes('vidzy.org')) {
          playerName = 'Vidzy';
        } else if (href.includes('uqload')) {
          playerName = 'Uqload';
        } else if (href.includes('voe.sx')) {
          playerName = 'Voe';
        }

        // Créer l'objet player
        const player = {
          url: href,
          type: 'embed',
          quality: 'HD',
          player: playerName
        };

        // Ajouter l'épisode à la structure
        if (!episodes[episodeNumber]) {
          episodes[episodeNumber] = {
            number: episodeNumber,
            title: linkText,
            languages: {
              VF: [],
              VOSTFR: [],
              VOENG: [],
              Default: []
            }
          };
        }

        // Ajouter le lecteur à la langue appropriée
        const langKey = language === 'VOENG' ? 'VOENG' : (language === 'VOSTFR' ? 'VOSTFR' : 'VF');

        // Vérifier que le player n'existe pas déjà (éviter les doublons)
        const existingPlayer = episodes[episodeNumber].languages[langKey].find(p => p.url === href);
        if (!existingPlayer) {
          episodes[episodeNumber].languages[langKey].push(player);
        }
      });
    }

    // Organiser par langue pour la compatibilité avec l'API
    const organizedPlayers = {
      VF: [],
      VOSTFR: [],
      VOENG: [],
      Default: []
    };

    // Compter le total de lecteurs
    let totalPlayers = 0;

    // Organiser les lecteurs par langue
    Object.values(episodes).forEach(episode => {
      Object.entries(episode.languages).forEach(([lang, players]) => {
        if (players.length > 0) {
          organizedPlayers[lang].push(...players);
          totalPlayers += players.length;
        }
      });
    });

    // Retourner la structure organisée
    return {
      organized: organizedPlayers,
      episodes: episodes,
      total: totalPlayers,
      fstreamReleaseDate: fstreamReleaseDate
    };
  } catch (error) {
    console.error(`Erreur lors de l'extraction des lecteurs série FStream: ${error.message}`);
    // Retourner un objet vide mais structuré pour éviter les erreurs
    return {
      organized: { VF: [], VOSTFR: [], VOENG: [], Default: [] },
      episodes: {},
      total: 0,
      fstreamReleaseDate: null
    };
  }
}
// Fonction pour filtrer les résultats de recherche FStream
function filterFStreamResults(results, originalTitle, releaseYear) {
  try {
    const $ = cheerio.load(results);
    const filteredResults = [];

    // Chercher les éléments de recherche selon la structure réelle
    $('div.search-item').each((_, element) => {
      const $el = $(element);
      const titleElement = $el.find('.search-title');
      const title = titleElement.text().trim();

      // Extraire le lien depuis l'attribut onclick
      const onclickAttr = $el.attr('onclick');
      let link = null;
      if (onclickAttr) {
        // Supporter les attributs avec quotes simples ou doubles
        const linkMatch = onclickAttr.match(/location\.href=['"]([^'\"]+)['"]/);
        if (linkMatch) {
          link = linkMatch[1];
        }
      }

      if (!title || !link) return;

      // Nettoyer le titre
      let cleanTitle = title;
      let seasonNumber = null;
      let year = null;

      // Extraire l'année si présente
      const yearMatch = title.match(/\((\d{4})\)/);
      if (yearMatch) {
        year = parseInt(yearMatch[1]);
        cleanTitle = title.replace(/\s*\(\d{4}\)/, '').trim();
      }

      // Extraire le numéro de saison si présent
      const seasonMatch = cleanTitle.match(/Saison\s+(\d+)/i);
      if (seasonMatch) {
        seasonNumber = parseInt(seasonMatch[1]);
        cleanTitle = cleanTitle.replace(/\s*-\s*Saison\s+\d+$/i, '').trim();
      } else {
        // Fallback: chercher "Saison X" dans le titre original
        const originalSeasonMatch = title.match(/Saison\s+(\d+)/i);
        if (originalSeasonMatch) {
          seasonNumber = parseInt(originalSeasonMatch[1]);
        }
      }

      // Normaliser les titres (accents, ponctuation, espaces) pour comparaisons robustes
      const normalize = (str) =>
        (str || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '') // accents
          .replace(/['’`´]/g, '') // apostrophes
          .replace(/[^a-z0-9\s-]/g, '') // autres ponctuations
          .replace(/\s+-\s+/g, ' ') // espaces autour de tirets
          .replace(/\s+/g, ' ') // espaces multiples
          .trim();

      const normalizedOriginal = normalize(originalTitle);
      const normalizedClean = normalize(cleanTitle);

      // Correspondance avec préférence au titre exact, sinon recouvrement de tokens
      const tokenize = (str) => (str || '')
        .split(' ')
        .filter(Boolean);

      const originalTokens = new Set(tokenize(normalizedOriginal));
      const cleanTokens = new Set(tokenize(normalizedClean));

      let intersectionSize = 0;
      for (const token of cleanTokens) {
        if (originalTokens.has(token)) intersectionSize += 1;
      }

      // Utiliser la taille du plus GRAND ensemble pour éviter que 1 mot ne valide des titres longs
      const largerSetSize = Math.max(1, Math.max(originalTokens.size, cleanTokens.size));
      const overlapScore = intersectionSize / largerSetSize; // plus strict pour titres d'une seule unité

      // Exiger l'année quand elle est disponible des deux côtés, sinon utiliser seulement le score de recouvrement
      const hasBothYears = Boolean(releaseYear && year);
      const yearMatches = hasBothYears ? parseInt(releaseYear) === year : true;

      const exactTitleMatch = normalizedClean === normalizedOriginal;
      const threshold = 0.7; // seuil pour correspondances partielles proches
      // N'autoriser les correspondances partielles que si le titre n'est pas beaucoup plus long
      const partialLengthOk = cleanTokens.size <= originalTokens.size + 1;
      // Cas important: le titre trouvé est un sous-ensemble exact du titre recherché (ex: sans sous-titre)
      // Exiger que le sous-ensemble couvre au moins 50% des tokens originaux pour éviter les faux positifs
      // (ex: "Sauvage" ne doit pas matcher "L'instinct sauvage")
      const subsetCoverage = cleanTokens.size / Math.max(1, originalTokens.size);
      const resultIsSubsetOfOriginal = Array.from(cleanTokens).every(t => originalTokens.has(t)) && subsetCoverage >= 0.5;
      const shouldInclude = yearMatches && (
        exactTitleMatch ||
        resultIsSubsetOfOriginal ||
        (overlapScore >= threshold && partialLengthOk)
      );

      if (shouldInclude) {
        filteredResults.push({
          title: cleanTitle,
          originalTitle: title,
          link: link.startsWith('http') ? link : `${FSTREAM_BASE_URL}${link}`,
          seasonNumber,
          year
        });
      }
    });

    // Pas de tri nécessaire ici

    return filteredResults;
  } catch (error) {
    console.error(`Erreur lors du filtrage des résultats FStream: ${error.message}`);
    return [];
  }
}
// Route pour les films FStream
app.get('/api/fstream/movie/:id', async (req, res) => {
  const { id } = req.params;

  // Définir cacheKey en dehors du try pour qu'il soit disponible dans le catch
  const cacheKey = generateFStreamCacheKey('movie', id);

  try {
    // Vérifier le cache d'abord
    const cachedData = await getFStreamFromCache(cacheKey);
    if (cachedData) {
      if (!cachedData.success) {
      }
      // Retourner les données du cache immédiatement
      res.status(200).json(cachedData);

      // Mettre à jour le cache en arrière-plan avec déduplication
      setImmediate(async () => {
        try {
          await getOrCreateFStreamRequest(`${cacheKey}_background`, async () => {
            // Récupérer les détails TMDB
            const tmdbDetails = await getFStreamTMDBDetails(id, 'movie');
            if (!tmdbDetails) {
              return;
            }

            const searchQuery = tmdbDetails.title;

            // Rechercher sur FStream (sans proxy)
            let searchResults = await searchFStreamDirect(searchQuery);

            // Filtrer les résultats
            let filteredResults = filterFStreamResults(searchResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);



            // Si aucun résultat, TOUJOURS vérifier dans les films récents
            // (pas seulement si le film est strictement récent, car la liste FStream peut contenir des films variés)
            if (filteredResults.length === 0) {
              try {
                const recentMovie = await findMovieInRecentFStream(tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

                if (recentMovie) {

                  // Récupérer la page du contenu depuis le film récent
                  const contentResponse = await axiosFStreamRequest({
                    method: 'get',
                    url: recentMovie.link
                  });

                  if (contentResponse.status === 200) {
                    // Extraire les lecteurs vidéo
                    const players = await extractFStreamPlayers(contentResponse.data, false);

                    if (players.total > 0) {
                      // Formater la réponse avec le film récent
                      const response = {
                        success: true,
                        source: 'FStream',
                        type: 'movie',
                        tmdb: tmdbDetails,
                        search: {
                          query: tmdbDetails.title,
                          results: 1,
                          bestMatch: {
                            title: recentMovie.title,
                            originalTitle: `${recentMovie.title} (${tmdbDetails.release_date?.split('-')[0]})`,
                            link: recentMovie.link,
                            seasonNumber: null,
                            year: parseInt(tmdbDetails.release_date?.split('-')[0])
                          }
                        },
                        players: players.organized,
                        total: players.total,
                        metadata: {
                          extractedAt: new Date().toISOString(),
                          backgroundUpdate: true,
                          foundInRecent: true
                        }
                      };

                      // Sauvegarder en cache
                      await saveFStreamToCache(cacheKey, response);
                      return;
                    }
                  }
                }
              } catch (recentError) {
                console.error(`[FSTREAM BACKGROUND] Erreur lors de la recherche dans les récents: ${recentError.message}`);
              }

              // Créer un résultat d'erreur pour le cache
              const errorResult = {
                success: false,
                error: 'Aucun résultat trouvé',
                message: `Aucun contenu trouvé pour "${tmdbDetails.title}" sur FStream`,
                search: {
                  query: tmdbDetails.title,
                  results: 0,
                  checkedRecent: true
                },
                timestamp: new Date().toISOString()
              };

              // Sauvegarder l'erreur en cache
              await saveFStreamToCache(cacheKey, errorResult);
              return;
            }

            // Filtrer par année si disponible - OBLIGATOIRE pour les films
            let bestResult = null;
            const tmdbYear = tmdbDetails.release_date?.split('-')[0];

            if (tmdbYear) {
              // Chercher UNIQUEMENT les résultats avec correspondance d'année exacte
              const yearMatches = filteredResults.filter(result => result.year === parseInt(tmdbYear));

              if (yearMatches.length > 0) {
                // Prendre le premier résultat avec la bonne année (correspondance exacte uniquement)
                bestResult = yearMatches[0];
              } else {
                // TOUJOURS vérifier dans les films récents quand il n'y a pas de correspondance d'année
                try {
                  const recentMovie = await findMovieInRecentFStream(tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

                  if (recentMovie) {

                    // Récupérer la page du contenu depuis le film récent
                    const contentResponse = await axiosFStreamRequest({
                      method: 'get',
                      url: recentMovie.link
                    });

                    if (contentResponse.status === 200) {
                      // Extraire les lecteurs vidéo
                      const players = await extractFStreamPlayers(contentResponse.data, false);

                      if (players.total > 0) {
                        // Formater la réponse avec le film récent
                        const response = {
                          success: true,
                          source: 'FStream',
                          type: 'movie',
                          tmdb: tmdbDetails,
                          search: {
                            query: tmdbDetails.title,
                            results: 1,
                            bestMatch: {
                              title: recentMovie.title,
                              originalTitle: `${recentMovie.title} (${tmdbDetails.release_date?.split('-')[0]})`,
                              link: recentMovie.link,
                              seasonNumber: null,
                              year: parseInt(tmdbDetails.release_date?.split('-')[0])
                            }
                          },
                          players: players.organized,
                          total: players.total,
                          metadata: {
                            extractedAt: new Date().toISOString(),
                            backgroundUpdate: true,
                            foundInRecent: true
                          }
                        };

                        // Sauvegarder en cache
                        await saveFStreamToCache(cacheKey, response);
                        return;
                      }
                    }
                  }
                } catch (recentError) {
                  console.error(`[FSTREAM BACKGROUND] Erreur lors de la recherche dans les récents: ${recentError.message}`);
                }

                // Créer un résultat d'erreur pour le cache
                const errorResult = {
                  success: false,
                  error: 'Aucune correspondance d\'année',
                  message: `Aucun contenu trouvé avec l'année ${tmdbYear} pour "${tmdbDetails.title}" sur FStream`,
                  search: {
                    query: tmdbDetails.title,
                    results: filteredResults.length,
                    year: tmdbYear,
                    checkedRecent: true
                  },
                  timestamp: new Date().toISOString()
                };

                // Sauvegarder l'erreur en cache
                await saveFStreamToCache(cacheKey, errorResult);
                return;
              }
            } else {
              // Si pas d'année TMDB, prendre le premier résultat (cas rare)
              bestResult = filteredResults[0];
            }

            // Vérification de sécurité
            if (!bestResult) {

              // Créer un résultat d'erreur pour le cache
              const errorResult = {
                success: false,
                error: 'Aucun résultat valide',
                message: `Aucun résultat valide trouvé pour "${tmdbDetails.title}" sur FStream`,
                search: {
                  query: tmdbDetails.title,
                  results: filteredResults.length
                },
                timestamp: new Date().toISOString()
              };

              // Sauvegarder l'erreur en cache
              await saveFStreamToCache(cacheKey, errorResult);
              return;
            }

            // Récupérer la page du contenu
            const contentResponse = await axiosFStreamRequest({
              method: 'get',
              url: bestResult.link
            });

            if (contentResponse.status !== 200) {
              return;
            }

            // Extraire les lecteurs vidéo
            const players = await extractFStreamPlayers(contentResponse.data, false);

            if (players.total === 0) {
              return;
            }

            // Formater la réponse
            const response = {
              success: true,
              source: 'FStream',
              type: 'movie',
              tmdb: tmdbDetails,
              search: {
                query: searchQuery,
                results: filteredResults.length,
                bestMatch: bestResult
              },
              players: players.organized,
              total: players.total,
              metadata: {
                extractedAt: new Date().toISOString(),
                backgroundUpdate: true
              }
            };

            // Sauvegarder en cache
            await saveFStreamToCache(cacheKey, response);
            return response;
          });
        } catch (error) {
        }
      });

      return;
    }

    // Pas de cache, faire la requête avec déduplication
    const result = await getOrCreateFStreamRequest(cacheKey, async () => {
      // Récupérer les détails TMDB
      const tmdbDetails = await getFStreamTMDBDetails(id, 'movie');
      if (!tmdbDetails) {
        throw new Error('Contenu TMDB non trouvé');
      }

      const searchQuery = tmdbDetails.title;

      // Rechercher sur FStream (sans proxy)
      let searchResults = await searchFStreamDirect(searchQuery);

      // Filtrer les résultats
      let filteredResults = filterFStreamResults(searchResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

      // Filtrer par année si disponible - OBLIGATOIRE pour les films
      let bestResult = null;
      const tmdbYear = tmdbDetails.release_date?.split('-')[0];

      if (tmdbYear) {
        // Chercher UNIQUEMENT les résultats avec correspondance d'année exacte
        const yearMatches = filteredResults.filter(result => result.year === parseInt(tmdbYear));

        if (yearMatches.length > 0) {
          // Prendre le premier résultat avec la bonne année (correspondance exacte uniquement)
          bestResult = yearMatches[0];
        } else {
          // Vérifier dans les films récents quand il n'y a pas de correspondance d'année
          const recentMovie = await findMovieInRecentFStream(tmdbDetails.title, tmdbYear);

          if (recentMovie) {
            bestResult = {
              title: recentMovie.title,
              originalTitle: `${recentMovie.title} (${tmdbYear})`,
              link: recentMovie.link,
              seasonNumber: null,
              year: parseInt(tmdbYear)
            };
          } else {
            throw new Error(`Aucun résultat trouvé avec l'année ${tmdbYear} sur FStream`);
          }
        }
      } else {
        // Si pas d'année TMDB, prendre le premier résultat (cas rare)
        if (filteredResults.length > 0) {
          bestResult = filteredResults[0];
        }
      }

      // Si toujours aucun résultat, vérifier dans les films récents
      if (filteredResults.length === 0 && !bestResult) {
        const recentMovie = await findMovieInRecentFStream(tmdbDetails.title, tmdbYear);

        if (recentMovie) {
          bestResult = {
            title: recentMovie.title,
            originalTitle: `${recentMovie.title}${tmdbYear ? ` (${tmdbYear})` : ''}`,
            link: recentMovie.link,
            seasonNumber: null,
            year: tmdbYear ? parseInt(tmdbYear) : null
          };
        } else {
          throw new Error('Aucun résultat trouvé sur FStream');
        }
      }

      // Vérification de sécurité
      if (!bestResult) {
        throw new Error('Aucun résultat valide trouvé sur FStream');
      }

      // Récupérer la page du contenu
      const contentResponse = await axiosFStreamRequest({
        method: 'get',
        url: bestResult.link
      });

      if (contentResponse.status !== 200) {
        throw new Error(`Erreur lors de la récupération de la page: ${contentResponse.status}`);
      }

      // Extraire les lecteurs vidéo (films uniquement)
      const players = await extractFStreamPlayers(contentResponse.data, false);

      if (players.total === 0) {
        return res.status(404).json({
          error: 'Aucun lecteur vidéo trouvé',
          searchQuery,
          bestResult: bestResult.title
        });
      }

      // Formater la réponse
      const response = {
        success: true,
        source: 'FStream',
        type: 'movie',
        tmdb: tmdbDetails,
        search: {
          query: searchQuery,
          results: filteredResults.length,
          bestMatch: bestResult
        },
        players: players.organized,
        total: players.total,
        metadata: {
          extractedAt: new Date().toISOString()
        }
      };

      return response;
    });

    // Sauvegarder en cache seulement si pas d'erreur
    await saveFStreamToCache(cacheKey, result);

    res.status(200).json(result);

  } catch (error) {
    console.error(`[FSTREAM MOVIE] Erreur: ${error.message}`);

    // Ne pas mettre à jour le cache en cas d'erreur
    // Créer un résultat d'erreur pour le cache
    const errorResult = {
      success: false,
      error: 'Erreur lors de la récupération des sources FStream',
      message: error.message,
      timestamp: new Date().toISOString()
    };

    // Sauvegarder l'erreur en cache (non-résultat)
    await saveFStreamToCache(cacheKey, errorResult);

    res.status(500).json(errorResult);
  }
});

// Route de test pour les films récents FStream
app.get('/api/fstream/test/recent', async (req, res) => {
  try {
    const recentMovies = await scrapeFStreamRecentMovies();
    res.status(200).json({
      success: true,
      count: recentMovies.length,
      movies: recentMovies.slice(0, 10), // Limiter à 10 pour la lisibilité
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Route de test pour les séries récentes FStream
app.get('/api/fstream/test/recent-series', async (req, res) => {
  try {
    const recentSeries = await scrapeFStreamRecentSeries();
    res.status(200).json({
      success: true,
      count: recentSeries.length,
      series: recentSeries.slice(0, 10), // Limiter à 10 pour la lisibilité
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Route de debug pour voir les requêtes FStream en cours
app.get('/api/fstream/debug/ongoing', async (req, res) => {
  try {
    const ongoingKeys = Array.from(ongoingFStreamRequests.keys());
    res.status(200).json({
      success: true,
      ongoingRequests: ongoingKeys.length,
      keys: ongoingKeys,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Route pour supprimer le cache FStream d'un film
app.get('/api/fstream/movie/:id/clear-cache', async (req, res) => {
  const { id } = req.params;
  const cacheKey = generateFStreamCacheKey('movie', id);
  const cacheFilePath = path.join(CACHE_DIR.FSTREAM, `${cacheKey}.json`);

  try {
    // Supprimer le cache fichier
    await fsp.unlink(cacheFilePath);
    // Supprimer le cache Redis
    try { await redis.del(`fstream:${cacheKey}`); } catch {}
    console.log(`[FSTREAM Cache] Cache cleared for movie ${id}`);
    res.json({ success: true, message: `Cache cleared for movie ${id}` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Fichier pas trouvé, tenter quand même de supprimer le cache Redis
      try { await redis.del(`fstream:${cacheKey}`); } catch {}
      res.status(404).json({ error: `No cache found for movie ${id}` });
    } else {
      console.error(`[FSTREAM Cache] Error clearing cache for movie ${id}:`, error.message);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  }
});

// Route pour supprimer le cache FStream d'une série
app.get('/api/fstream/tv/:id/season/:season/clear-cache', async (req, res) => {
  const { id, season } = req.params;
  const { episode } = req.query;
  const cacheKey = generateFStreamCacheKey('tv', id, season, episode || null);
  const cacheFilePath = path.join(CACHE_DIR.FSTREAM, `${cacheKey}.json`);

  try {
    await fsp.unlink(cacheFilePath);
    try { await redis.del(`fstream:${cacheKey}`); } catch {}
    console.log(`[FSTREAM Cache] Cache cleared for tv ${id} S${season}${episode ? ' E' + episode : ''}`);
    res.json({ success: true, message: `Cache cleared for tv ${id} season ${season}${episode ? ' episode ' + episode : ''}` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { await redis.del(`fstream:${cacheKey}`); } catch {}
      res.status(404).json({ error: `No cache found for tv ${id} season ${season}` });
    } else {
      console.error(`[FSTREAM Cache] Error clearing cache for tv ${id}:`, error.message);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  }
});

// Route pour les séries FStream
app.get('/api/fstream/tv/:id/season/:season', async (req, res) => {
  const { id, season } = req.params;
  const { episode } = req.query; // numéro d'épisode optionnel

  // Log de débogage

  // Définir cacheKey en dehors du try pour qu'il soit disponible dans le catch
  const cacheKey = generateFStreamCacheKey('tv', id, season, episode);

  try {
    // Vérifier le cache d'abord
    const cachedData = await getFStreamFromCache(cacheKey);
    if (cachedData) {
      // Retourner les données du cache immédiatement
      res.status(200).json(cachedData);

      // Mettre à jour le cache en arrière-plan avec déduplication
      setImmediate(async () => {
        try {
          await getOrCreateFStreamRequest(`${cacheKey}_background`, async () => {
            // Récupérer les détails TMDB
            const tmdbDetails = await getFStreamTMDBDetails(id, 'tv');
            if (!tmdbDetails) {
              return;
            }

            let searchQuery;
            if (id === '259909') {
              searchQuery = 'Dexter : Résurrection - Saison 1';
            } else {
              searchQuery = `${tmdbDetails.title} - Saison ${season}`;
            }

            // Rechercher sur FStream (sans proxy)
            let searchResults = await searchFStreamDirect(searchQuery);

            // Filtrer les résultats
            let filteredResults = filterFStreamResults(searchResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

            // Si aucun résultat, essayer avec l'année
            if (filteredResults.length === 0) {
              // Dernier recours précoce : requête directe des saisons via l'endpoint ajax
              const directSeasonsEarly = await fetchFStreamSeasonSearchResults(id, tmdbDetails.title);
              if (directSeasonsEarly.length > 0) {
                filteredResults = directSeasonsEarly;
              }

              // Essayer une recherche de fallback avec l'année
              if (tmdbDetails.release_date) {
                const year = tmdbDetails.release_date.split('-')[0];
                const fallbackQuery = `${tmdbDetails.title} (${year}) - Saison ${season}`;

                try {
                  let fallbackSearchResults = await searchFStreamDirect(fallbackQuery);

                  let fallbackFilteredResults = filterFStreamResults(fallbackSearchResults, tmdbDetails.title, year);

                  if (fallbackFilteredResults.length > 0) {
                    filteredResults = fallbackFilteredResults;
                  }
                } catch (fallbackError) {
                  console.log(`[FSTREAM TV BACKGROUND] ⚠️ Erreur lors de la recherche de fallback avec année: ${fallbackError.message}`);
                }
              }

              // Si toujours aucun résultat, essayer avec le nom sans paramètre de langue
              if (filteredResults.length === 0 && tmdbDetails.name_no_lang && tmdbDetails.name_no_lang !== tmdbDetails.title) {
                const noLangFallbackQuery = `${tmdbDetails.name_no_lang} - Saison ${season}`;

                try {
                  let noLangSearchResults = await searchFStreamDirect(noLangFallbackQuery);

                  let noLangFilteredResults = filterFStreamResults(noLangSearchResults, tmdbDetails.name_no_lang, tmdbDetails.release_date?.split('-')[0]);

                  if (noLangFilteredResults.length > 0) {
                    filteredResults = noLangFilteredResults;
                    console.log(`[FSTREAM TV BACKGROUND] ✅ Fallback avec nom sans langue réussi: "${noLangFallbackQuery}"`);
                  }
                } catch (noLangFallbackError) {
                  console.log(`[FSTREAM TV BACKGROUND] ⚠️ Erreur lors de la recherche de fallback avec nom sans langue: ${noLangFallbackError.message}`);
                }
              }

              // Si toujours aucun résultat après tous les fallbacks
              if (filteredResults.length === 0) {
                // Dernier recours : requête directe des saisons via l'endpoint ajax (seconde tentative)
                const directSeasons = await fetchFStreamSeasonSearchResults(id, tmdbDetails.title);
                if (directSeasons.length > 0) {
                  filteredResults = directSeasons;
                }

                // Si toujours aucun résultat, vérifier si la série est récente (moins de 2 jours)
                if (filteredResults.length === 0) {
                  const releaseDate = tmdbDetails.release_date;
                  let shouldCheckRecent = false;

                  if (releaseDate) {
                    const releaseDateTime = new Date(releaseDate);
                    const now = new Date();
                    const diffInDays = (now - releaseDateTime) / (1000 * 60 * 60 * 24);

                    if (diffInDays <= 2) {
                      shouldCheckRecent = true;
                      console.log(`[FSTREAM TV BACKGROUND] Série récente détectée (${diffInDays.toFixed(1)} jours), recherche dans les séries récentes...`);
                    }
                  }

                  // Si la série est récente, chercher dans les séries récentes
                  if (shouldCheckRecent) {
                    try {
                      const recentSeries = await findSeriesInRecentFStream(tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

                      if (recentSeries) {
                        console.log(`[FSTREAM TV BACKGROUND] ✅ Série trouvée dans les récents: "${recentSeries.title}"`);

                        // Récupérer la page du contenu depuis la série récente
                        const contentResponse = await axiosFStreamRequest({
                          method: 'get',
                          url: recentSeries.link
                        });

                        if (contentResponse.status === 200) {
                          // Extraire les lecteurs vidéo
                          const players = await extractFStreamPlayers(contentResponse.data, true);

                          if (players.total > 0) {
                            // Formater la réponse avec la série récente
                            const response = {
                              success: true,
                              source: 'FStream',
                              type: 'tv',
                              tmdb: tmdbDetails,
                              search: {
                                query: `${tmdbDetails.title} - Saison ${season}`,
                                results: 1,
                                bestMatch: {
                                  title: recentSeries.title,
                                  originalTitle: `${recentSeries.title} (${tmdbDetails.release_date?.split('-')[0]})`,
                                  link: recentSeries.link,
                                  seasonNumber: parseInt(season),
                                  year: parseInt(tmdbDetails.release_date?.split('-')[0])
                                }
                              },
                              episodes: players.episodes,
                              total: players.total,
                              metadata: {
                                season: parseInt(season),
                                episode: episode ? parseInt(episode) : null,
                                extractedAt: new Date().toISOString(),
                                backgroundUpdate: true,
                                foundInRecent: true
                              }
                            };

                            // Sauvegarder en cache
                            await saveFStreamToCache(cacheKey, response);
                            return;
                          }
                        }
                      }
                    } catch (recentError) {
                      console.error(`[FSTREAM TV BACKGROUND] Erreur lors de la recherche dans les récents: ${recentError.message}`);
                    }
                  }

                  // Créer un résultat d'erreur pour le cache
                  const errorResult = {
                    success: false,
                    error: 'Aucun résultat trouvé',
                    message: `Aucun contenu trouvé pour "${tmdbDetails.title} - Saison ${season}" sur FStream`,
                    search: {
                      query: `${tmdbDetails.title} - Saison ${season}`,
                      fallbackQuery: tmdbDetails.release_date ? `${tmdbDetails.title} (${tmdbDetails.release_date.split('-')[0]}) - Saison ${season}` : null,
                      noLangFallbackQuery: tmdbDetails.name_no_lang && tmdbDetails.name_no_lang !== tmdbDetails.title ? `${tmdbDetails.name_no_lang} - Saison ${season}` : null,
                      results: 0,
                      checkedRecent: shouldCheckRecent
                    },
                    timestamp: new Date().toISOString()
                  };

                  // Sauvegarder l'erreur en cache
                  await saveFStreamToCache(cacheKey, errorResult);
                  return;
                }
              }
            }

            // Filtrer par saison demandée
            const requestedSeason = parseInt(season);

            // Chercher une correspondance exacte de saison
            const seasonMatch = filteredResults.find(result => {
              if (result.seasonNumber) {
                return result.seasonNumber === requestedSeason;
              }
              return false;
            });

            if (seasonMatch) {
            } else {
              console.log(`[FSTREAM TV BACKGROUND] ⚠️ Aucune correspondance exacte de saison trouvée`);
            }

            // Si aucune correspondance exacte, chercher dans le titre original
            let bestResult = seasonMatch;
            if (!bestResult) {
              const titleSeasonMatch = filteredResults.find(result => {
                if (result.originalTitle) {
                  const seasonInTitle = result.originalTitle.match(/Saison\s+(\d+)/i);
                  if (seasonInTitle) {
                    return parseInt(seasonInTitle[1]) === requestedSeason;
                  }
                }
                return false;
              });
              bestResult = titleSeasonMatch;
              if (titleSeasonMatch) {
              }
            }

            // Si toujours aucune correspondance, créer un résultat d'erreur pour le cache
            if (!bestResult) {
              // Filtrer seulement les saisons de la série demandée
              const availableSeasons = filteredResults
                .filter(r => r.seasonNumber && r.title.toLowerCase().includes(tmdbDetails.title.toLowerCase().split(/[:\-]/)[0].trim().toLowerCase()))
                .map(r => r.seasonNumber)
                .filter((season, index, arr) => arr.indexOf(season) === index) // Supprimer les doublons
                .sort((a, b) => a - b);

              const seasonText = availableSeasons.length > 0
                ? `Saisons disponibles pour "${tmdbDetails.title}": ${availableSeasons.join(', ')}`
                : `Aucune saison trouvée pour "${tmdbDetails.title}"`;


              // Créer un résultat d'erreur pour le cache
              const errorResult = {
                success: false,
                error: 'Erreur lors de la récupération des sources FStream',
                message: `Saison ${requestedSeason} non trouvée. ${seasonText}`,
                timestamp: new Date().toISOString()
              };

              // Sauvegarder l'erreur en cache
              await saveFStreamToCache(cacheKey, errorResult);
              return errorResult;
            }

            // Récupérer la page du contenu
            const contentResponse = await axiosFStreamRequest({
              method: 'get',
              url: bestResult.link,
              headers: {
                'Cookie': Object.entries(fstreamCookies)
                  .map(([key, value]) => `${key}=${value}`)
                  .join('; ')
              }
            });

            if (contentResponse.status !== 200) {
              return;
            }

            // Extraire les lecteurs vidéo (séries)
            const players = await extractFStreamPlayers(contentResponse.data, true);

            if (players.total === 0) {
              return;
            }

            // Valider la date de sortie
            let isAvailable = true;
            if (tmdbDetails.release_date) {
              const tmdbYear = tmdbDetails.release_date.split('-')[0];

              if (players.fstreamReleaseDate) {
                const fstreamYear = players.fstreamReleaseDate;
                if (fstreamYear !== tmdbYear) {
                  isAvailable = false;
                } else {
                }
              } else {
                // Si aucune date n'est trouvée sur FStream, marquer comme non disponible par sécurité
                isAvailable = false;
              }
            }

            // Formater la réponse
            const response = {
              success: isAvailable,
              source: 'FStream',
              type: 'tv',
              tmdb: tmdbDetails,
              search: {
                query: searchQuery,
                results: filteredResults.length,
                bestMatch: bestResult
              },
              episodes: isAvailable ? players.episodes : {},
              total: isAvailable ? players.total : 0,
              metadata: {
                season: parseInt(season),
                episode: episode ? parseInt(episode) : null,
                extractedAt: new Date().toISOString(),
                backgroundUpdate: true,
                fstreamReleaseDate: players.fstreamReleaseDate,
                dateValidation: {
                  fstreamYear: players.fstreamReleaseDate,
                  tmdbYear: tmdbDetails.release_date?.split('-')[0],
                  isAvailable: isAvailable
                }
              }
            };

            // Sauvegarder en cache
            await saveFStreamToCache(cacheKey, response);
            return response;
          });
        } catch (error) {
        }
      });

      return;
    }

    // Pas de cache, faire la requête avec déduplication
    const result = await getOrCreateFStreamRequest(cacheKey, async () => {
      // Récupérer les détails TMDB
      const tmdbDetails = await getFStreamTMDBDetails(id, 'tv');
      if (!tmdbDetails) {
        throw new Error('Contenu TMDB non trouvé');
      }

      let searchQuery;
      if (id === '259909') {
        searchQuery = 'Dexter : Résurrection - Saison 1';
      } else {
        searchQuery = `${tmdbDetails.title} - Saison ${season}`;
      }

      // Rechercher sur FStream (sans proxy)
      let searchResults = await searchFStreamDirect(searchQuery);

      // Filtrer les résultats
      let filteredResults = filterFStreamResults(searchResults, tmdbDetails.title, tmdbDetails.release_date?.split('-')[0]);

      // Si aucun résultat, essayer avec l'année
      if (filteredResults.length === 0) {
        // Dernier recours précoce : requête directe des saisons via l'endpoint ajax
        const directSeasonsEarly = await fetchFStreamSeasonSearchResults(id, tmdbDetails.title);
        if (directSeasonsEarly.length > 0) {
          filteredResults = directSeasonsEarly;
          console.log(`[FSTREAM TV] ✅ Requête directe des saisons réussie (ajax - précoce)`);
        }

        // Essayer une recherche de fallback avec l'année
        if (tmdbDetails.release_date) {
          const year = tmdbDetails.release_date.split('-')[0];
          const fallbackQuery = `${tmdbDetails.title} (${year}) - Saison ${season}`;

          try {
            let fallbackSearchResults = await searchFStreamDirect(fallbackQuery);

            let fallbackFilteredResults = filterFStreamResults(fallbackSearchResults, tmdbDetails.title, year);

            if (fallbackFilteredResults.length > 0) {
              filteredResults = fallbackFilteredResults;
            }
          } catch (fallbackError) {
            console.log(`[FSTREAM TV] ⚠️ Erreur lors de la recherche de fallback avec année: ${fallbackError.message}`);
          }
        }

        // Si toujours aucun résultat, essayer avec le nom sans paramètre de langue
        if (filteredResults.length === 0 && tmdbDetails.name_no_lang && tmdbDetails.name_no_lang !== tmdbDetails.title) {
          const noLangFallbackQuery = `${tmdbDetails.name_no_lang} - Saison ${season}`;

          try {
            let noLangSearchResults = await searchFStreamDirect(noLangFallbackQuery);

            let noLangFilteredResults = filterFStreamResults(noLangSearchResults, tmdbDetails.name_no_lang, tmdbDetails.release_date?.split('-')[0]);

            if (noLangFilteredResults.length > 0) {
              filteredResults = noLangFilteredResults;
              console.log(`[FSTREAM TV] ✅ Fallback avec nom sans langue réussi: "${noLangFallbackQuery}"`);
            }
          } catch (noLangFallbackError) {
            console.log(`[FSTREAM TV] ⚠️ Erreur lors de la recherche de fallback avec nom sans langue: ${noLangFallbackError.message}`);
          }
        }

        // Si toujours aucun résultat après tous les fallbacks
        if (filteredResults.length === 0) {
          // Dernier recours : requête directe des saisons via l'endpoint ajax (seconde tentative)
          const directSeasons = await fetchFStreamSeasonSearchResults(id, tmdbDetails.title);
          if (directSeasons.length > 0) {
            filteredResults = directSeasons;
            console.log(`[FSTREAM TV] ✅ Requête directe des saisons réussie (ajax)`);
          }
        }

        if (filteredResults.length === 0) {
          throw new Error('Aucun résultat trouvé sur FStream');
        }
      }

      // Filtrer par saison demandée
      const requestedSeason = parseInt(season);

      // Chercher une correspondance exacte de saison
      const seasonMatch = filteredResults.find(result => {
        if (result.seasonNumber) {
          return result.seasonNumber === requestedSeason;
        }
        return false;
      });

      // Si aucune correspondance exacte, chercher dans le titre original
      let bestResult = seasonMatch;
      if (!bestResult) {
        const titleSeasonMatch = filteredResults.find(result => {
          if (result.originalTitle) {
            const seasonInTitle = result.originalTitle.match(/Saison\s+(\d+)/i);
            if (seasonInTitle) {
              return parseInt(seasonInTitle[1]) === requestedSeason;
            }
          }
          return false;
        });
        bestResult = titleSeasonMatch;
      }

      // Si toujours aucune correspondance, retourner une erreur plutôt que le premier résultat
      if (!bestResult) {
        // Filtrer seulement les saisons de la série demandée
        const availableSeasons = filteredResults
          .filter(r => r.seasonNumber && r.title.toLowerCase().includes(tmdbDetails.title.toLowerCase().split(/[:\-]/)[0].trim().toLowerCase()))
          .map(r => r.seasonNumber)
          .filter((season, index, arr) => arr.indexOf(season) === index) // Supprimer les doublons
          .sort((a, b) => a - b);

        const seasonText = availableSeasons.length > 0
          ? `Saisons disponibles pour "${tmdbDetails.title}": ${availableSeasons.join(', ')}`
          : `Aucune saison trouvée pour "${tmdbDetails.title}"`;

        throw new Error(`Saison ${requestedSeason} non trouvée. ${seasonText}`);
      }

      // Get content page
      const contentResponse = await axiosFStreamRequest({
        method: 'get',
        url: bestResult.link
      });

      if (contentResponse.status !== 200) {
        throw new Error(`Erreur HTTP: ${contentResponse.status}`);
      }

      // Extraire les lecteurs vidéo (séries)
      const players = await extractFStreamPlayers(contentResponse.data, true);

      if (players.total === 0) {
        throw new Error('Aucun lecteur vidéo trouvé');
      }

      // Valider la date de sortie
      let isAvailable = true;
      if (tmdbDetails.release_date) {
        const tmdbYear = tmdbDetails.release_date.split('-')[0];

        if (players.fstreamReleaseDate) {
          const fstreamYear = players.fstreamReleaseDate;
          if (fstreamYear !== tmdbYear) {
            isAvailable = false;
          } else {
          }
        } else {
          // Si aucune date n'est trouvée sur FStream, marquer comme non disponible par sécurité
          isAvailable = false;
        }
      }

      // Formater la réponse
      return {
        success: isAvailable,
        source: 'FStream',
        type: 'tv',
        tmdb: tmdbDetails,
        search: {
          query: searchQuery,
          results: filteredResults.length,
          bestMatch: bestResult
        },
        episodes: isAvailable ? players.episodes : {},
        total: isAvailable ? players.total : 0,
        metadata: {
          season: parseInt(season),
          episode: episode ? parseInt(episode) : null,
          extractedAt: new Date().toISOString(),
          fstreamReleaseDate: players.fstreamReleaseDate,
          dateValidation: {
            fstreamYear: players.fstreamReleaseDate,
            tmdbYear: tmdbDetails.release_date?.split('-')[0],
            isAvailable: isAvailable
          }
        }
      };
    });

    // Sauvegarder en cache seulement si pas d'erreur
    await saveFStreamToCache(cacheKey, result);

    res.status(200).json(result);

  } catch (error) {
    console.error(`[FSTREAM TV] Erreur: ${error.message}`);

    // Ne pas mettre à jour le cache en cas d'erreur
    // Créer un résultat d'erreur pour le cache
    const errorResult = {
      success: false,
      error: 'Erreur lors de la récupération des sources FStream',
      message: error.message,
      timestamp: new Date().toISOString()
    };

    // Sauvegarder l'erreur en cache (non-résultat)
    await saveFStreamToCache(cacheKey, errorResult);

    res.status(500).json(errorResult);
  }
});

// Route pour supprimer tout le cache Coflix d'une série entière (toutes saisons/épisodes)
app.get('/api/tmdb/cache/series/:id', async (req, res) => {
  const { id } = req.params;
  const cacheDir = CACHE_DIR.COFLIX;

  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    const files = await fsp.readdir(cacheDir);

    let removed = 0;
    const removedFiles = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fullPath = path.join(cacheDir, file);

      try {
        const content = await fsp.readFile(fullPath, 'utf-8');
        const data = JSON.parse(content);

        // Vérifier si c'est un cache pour cette série TMDB
        const isSameId = data && String(data.tmdb_id) === String(id);
        const isTvSeries = data && data.tmdb_details && (typeof data.tmdb_details.title === 'string' || typeof data.tmdb_details.original_title === 'string');

        if (isSameId && isTvSeries) {
          await fsp.unlink(fullPath);
          removed++;
          removedFiles.push(file);
        }
      } catch (parseError) {
        // Ignorer les fichiers corrompus
        continue;
      }
    }

    console.log(`Cache Coflix supprimé pour la série TMDB ${id}: ${removed} fichiers`);
    res.json({
      message: `Cache Coflix supprimé pour la série TMDB ${id}`,
      removed_files: removed,
      files: removedFiles
    });

  } catch (error) {
    console.error(`Erreur lors de la suppression du cache Coflix pour la série ${id}: ${error.message}`);
    res.status(500).json({
      error: 'Erreur lors de la suppression du cache Coflix',
      message: error.message
    });
  }
});

// Route pour supprimer le cache Coflix d'un contenu TMDB spécifique
// Exemples :
//   DELETE /api/tmdb/cache/movie/136797           → supprime le cache du film
//   DELETE /api/tmdb/cache/tv/12345?season=1&episode=3 → supprime un épisode précis
//   DELETE /api/tmdb/cache/tv/12345               → supprime TOUS les épisodes de la série
app.delete('/api/tmdb/cache/:type/:id', async (req, res) => {
  const { id, type } = req.params;
  const { season, episode } = req.query;

  try {
    let removedFiles = 0;
    let removedRedisKeys = 0;

    // Si c'est une série sans season/episode, supprimer tous les fichiers de cache liés
    if (type === 'tv' && !season && !episode) {
      // Parcourir le dossier de cache pour trouver tous les fichiers liés à cet ID
      const files = await fsp.readdir(CACHE_DIR.COFLIX);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const fullPath = path.join(CACHE_DIR.COFLIX, file);
        try {
          const content = await fsp.readFile(fullPath, 'utf-8');
          const data = JSON.parse(content);
          if (data && String(data.tmdb_id) === String(id)) {
            await fsp.unlink(fullPath);
            removedFiles++;
            // Supprimer aussi le cache Redis (L1) correspondant
            const memKey = `${CACHE_DIR.COFLIX}:${file.replace('.json', '')}`;
            try { await redis.del(memKey); removedRedisKeys++; } catch {}
          }
        } catch { continue; }
      }
    } else {
      // Suppression d'un cache spécifique (film ou épisode précis)
      const cacheKey = generateCacheKey(`tmdb_links_${type}_${id}_${season || ''}_${episode || ''}`);
      const cacheFile = path.join(CACHE_DIR.COFLIX, `${cacheKey}.json`);
      const memKey = `${CACHE_DIR.COFLIX}:${cacheKey}`;

      // Supprimer le cache fichier (L2)
      try {
        await fsp.unlink(cacheFile);
        removedFiles++;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Supprimer le cache Redis (L1)
      try { await redis.del(memKey); removedRedisKeys++; } catch {}
    }

    console.log(`Cache supprimé pour TMDB ${type} ${id} (${removedFiles} fichier(s), ${removedRedisKeys} clé(s) Redis)`);
    res.json({
      message: `Cache supprimé pour TMDB ${type} ${id}`,
      removed_files: removedFiles,
      removed_redis_keys: removedRedisKeys
    });
  } catch (error) {
    console.error(`Erreur lors de la suppression du cache: ${error.message}`);
    res.status(500).json({ error: 'Erreur lors de la suppression du cache' });
  }
});

// Supprimer tout le cache SenpaiStream d'une série (toutes saisons/épisodes)
app.get('/api/SenpaiStream/tv/cache/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const cacheDir = path.join(__dirname, 'cache', 'SenpaiStream');

  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    const files = await fsp.readdir(cacheDir);

    let removed = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const fullPath = path.join(cacheDir, file);
      try {
        const content = await fsp.readFile(fullPath, 'utf-8');
        const data = JSON.parse(content);
        // Cible les caches TV pour cette série:
        // - cas normal: season & episode présents
        // - cas not-found: pas de season/episode mais tmdb_details contient name/original_name (spécifique TV)
        const isSameId = data && String(data.tmdb_id) === String(tmdbId);
        const isTvByFields = data && data.tmdb_details && (typeof data.tmdb_details.name === 'string' || typeof data.tmdb_details.original_name === 'string');
        const hasEpisodeFields = typeof data?.season !== 'undefined' && typeof data?.episode !== 'undefined';
        if (isSameId && (hasEpisodeFields || isTvByFields)) {
          await fsp.unlink(fullPath);
          removed++;
        }
      } catch (err) {
        // Ignorer fichiers illisibles/corrompus
        continue;
      }
    }

    return res.json({
      success: true,
      tmdb_id: tmdbId,
      removed,
      cache_dir: cacheDir,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[SenpaiStream TV CACHE CLEAR] Erreur: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: 'Erreur lors de la suppression du cache SenpaiStream TV',
      message: error.message,
      tmdb_id: tmdbId,
      timestamp: new Date().toISOString()
    });
  }
});

// ==================== WIFLIX ROUTES ====================

// Fonctions utilitaires pour Wiflix
const normalizeString = (str) => {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Supprimer les accents
    .replace(/[^\w\s]/g, ' ') // Remplacer la ponctuation par des espaces
    .replace(/\s+/g, ' ') // Normaliser les espaces
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
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  const maxLength = Math.max(s1.length, s2.length);
  return maxLength === 0 ? 1 : (maxLength - matrix[s2.length][s1.length]) / maxLength;
};

// Fonction pour rechercher un film sur Wiflix
async function searchWiflixMovie(title, baseUrl = 'https://flemmix.irish') {
  // Endpoint AJAX de recherche
  const searchUrl = `${baseUrl}/engine/ajax/search.php`;
  try {
    const response = await axiosWiflixRequest({
      url: searchUrl,
      method: 'POST',
      data: new URLSearchParams({
        query: title
      }),
      headers: {
        'accept-language': 'fr-FR,fr;q=0.5',
        'cache-control': 'no-cache',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin': 'https://flemmix.irish',
        'pragma': 'no-cache',
        'priority': 'u=1, i',
        'referer': 'https://flemmix.irish/',
        'sec-ch-ua': '"Chromium";v="142", "Brave";v="142", "Not_A Brand";v="99"',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-full-version-list': '"Chromium";v="142.0.0.0", "Brave";v="142.0.0.0", "Not_A Brand";v="99.0.0.0"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-model': '""',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'sec-gpc': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'x-requested-with': 'XMLHttpRequest'
      }
    });


    const $ = cheerio.load(response.data);

    // La réponse AJAX contient directement des éléments <a> avec les résultats
    // Format: <a href="url"><span class="searchheading">Titre</span><span></span></a>
    const searchResults = $('a');

    if (searchResults.length === 0) {
      return null;
    }

    let bestMatch = null;
    let bestSimilarity = 0;

    searchResults.each((index, element) => {
      const $result = $(element);
      const href = $result.attr('href');

      // Ignorer les liens de "Recherche Avancée" et autres liens internes
      if (!href || href.includes('do=search') || href.includes('mode=advanced')) {
        return;
      }

      // Le titre est dans le span.searchheading
      const $titleSpan = $result.find('span.searchheading');
      if (!$titleSpan.length) return;

      const resultTitle = $titleSpan.text().trim();
      const resultTitleLower = resultTitle.toLowerCase();

      // Déterminer si c'est une série ou un film en regardant l'URL et le titre
      const isSeries = href.includes('/serie-') || resultTitleLower.includes('saison');
      const searchIsSeries = title.toLowerCase().includes('saison');

      // Filtrer les films si on cherche une série et vice-versa
      if (searchIsSeries && !isSeries) {
        return;
      }
      if (!searchIsSeries && isSeries) {
        return;
      }

      // Pour les séries, vérifier la correspondance de saison
      if (searchIsSeries) {
        const searchSeasonMatch = title.match(/saison\s+(\d+)/i);
        if (searchSeasonMatch) {
          const searchSeason = parseInt(searchSeasonMatch[1]);
          const resultSeasonMatch = resultTitle.match(/saison\s+(\d+)/i);

          if (resultSeasonMatch) {
            const resultSeason = parseInt(resultSeasonMatch[1]);
            if (searchSeason !== resultSeason) {
              return; // Mauvaise saison
            }
          } else {
            return; // On cherche une saison mais le résultat n'en a pas
          }
        }
      }

      // Calculer la similarité en utilisant le titre nettoyé (sans "saison X")
      const cleanSearchTitle = title.toLowerCase().replace(/\s+saison\s+\d+/g, '').trim();
      const cleanResultTitle = resultTitle.toLowerCase().replace(/\s+saison\s+\d+/g, '').trim();

      let similarity = 0;
      if (cleanResultTitle === cleanSearchTitle) {
        similarity = 1.0;
      } else if (typeof getLevenshteinSimilarity === 'function') {
        similarity = getLevenshteinSimilarity(cleanResultTitle, cleanSearchTitle);
      } else {
        // Fallback simple
        similarity = cleanResultTitle.includes(cleanSearchTitle) || cleanSearchTitle.includes(cleanResultTitle) ? 0.9 : 0;
      }

      // Construire l'URL complète si nécessaire
      let fullUrl = href;
      if (fullUrl && !fullUrl.startsWith('http')) {
        fullUrl = fullUrl.startsWith('/') ? `${baseUrl}${fullUrl}` : `${baseUrl}/${fullUrl}`;
      }

      if (similarity >= 0.85 && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = fullUrl ? encodeURI(fullUrl) : fullUrl;
      }
    });

    return bestMatch;
  } catch (error) {
    const urlUsed = error.wiflixUrl || searchUrl;
    const proxyUsed = error.wiflixProxy || (ENABLE_WIFLIX_PROXY ? 'Aucun proxy (désactivé)' : 'Direct (sans proxy)');
    const proxiedUrl = error.wiflixProxiedUrl || urlUsed;

    return null;
  }
}

// Fonction pour extraire la date de sortie depuis une page Wiflix
function extractWiflixReleaseDate($) {
  try {
    // Pour les films et séries, chercher dans /html/body/div[1]/div/div/div/div/div/article/div[1]/div[2]/ul/li[2]/div[2]
    // Équivalent CSS: body > div:first-child > div > div > div > div > div > article > div:first-child > div:nth-child(2) > ul > li:nth-child(2) > div:nth-child(2)
    const releaseDateElement = $('body > div:first-child > div > div > div > div > div > article > div:first-child > div:nth-child(2) > ul > li:nth-child(2) > div:nth-child(2)');

    if (releaseDateElement.length > 0) {
      const dateText = releaseDateElement.text().trim();
      // Extraire l'année (4 chiffres consécutifs)
      const yearMatch = dateText.match(/(\d{4})/);
      if (yearMatch) {
        return parseInt(yearMatch[1]);
      }
    }

    // Fallback: chercher d'autres sélecteurs possibles pour la date
    const fallbackSelectors = [
      'div.mov-desc',
      '.mov-desc',
      'li:contains("Année") + li',
      'li:contains("Date") + li'
    ];

    for (const selector of fallbackSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        const text = element.text().trim();
        const yearMatch = text.match(/(\d{4})/);
        if (yearMatch) {
          return parseInt(yearMatch[1]);
        }
      }
    }

    return null;
  } catch (error) {
    console.error('[WIFLIX] Erreur lors de l\'extraction de la date:', error);
    return null;
  }
}

// Fonction pour extraire les lecteurs vidéo d'une page Wiflix
async function extractWiflixPlayers(pageUrl) {
  try {
    const response = await axiosWiflixRequest({
      url: pageUrl,
      method: 'GET'
    });

    const $ = cheerio.load(response.data);
    const players = [];

    // Extraire la date de sortie
    const releaseYear = extractWiflixReleaseDate($);


    // Vérifier si c'est une série (avec divs d'épisodes) ou un film
    const episodeDivs = $('div[class*="ep"][class*="vf"], div[class*="ep"][class*="vs"]');

    if (episodeDivs.length > 0) {
      // C'est une série - traiter les divs d'épisodes
      episodeDivs.each((index, element) => {
        const $episodeDiv = $(element);
        const episodeClass = $episodeDiv.attr('class');

        // Extraire le numéro d'épisode et le type (vf/vs)
        const episodeMatch = episodeClass.match(/ep(\d+)(vf|vs)/);
        if (episodeMatch) {
          const episodeNumber = parseInt(episodeMatch[1]);
          const type = episodeMatch[2] === 'vf' ? 'VF' : 'VOSTFR';

          // Chercher les liens dans ce div d'épisode
          $episodeDiv.find('a[onclick]').each((linkIndex, linkElement) => {
            const $link = $(linkElement);
            const onclick = $link.attr('onclick');
            const $span = $link.find('span.clichost');

            if (onclick && $span.length) {
              const match = onclick.match(/loadVideo\('(.+?)'\)/);
              if (match && match[1]) {
                const url = match[1];
                const name = $span.text().trim();

                // Traitement spécial pour certains lecteurs
                let processedUrl = url;
                if (url.includes('tipfly.xyz')) {
                  // Extraire l'ID depuis l'URL tipfly et le convertir en oneupload
                  const tipflyMatch = url.match(/tipfly\.xyz\/em-?\d+-(.+)/);
                  if (tipflyMatch && tipflyMatch[1]) {
                    processedUrl = `https://oneupload.net/embed-${tipflyMatch[1]}.html`;
                  }
                } else if (name.toLowerCase() === 'voe' || url.includes('jilliandescribecompany.com')) {
                  processedUrl = url.replace(/^https?:\/\/[^/]+/, 'https://voe.sx');
                }

                // Extraire le nom du domaine pour le nom du lecteur
                const domainMatch = processedUrl.match(/https?:\/\/(?:www\.)?([^\/]+)/);
                const domainName = domainMatch ? domainMatch[1] : name;

                players.push({
                  name: domainName,
                  url: processedUrl,
                  episode: episodeNumber,
                  type: type
                });

              }
            }
          });
        }
      });
    } else {
      // C'est un film - chercher directement dans les liens tabs-sel
      const filmLinks = $('.tabs-sel a[onclick]');

      filmLinks.each((index, element) => {
        const $link = $(element);
        const onclick = $link.attr('onclick');
        const $span = $link.find('span');

        if (onclick && $span.length) {
          const match = onclick.match(/loadVideo\('(.+?)'\)/);
          if (match && match[1]) {
            const url = match[1];
            const name = $span.text().trim();

            // Déterminer le type (VF ou VOSTFR) basé sur le nom
            let type = 'VF';
            if (name.toLowerCase().includes('vostfr')) {
              type = 'VOSTFR';
            }

            // Traitement spécial pour certains lecteurs
            let processedUrl = url;
            if (url.includes('tipfly.xyz')) {
              // Extraire l'ID depuis l'URL tipfly et le convertir en oneupload
              const tipflyMatch = url.match(/tipfly\.xyz\/em-?\d+-(.+)/);
              if (tipflyMatch && tipflyMatch[1]) {
                processedUrl = `https://oneupload.net/embed-${tipflyMatch[1]}.html`;
              }
            } else if (name.toLowerCase() === 'voe' || url.includes('jilliandescribecompany.com')) {
              processedUrl = url.replace(/^https?:\/\/[^/]+/, 'https://voe.sx');
            }

            // Extraire le nom du domaine pour le nom du lecteur
            const domainMatch = processedUrl.match(/https?:\/\/(?:www\.)?([^\/]+)/);
            const domainName = domainMatch ? domainMatch[1] : name;

            players.push({
              name: domainName,
              url: processedUrl,
              episode: 1, // Films n'ont qu'un seul "épisode"
              type: type
            });

          }
        }
      });
    }

    return {
      players: players,
      releaseYear: releaseYear
    };
  } catch (error) {
    return {
      players: [],
      releaseYear: null
    };
  }
}

// Fonction pour classer les lecteurs par langue
function categorizeWiflixPlayers(players) {
  const vf = [];
  const vostfr = [];

  players.forEach(player => {
    if (player.type === 'VOSTFR') {
      vostfr.push(player);
    } else {
      vf.push(player);
    }
  });

  return { vf, vostfr };
}
// Fonction pour faire des requêtes vers Wiflix
async function axiosWiflixRequest(config) {
  const urlStr = config.url || '';
  const isWiflix = urlStr.includes('https://flemmix.irish') || urlStr.includes('flemmix') ||
    (config.baseURL && (config.baseURL.includes('https://flemmix.irish') || config.baseURL.includes('flemmix')));


  if (!ENABLE_WIFLIX_PROXY || !isWiflix) {
    const defaultConfig = {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    };

    const finalConfig = { ...defaultConfig, ...config };

    try {
      const response = await axios(finalConfig);
      return response;
    } catch (error) {
      // Ajouter des informations sur l'URL utilisée à l'erreur
      error.wiflixUrl = config.url || urlStr;
      error.wiflixProxy = 'Direct (sans proxy)';
      error.wiflixProxiedUrl = config.url || urlStr;
      console.error(`[WIFLIX REQUEST] Erreur: ${error.message}`);
      throw error;
    }
  }

  // Construire l'URL complète
  let absoluteUrl = urlStr;
  if (config.baseURL && !urlStr.startsWith('http')) {
    absoluteUrl = config.baseURL + urlStr;
  } else if (!urlStr.startsWith('http')) {
    absoluteUrl = 'https://flemmix.irish' + (urlStr.startsWith('/') ? urlStr : '/' + urlStr);
  }

  // Filtrer les proxies disponibles (non en cooldown)
  const availableProxies = getAvailableProxies(CLOUDFLARE_WORKERS_PROXIES);

  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    ...(config.headers || {})
  };

  let lastError = null;

  // Essayer avec les proxies Cloudflare disponibles
  for (let i = 0; i < availableProxies.length; i++) {
    const cloudflareProxy = availableProxies[i];
    const proxiedUrl = buildProxiedUrl(cloudflareProxy, absoluteUrl);

    try {
      // Extraire url et headers de config pour éviter les conflits
      const { url: _, headers: __, ...restConfig } = config;
      const response = await axios({
        url: proxiedUrl,
        method: restConfig.method || 'GET',
        headers: defaultHeaders,
        timeout: restConfig.timeout || 15000,
        decompress: true,
        responseType: restConfig.responseType || 'text',
        ...restConfig
      });

      // Succès : marquer le proxy comme sain
      markProxyAsHealthy(cloudflareProxy);
      return response;
    } catch (error) {
      const statusCode = error.response?.status;
      const errorCode = statusCode || error.code || 'unknown';

      // Ajouter des informations sur l'URL et le proxy utilisé à l'erreur
      error.wiflixUrl = absoluteUrl;
      error.wiflixProxy = cloudflareProxy;
      error.wiflixProxiedUrl = proxiedUrl;
      lastError = error;

      // En cas d'erreur 429 (Too Many Requests), marquer le proxy et essayer le suivant
      if (statusCode === 429) {
        markProxyAsErrored(cloudflareProxy, 429);
        continue;
      }

      // En cas d'erreur 5xx, marquer le proxy et essayer le suivant
      if (statusCode >= 500 && statusCode < 600) {
        markProxyAsErrored(cloudflareProxy, statusCode);
        continue;
      }

      // En cas de timeout, marquer le proxy et essayer le suivant
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        markProxyAsErrored(cloudflareProxy, errorCode);
        continue;
      }

      // Pour les autres erreurs, throw immédiatement sans essayer d'autres proxies
      throw error;
    }
  }

  // Si on arrive ici, tous les proxies ont échoué
  if (lastError) throw lastError;
  throw new Error('Erreur inconnue lors de la requête Wiflix');
}

// Fonction pour récupérer les données d'un film Wiflix
async function fetchWiflixMovieData(tmdbId, cachedData = null) {
  try {
    // Récupérer les détails TMDB
    const frenchDetails = await axios.get(`${TMDB_API_URL}/movie/${tmdbId}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR'
      }
    });

    const originalDetails = await axios.get(`${TMDB_API_URL}/movie/${tmdbId}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR'
      }
    });

    if (!frenchDetails.data || !originalDetails.data) {
      // Si on avait un cache, le retourner au lieu de l'erreur
      if (cachedData) {
        console.log(`[WIFLIX] Cache préservé malgré l'erreur TMDB pour movie ${tmdbId}`);
        return cachedData;
      }
      return {
        success: false,
        error: 'Film non trouvé sur TMDB',
        tmdb_id: tmdbId
      };
    }

    const tmdbData = frenchDetails.data;
    const originalData = originalDetails.data;

    // Titres à essayer dans l'ordre
    const titlesToTry = [
      tmdbData.title, // Titre français
      originalData.original_title, // Titre original
      originalData.title // Titre international
    ].filter(Boolean).filter((title, index, arr) => arr.indexOf(title) === index);

    let movieUrl = null;

    // Essayer chaque titre
    for (const title of titlesToTry) {
      movieUrl = await searchWiflixMovie(title);
      if (movieUrl) {
        break;
      }
    }

    if (!movieUrl) {
      return {
        success: false,
        error: 'Film non trouvé sur Wiflix',
        tmdb_id: tmdbId,
        titles_tried: titlesToTry
      };
    }

    // Extraire les lecteurs vidéo et la date de sortie
    const extractionResult = await extractWiflixPlayers(movieUrl);
    const players = extractionResult.players;
    const wiflixReleaseYear = extractionResult.releaseYear;

    if (players.length === 0) {
      return {
        success: false,
        error: 'Aucun lecteur vidéo trouvé',
        tmdb_id: tmdbId,
        wiflix_url: movieUrl
      };
    }

    // Vérifier la correspondance des dates de sortie
    if (wiflixReleaseYear) {
      const tmdbReleaseYear = tmdbData.release_date ? new Date(tmdbData.release_date).getFullYear() : null;

      if (tmdbReleaseYear && wiflixReleaseYear !== tmdbReleaseYear) {
        console.log(`[WIFLIX MOVIE] Date mismatch: TMDB ${tmdbReleaseYear} vs Wiflix ${wiflixReleaseYear} pour ${tmdbData.title}`);
        return {
          success: false,
          error: 'Film non disponible sur Wiflix (date de sortie différente)',
          tmdb_id: tmdbId,
          wiflix_url: movieUrl,
          tmdb_release_year: tmdbReleaseYear,
          wiflix_release_year: wiflixReleaseYear
        };
      }
    }

    // Classer les lecteurs par langue
    const categorizedPlayers = categorizeWiflixPlayers(players);

    return {
      success: true,
      tmdb_id: tmdbId,
      title: tmdbData.title,
      original_title: originalData.original_title,
      wiflix_url: movieUrl,
      players: {
        vf: categorizedPlayers.vf,
        vostfr: categorizedPlayers.vostfr
      },
      cache_timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[WIFLIX MOVIE] Erreur dans fetchWiflixMovieData: ${error.message}`);
    // Si on avait un cache, le retourner au lieu de l'erreur
    if (cachedData) {
      console.log(`[WIFLIX] Cache préservé malgré l'erreur pour movie ${tmdbId}`);
      return cachedData;
    }
    // Sinon retourner une erreur
    return {
      success: false,
      error: 'Erreur lors de la récupération des données Wiflix',
      message: error.message,
      tmdb_id: tmdbId
    };
  }
}

// Route pour les films Wiflix
app.get('/api/wiflix/movie/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const cacheKey = generateCacheKey(`wiflix_movie_${tmdbId}`);
  const cacheDir = path.join(__dirname, 'cache', 'wiflix');

  try {
    // Créer le dossier de cache s'il n'existe pas
    await fsp.mkdir(cacheDir, { recursive: true });

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    let dataReturned = false;

    if (cachedData) {
      // console.log(`Film Wiflix pour TMDB ID "${tmdbId}" récupéré du cache`);
      res.status(200).json(cachedData); // Return cached data immediately
      dataReturned = true;

      // Vérifier si le cache a été mis à jour récemment (moins de 12 heures)
      const RECENT_UPDATE_THRESHOLD = 12 * 60 * 60 * 1000; // 12 heures en millisecondes
      const cachePath = path.join(cacheDir, `${cacheKey}.json`);
      let shouldSkipUpdate = false;

      try {
        const stats = await fsp.stat(cachePath);
        const timeSinceLastUpdate = Date.now() - stats.mtime.getTime();
        if (timeSinceLastUpdate < RECENT_UPDATE_THRESHOLD) {
          shouldSkipUpdate = true;
        }
      } catch (e) {
        // Fichier n'existe pas, continuer normalement
      }

      // Update cache in background only if not recently updated
      if (!shouldSkipUpdate) {
        updateWiflixCache(cacheDir, cacheKey, 'movie', tmdbId);
      }
    }

    // Si pas de données en cache, faire la requête normale
    if (!dataReturned) {
      const result = await fetchWiflixMovieData(tmdbId, null);

      // Sauvegarder en cache seulement si le résultat est valide
      // Ne pas mettre à jour le cache avec des erreurs
      if (result.success) {
        await saveToCache(cacheDir, cacheKey, result);
      } else {
        // Si échec et pas de cache, sauvegarder quand même pour éviter de refaire la requête
        await saveToCache(cacheDir, cacheKey, result);
      }

      if (!result.success) {
        return res.status(404).json(result);
      }

      res.json(result);
    }

  } catch (error) {
    console.error(`[WIFLIX MOVIE] Erreur: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des données Wiflix',
      message: error.message,
      tmdb_id: tmdbId
    });
  }
});

// Fonction pour récupérer les données Wiflix d'une série TV
async function fetchWiflixTvData(tmdbId, season, cachedData = null) {
  try {
    // Récupérer les détails TMDB de la série
    const frenchDetails = await axios.get(`${TMDB_API_URL}/tv/${tmdbId}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR'
      }
    });

    const originalDetails = await axios.get(`${TMDB_API_URL}/tv/${tmdbId}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR'
      }
    });

    // Récupérer les détails de la saison spécifique
    const seasonDetails = await axios.get(`${TMDB_API_URL}/tv/${tmdbId}/season/${season}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR'
      }
    });

    if (!frenchDetails.data || !originalDetails.data || !seasonDetails.data) {
      // Si on avait un cache, le retourner au lieu de l'erreur
      if (cachedData) {
        console.log(`[WIFLIX] Cache préservé malgré l'erreur TMDB pour tv ${tmdbId} saison ${season}`);
        return cachedData;
      }
      return {
        success: false,
        error: 'Série ou saison non trouvée sur TMDB',
        tmdb_id: tmdbId,
        season: season
      };
    }

    const tmdbData = frenchDetails.data;
    const originalData = originalDetails.data;
    const seasonData = seasonDetails.data;

    // Titres à essayer dans l'ordre
    const titlesToTry = [
      tmdbData.name, // Nom français
      originalData.original_name, // Nom original
      originalData.name // Nom international
    ].filter(Boolean).filter((title, index, arr) => arr.indexOf(title) === index);

    let seriesUrl = null;

    // Essayer chaque titre
    for (const title of titlesToTry) {
      seriesUrl = await searchWiflixMovie(`${title} saison ${season}`);
      if (seriesUrl) {
        break;
      }
    }

    if (!seriesUrl) {
      return {
        success: false,
        error: 'Série non trouvée sur Wiflix',
        tmdb_id: tmdbId,
        season: season,
        titles_tried: titlesToTry
      };
    }

    // Extraire les lecteurs vidéo et la date de sortie
    const extractionResult = await extractWiflixPlayers(seriesUrl);
    const players = extractionResult.players;
    const wiflixReleaseYear = extractionResult.releaseYear;

    if (players.length === 0) {
      return {
        success: false,
        error: 'Aucun lecteur vidéo trouvé',
        tmdb_id: tmdbId,
        season: season,
        wiflix_url: seriesUrl
      };
    }

    // Vérifier la correspondance des dates de sortie avec la saison spécifique
    if (wiflixReleaseYear) {
      // Utiliser la date de sortie de la saison spécifique au lieu de la série entière
      const tmdbReleaseYear = seasonData.air_date ? new Date(seasonData.air_date).getFullYear() : null;

      if (tmdbReleaseYear && wiflixReleaseYear !== tmdbReleaseYear) {
        console.log(`[WIFLIX TV] Date mismatch: TMDB Season ${season} (${tmdbReleaseYear}) vs Wiflix ${wiflixReleaseYear} pour ${tmdbData.name}`);
        return {
          success: false,
          error: 'Série non disponible sur Wiflix (date de sortie différente)',
          tmdb_id: tmdbId,
          season: season,
          wiflix_url: seriesUrl,
          tmdb_release_year: tmdbReleaseYear,
          wiflix_release_year: wiflixReleaseYear
        };
      }
    }

    // Organiser les lecteurs par épisode et par langue
    const episodes = {};

    players.forEach(player => {
      const episodeNum = player.episode;
      if (!episodes[episodeNum]) {
        episodes[episodeNum] = {
          vf: [],
          vostfr: []
        };
      }

      if (player.type === 'VOSTFR') {
        episodes[episodeNum].vostfr.push(player);
      } else {
        episodes[episodeNum].vf.push(player);
      }
    });

    return {
      success: true,
      tmdb_id: tmdbId,
      title: tmdbData.name,
      original_title: originalData.original_name,
      season: parseInt(season),
      wiflix_url: seriesUrl,
      episodes: episodes,
      cache_timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`[WIFLIX TV] Erreur: ${error.message}`);
    // Si on avait un cache, le retourner au lieu de l'erreur
    if (cachedData) {
      console.log(`[WIFLIX] Cache préservé malgré l'erreur pour tv ${tmdbId} saison ${season}`);
      return cachedData;
    }
    return {
      success: false,
      error: 'Erreur lors de la récupération des données Wiflix',
      message: error.message,
      tmdb_id: tmdbId,
      season: season
    };
  }
}

// Route pour les séries Wiflix
app.get('/api/wiflix/tv/:tmdbId/:season', async (req, res) => {
  const { tmdbId, season } = req.params;
  const cacheKey = generateCacheKey(`wiflix_tv_${tmdbId}_${season}`);
  const cacheDir = path.join(__dirname, 'cache', 'wiflix');

  try {
    // Créer le dossier de cache s'il n'existe pas
    await fsp.mkdir(cacheDir, { recursive: true });

    // Vérifier le cache sans expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    let dataReturned = false;

    if (cachedData) {
      // Retourner immédiatement les données en cache
      res.json(cachedData);
      dataReturned = true;

      // Vérifier si le cache a été mis à jour récemment (moins de 12 heures)
      const RECENT_UPDATE_THRESHOLD = 12 * 60 * 60 * 1000; // 12 heures en millisecondes
      const cachePath = path.join(cacheDir, `${cacheKey}.json`);
      let shouldSkipUpdate = false;

      try {
        const stats = await fsp.stat(cachePath);
        const timeSinceLastUpdate = Date.now() - stats.mtime.getTime();
        if (timeSinceLastUpdate < RECENT_UPDATE_THRESHOLD) {
          shouldSkipUpdate = true;
        }
      } catch (e) {
        // Fichier n'existe pas, continuer normalement
      }

      // Lancer la mise à jour en arrière-plan seulement si pas récemment mis à jour
      if (!shouldSkipUpdate) {
        updateWiflixCache(cacheDir, cacheKey, 'tv', tmdbId, season);
      }
    }

    // Si pas de données en cache, faire la requête normale
    if (!dataReturned) {
      const result = await fetchWiflixTvData(tmdbId, season, null);

      // Sauvegarder en cache seulement si le résultat est valide
      // Ne pas mettre à jour le cache avec des erreurs
      if (result.success) {
        await saveToCache(cacheDir, cacheKey, result);
      } else {
        // Si échec et pas de cache, sauvegarder quand même pour éviter de refaire la requête
        await saveToCache(cacheDir, cacheKey, result);
      }

      if (!result.success) {
        return res.status(404).json(result);
      }

      res.json(result);
    }

  } catch (error) {
    console.error(`[WIFLIX TV] Erreur: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des données Wiflix',
      message: error.message,
      tmdb_id: tmdbId,
      season: season
    });
  }
});


// ====================================================================
// === ADMIN ROUTES - GESTION DES LIENS DE STREAMING ET CLÉS VIP ===
// ====================================================================

// === ROUTES PUBLIQUES (sans authentification) ===

/**
 * GET /api/streaming-links/:type/:id
 * Récupérer les liens de streaming pour un film ou une série
 * Params: type (movie/tv), id (TMDB ID)
 * Query: season (optionnel pour les séries), episode (optionnel pour les séries)
 */
app.get('/api/links/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { season, episode } = req.query;

    // Validation
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    let query, params;

    if (type === 'movie') {
      query = 'SELECT id, links FROM films WHERE id = ?';
      params = [id];
    } else {
      // Pour les séries
      if (!season || !episode) {
        // Retourner tous les épisodes de la série
        query = 'SELECT id, series_id, season_number, episode_number, links FROM series WHERE series_id = ? ORDER BY season_number, episode_number';
        params = [id];
      } else {
        // Retourner un épisode spécifique
        query = 'SELECT id, series_id, season_number, episode_number, links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?';
        params = [id, parseInt(season), parseInt(episode)];
      }
    }

    const [rows] = await pool.execute(query, params);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Aucun lien trouvé',
        type,
        id,
        ...(season && { season }),
        ...(episode && { episode })
      });
    }

    // Parser les liens JSON
    const result = rows.map(row => ({
      ...row,
      links: typeof row.links === 'string' ? JSON.parse(row.links) : row.links
    }));

    res.json({
      success: true,
      type,
      data: type === 'movie' ? result[0] : result
    });

  } catch (error) {
    console.error('❌ Error fetching streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des liens',
      message: error.message
    });
  }
});

/**
 * POST /api/verify-access-code
 * Vérifier un code d'accès VIP (utilisé lors de la saisie initiale du code)
 * Body: { code: string }
 */
app.post('/api/verify-access-code', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        success: false,
        error: 'Code d\'accès requis'
      });
    }

    // Utiliser le module centralisé checkVip
    const vipStatus = await verifyAccessKey(code);

    if (!vipStatus.vip) {
      if (vipStatus.reason === 'key_expired') {
        return res.status(410).json({
          success: false,
          error: 'Code d\'accès expiré'
        });
      }
      if (vipStatus.reason === 'key_inactive') {
        return res.status(403).json({
          success: false,
          error: 'Code d\'accès désactivé'
        });
      }
      return res.status(404).json({
        success: false,
        error: 'Code d\'accès invalide ou expiré'
      });
    }

    return res.json({
      success: true,
      message: 'Code d\'accès valide',
      data: {
        key: code,
        duration: vipStatus.duration,
        expiresAt: vipStatus.expiresAt
      }
    });

  } catch (error) {
    console.error('❌ Error verifying access code:', error);
    return res.status(500).json({
      success: false,
      error: 'Erreur lors de la vérification du code d\'accès'
    });
  }
});

/**
 * GET /api/check-vip
 * Vérification côté serveur du statut VIP via le header x-access-key.
 * Appelé périodiquement par le frontend pour s'assurer que la clé est toujours valide.
 * Si la clé n'est plus valide, le frontend doit révoquer le statut VIP local.
 */
app.get('/api/check-vip', async (req, res) => {
  try {
    const accessKey = req.headers['x-access-key'];

    if (!accessKey) {
      return res.json({ vip: false, reason: 'no_key' });
    }

    const vipStatus = await verifyAccessKey(accessKey);

    return res.json({
      vip: vipStatus.vip,
      expiresAt: vipStatus.expiresAt || null,
      duration: vipStatus.duration || null,
      reason: vipStatus.reason || null
    });

  } catch (error) {
    console.error('❌ Error checking VIP status:', error);
    return res.status(500).json({ vip: false, error: 'Erreur interne' });
  }
});

// === ROUTES ADMIN (avec authentification) ===

/**
 * POST /api/admin/links
 * Ajouter ou mettre à jour des liens de streaming
 * Body: { type: 'movie'|'tv', id: string, links: array, season?: number, episode?: number }
 */
app.post('/api/admin/links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, links, season, episode } = req.body;

    // Validation
    if (!type || !id || !links || !Array.isArray(links)) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres invalides. Required: type, id, links (array)'
      });
    }

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    if (type === 'tv' && (season === undefined || season === null || episode === undefined || episode === null)) {
      return res.status(400).json({
        success: false,
        error: 'Pour les séries, season et episode sont requis'
      });
    }

    if (type === 'movie') {
      // Récupérer les liens existants
      const [existing] = await pool.execute(
        'SELECT links FROM films WHERE id = ?',
        [id]
      );

      let finalLinks = links;
      if (existing.length > 0 && existing[0].links) {
        // Parse existing links
        const existingLinks = typeof existing[0].links === 'string'
          ? JSON.parse(existing[0].links)
          : existing[0].links;

        // Merge with new links, avoiding duplicates
        const existingUrls = new Set(existingLinks.map(link =>
          typeof link === 'string' ? link : link.url || JSON.stringify(link)
        ));

        const newLinksToAdd = links.filter(link => {
          const url = typeof link === 'string' ? link : link.url || JSON.stringify(link);
          return !existingUrls.has(url);
        });

        finalLinks = [...existingLinks, ...newLinksToAdd];
      }

      const linksJson = JSON.stringify(finalLinks);

      // Insérer ou mettre à jour le film
      await pool.execute(
        'INSERT INTO films (id, links) VALUES (?, ?) ON DUPLICATE KEY UPDATE links = VALUES(links), updated_at = CURRENT_TIMESTAMP',
        [id, linksJson]
      );

      res.json({
        success: true,
        message: 'Liens de film ajoutés/mis à jour avec succès',
        type: 'movie',
        id,
        linksCount: finalLinks.length
      });

    } else {
      // Insérer ou mettre à jour l'épisode de série
      // Vérifier si l'épisode existe déjà
      const [existing] = await pool.execute(
        'SELECT id, links FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [id, season, episode]
      );

      let finalLinks = links;
      if (existing.length > 0 && existing[0].links) {
        // Parse existing links
        const existingLinks = typeof existing[0].links === 'string'
          ? JSON.parse(existing[0].links)
          : existing[0].links;

        // Merge with new links, avoiding duplicates
        const existingUrls = new Set(existingLinks.map(link =>
          typeof link === 'string' ? link : link.url || JSON.stringify(link)
        ));

        const newLinksToAdd = links.filter(link => {
          const url = typeof link === 'string' ? link : link.url || JSON.stringify(link);
          return !existingUrls.has(url);
        });

        finalLinks = [...existingLinks, ...newLinksToAdd];
      }

      const linksJson = JSON.stringify(finalLinks);

      if (existing.length > 0) {
        // Mise à jour
        await pool.execute(
          'UPDATE series SET links = ? WHERE series_id = ? AND season_number = ? AND episode_number = ?',
          [linksJson, id, season, episode]
        );
      } else {
        // Insertion
        await pool.execute(
          'INSERT INTO series (series_id, season_number, episode_number, links) VALUES (?, ?, ?, ?)',
          [id, season, episode, linksJson]
        );
      }

      res.json({
        success: true,
        message: 'Liens d\'épisode ajoutés/mis à jour avec succès',
        type: 'tv',
        id,
        season,
        episode,
        linksCount: finalLinks.length
      });
    }

  } catch (error) {
    console.error('❌ Error adding streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'ajout des liens',
      message: error.message
    });
  }
});
/**
 * DELETE /api/admin/streaming-links
 * Supprimer des liens de streaming
 * Body: { type: 'movie'|'tv', id: string, season?: number, episode?: number }
 */
app.delete('/api/admin/links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, season, episode } = req.body;

    // Validation
    if (!type || !id) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres invalides. Required: type, id'
      });
    }

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    if (type === 'movie') {
      const [result] = await pool.execute('DELETE FROM films WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Film non trouvé' });
      }

      res.json({
        success: true,
        message: 'Film supprimé avec succès',
        type: 'movie',
        id
      });

    } else {
      // Pour les séries
      let query, params;

      if (season && episode) {
        // Supprimer un épisode spécifique
        query = 'DELETE FROM series WHERE series_id = ? AND season_number = ? AND episode_number = ?';
        params = [id, season, episode];
      } else if (season) {
        // Supprimer toute une saison
        query = 'DELETE FROM series WHERE series_id = ? AND season_number = ?';
        params = [id, season];
      } else {
        // Supprimer toute la série
        query = 'DELETE FROM series WHERE series_id = ?';
        params = [id];
      }

      const [result] = await pool.execute(query, params);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Aucune donnée trouvée à supprimer' });
      }

      res.json({
        success: true,
        message: `${result.affectedRows} épisode(s) supprimé(s) avec succès`,
        type: 'tv',
        id,
        ...(season && { season }),
        ...(episode && { episode }),
        deletedCount: result.affectedRows
      });
    }

  } catch (error) {
    console.error('❌ Error deleting streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la suppression des liens',
      message: error.message
    });
  }
});

/**
 * PUT /api/admin/streaming-links
 * Modifier des liens de streaming (remplacer complètement)
 * Body: { type: 'movie'|'tv', id: string, links: array, season?: number, episode?: number }
 */
app.put('/api/admin/links', isUploaderOrAdmin, async (req, res) => {
  try {
    const { type, id, links, season, episode } = req.body;

    // Validation
    if (!type || !id || !links || !Array.isArray(links)) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres invalides. Required: type, id, links (array)'
      });
    }

    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    if (type === 'tv' && (season === undefined || season === null || episode === undefined || episode === null)) {
      return res.status(400).json({
        success: false,
        error: 'Pour les séries, season et episode sont requis'
      });
    }

    const linksJson = JSON.stringify(links);

    if (type === 'movie') {
      const [result] = await pool.execute(
        'UPDATE films SET links = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [linksJson, id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Film non trouvé' });
      }

      res.json({
        success: true,
        message: 'Liens de film modifiés avec succès',
        type: 'movie',
        id,
        linksCount: links.length
      });

    } else {
      const [result] = await pool.execute(
        'UPDATE series SET links = ? WHERE series_id = ? AND season_number = ? AND episode_number = ?',
        [linksJson, id, season, episode]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, error: 'Épisode non trouvé' });
      }

      res.json({
        success: true,
        message: 'Liens d\'épisode modifiés avec succès',
        type: 'tv',
        id,
        season,
        episode,
        linksCount: links.length
      });
    }

  } catch (error) {
    console.error('❌ Error updating streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la modification des liens',
      message: error.message
    });
  }
});

// === ROUTES ADMIN - GESTION DES CLÉS VIP ===

/**
 * GET /api/admin/check
 * Vérifier les droits d'administration (admin ou uploader)
 */
app.get('/api/admin/check', isUploaderOrAdmin, async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Droits d\'administration confirmés',
      admin: {
        userId: req.admin.userId,
        userType: req.admin.userType,
        adminId: req.admin.adminId,
        role: req.admin.role // Inclure le rôle dans la réponse
      }
    });
  } catch (error) {
    console.error('❌ Admin check error:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la vérification admin' });
  }
});

/**
 * GET /api/admin/vip-keys
 * Récupérer toutes les clés VIP
 * Query: active (optionnel, true/false), used (optionnel, true/false)
 */
app.get('/api/admin/vip-keys', isAdmin, async (req, res) => {
  try {
    const { active, used } = req.query;

    let query = 'SELECT * FROM access_keys';
    const conditions = [];
    const params = [];

    if (active !== undefined) {
      conditions.push('active = ?');
      params.push(active === 'true' ? 1 : 0);
    }

    if (used !== undefined) {
      conditions.push('used = ?');
      params.push(used === 'true' ? 1 : 0);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    const [rows] = await pool.execute(query, params);

    res.json({
      success: true,
      keys: rows,
      count: rows.length
    });

  } catch (error) {
    console.error('❌ Error fetching VIP keys:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des clés VIP',
      message: error.message
    });
  }
});

/**
 * POST /api/admin/vip-keys
 * Ajouter une nouvelle clé VIP
 * Body: { key: string, duree_validite?: string, expires_at?: string }
 */
app.post('/api/admin/vip-keys', isAdmin, async (req, res) => {
  try {
    const { key, duree_validite, expires_at } = req.body;

    // Validation
    if (!key || key.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'La clé est requise et ne peut pas être vide'
      });
    }

    if (key.length > 255) {
      return res.status(400).json({
        success: false,
        error: 'La clé ne peut pas dépasser 255 caractères'
      });
    }

    // Vérifier si la clé existe déjà
    const [existing] = await pool.execute(
      'SELECT key_value FROM access_keys WHERE key_value = ?',
      [key]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Cette clé existe déjà'
      });
    }

    // Calculer la date d'expiration si duree_validite est fournie
    let expiresAtValue = expires_at;

    if (duree_validite && !expires_at) {
      const now = new Date();
      const match = duree_validite.match(/(\d+)\s*(min|minute|minutes|h|hour|hours|heure|heures|d|day|days|jour|jours|m|month|months|mois|y|year|years|an|ans)/i);

      if (match) {
        const duration = parseInt(match[1]);
        const unit = match[2].toLowerCase();

        if (unit.startsWith('min')) {
          now.setMinutes(now.getMinutes() + duration);
        } else if (unit.startsWith('h')) {
          now.setHours(now.getHours() + duration);
        } else if (unit.startsWith('d') || unit.startsWith('j')) {
          now.setDate(now.getDate() + duration);
        } else if (unit.startsWith('m')) {
          now.setMonth(now.getMonth() + duration);
        } else if (unit.startsWith('y') || unit.startsWith('an')) {
          now.setFullYear(now.getFullYear() + duration);
        }

        expiresAtValue = now.toISOString().slice(0, 19).replace('T', ' ');
      }
    }

    // Insérer la nouvelle clé
    await pool.execute(
      'INSERT INTO access_keys (key_value, active, used, duree_validite, expires_at, created_at) VALUES (?, 1, 0, ?, ?, NOW())',
      [key, duree_validite || null, expiresAtValue || null]
    );

    // Invalider le cache VIP pour cette clé
    invalidateVipCache(key);

    res.status(201).json({
      success: true,
      message: 'Clé VIP créée avec succès',
      key: {
        key_value: key,
        duree_validite: duree_validite || null,
        expires_at: expiresAtValue || null,
        active: true,
        used: false
      }
    });

  } catch (error) {
    console.error('❌ Error adding VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'ajout de la clé VIP',
      message: error.message
    });
  }
});

/**
 * PUT /api/admin/vip-keys/:key
 * Modifier une clé VIP (expiration, durée, statut)
 * Body: { duree_validite?: string, expires_at?: string, active?: boolean, used?: boolean }
 */
app.put('/api/admin/vip-keys/:key', isAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { duree_validite, expires_at, active, used } = req.body;

    // Vérifier si la clé existe
    const [existing] = await pool.execute(
      'SELECT * FROM access_keys WHERE key_value = ?',
      [key]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Clé VIP non trouvée'
      });
    }

    // Construire la requête de mise à jour dynamiquement
    const updates = [];
    const params = [];

    if (duree_validite !== undefined) {
      updates.push('duree_validite = ?');
      params.push(duree_validite || null);

      // Si duree_validite est fournie, calculer la nouvelle date d'expiration
      if (duree_validite && expires_at === undefined) {
        const now = new Date();
        const match = duree_validite.match(/(\d+)\s*(min|minute|minutes|h|hour|hours|heure|heures|d|day|days|jour|jours|m|month|months|mois|y|year|years|an|ans)/i);

        if (match) {
          const duration = parseInt(match[1]);
          const unit = match[2].toLowerCase();

          if (unit.startsWith('min')) {
            now.setMinutes(now.getMinutes() + duration);
          } else if (unit.startsWith('h')) {
            now.setHours(now.getHours() + duration);
          } else if (unit.startsWith('d') || unit.startsWith('j')) {
            now.setDate(now.getDate() + duration);
          } else if (unit.startsWith('m')) {
            now.setMonth(now.getMonth() + duration);
          } else if (unit.startsWith('y') || unit.startsWith('an')) {
            now.setFullYear(now.getFullYear() + duration);
          }

          updates.push('expires_at = ?');
          params.push(now.toISOString().slice(0, 19).replace('T', ' '));
        }
      }
    }

    if (expires_at !== undefined) {
      updates.push('expires_at = ?');
      params.push(expires_at || null);
    }

    if (active !== undefined) {
      updates.push('active = ?');
      params.push(active ? 1 : 0);
    }

    if (used !== undefined) {
      updates.push('used = ?');
      params.push(used ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Aucune modification fournie'
      });
    }

    params.push(key);

    await pool.execute(
      `UPDATE access_keys SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE key_value = ?`,
      params
    );

    // Invalider le cache VIP pour cette clé
    invalidateVipCache(key);

    // Récupérer la clé mise à jour
    const [updated] = await pool.execute(
      'SELECT * FROM access_keys WHERE key_value = ?',
      [key]
    );

    res.json({
      success: true,
      message: 'Clé VIP modifiée avec succès',
      key: updated[0]
    });

  } catch (error) {
    console.error('❌ Error updating VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la modification de la clé VIP',
      message: error.message
    });
  }
});

/**
 * DELETE /api/admin/vip-keys/:key
 * Supprimer une clé VIP
 */
// Route pour supprimer un fichier de cache d'anime spécifique
app.get('/api/anime/cache/:cacheFile', async (req, res) => {
  try {
    const { cacheFile } = req.params;

    // Vérifier que le nom du fichier est valide (sécurité)
    if (!cacheFile || !cacheFile.endsWith('.json')) {
      return res.status(400).json({
        error: 'Nom de fichier invalide. Le fichier doit se terminer par .json'
      });
    }

    // Construire le chemin complet du fichier de cache
    const cacheFilePath = path.join(ANIME_SAMA_CACHE_DIR, cacheFile);

    // Vérifier que le fichier existe
    try {
      await fsp.access(cacheFilePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({
          error: 'Fichier de cache non trouvé',
          cacheFile: cacheFile
        });
      }
      throw error;
    }

    // Supprimer le fichier
    await fsp.unlink(cacheFilePath);

    console.log(`[ANIME-CACHE] Fichier de cache supprimé: ${cacheFile}`);

    res.json({
      success: true,
      message: 'Fichier de cache supprimé avec succès',
      cacheFile: cacheFile
    });

  } catch (error) {
    console.error('Erreur lors de la suppression du cache anime:', error);
    res.status(500).json({
      error: 'Erreur lors de la suppression du fichier de cache',
      details: error.message
    });
  }
});

app.delete('/api/admin/vip-keys/:key', isAdmin, async (req, res) => {
  try {
    const { key } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM access_keys WHERE key_value = ?',
      [key]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: 'Clé VIP non trouvée'
      });
    }

    // Invalider le cache VIP pour cette clé
    invalidateVipCache(key);

    res.json({
      success: true,
      message: 'Clé VIP supprimée avec succès',
      key
    });

  } catch (error) {
    console.error('❌ Error deleting VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la suppression de la clé VIP',
      message: error.message
    });
  }
});

// === ROUTE POUR TOUS LES LIENS DARKIWORLD ENHANCEMENT ===

/**
 * GET /api/darkiworld/enhancement/:type/:id
 * Récupérer tous les liens d'amélioration DarkiWorld pour un film ou un épisode
 * Params: type (movie/tv), id (TMDB ID)
 * Query: season (optionnel pour les séries), episode (optionnel pour les séries)
 */
app.get('/api/darkiworld/download/:type/:id', async (req, res) => {
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
        console.error('[ENHANCEMENT] Erreur lors de la récupération des liens pour le film:', err.message);
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
        console.error('[ENHANCEMENT] Erreur lors de la récupération des liens pour l\'épisode:', err.message);
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

// Fonction utilitaire pour récupérer toutes les entrées d'un épisode (pas seulement darkibox)
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
      console.error(`[ENHANCEMENT] Erreur lors de la recherche des liens (page ${page}):`, error.message);
      shouldContinue = false;
    }
  }

  return foundEntries;
}
/**
 * GET /api/darkiworld/decode/:id
 * Extraire le lien décodé (m3u8) pour un ID de lien DarkiWorld
 * Params: id (ID du lien DarkiWorld)
 */
app.get('/api/darkiworld/decode/:id', async (req, res) => {
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
          const linkResp = await axiosDarkinoRequest({
            method: 'post',
            url: `/api/v1/liens/${id}/download`
          });

          linkInfo = linkResp.data;
          provider = linkInfo?.host?.name || 'unknown';

          if (provider === 'darkibox') {
            embedUrl = `https://darkibox.com/embed-${id}.html`;
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
      return res.status(404).json({
        success: false,
        error: 'Lien non trouvé ou inaccessible',
        id: id
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

/**
 * GET /api/darkiworld/seasons/:titleId
 * Récupérer les saisons d'une série depuis DarkiWorld
 * Params: titleId (ID DarkiWorld de la série)
 * Query: page (optionnel, défaut: 1), perPage (optionnel, défaut: 8)
 */
app.get('/api/darkiworld/seasons/:titleId', async (req, res) => {
  let dataReturned = false;
  try {
    const { titleId } = req.params;
    const { page = 1, perPage = 8 } = req.query;

    if (!titleId) {
      return res.status(400).json({
        success: false,
        error: 'ID de la série requis'
      });
    }

    // Generate cache key
    const cacheKey = generateCacheKey(`darkiworld_seasons_${titleId}_${page}_${perPage}`);

    // Check if results are in cache without expiration (stale-while-revalidate)
    const cachedData = await getFromCacheNoExpiration(DOWNLOAD_CACHE_DIR, cacheKey);

    if (cachedData) {
      // console.log(`Saisons pour ${titleId} récupérées du cache`);
      res.status(200).json(cachedData); // Return cached data immediately
      dataReturned = true;
    }

    // Récupérer les saisons depuis DarkiWorld
    const seasonsResponse = await axiosDarkinoRequest({
      method: 'get',
      url: `/api/v1/titles/${titleId}/seasons?perPage=${perPage}&query=&page=${page}`
    });

    const responseData = {
      success: true,
      ...seasonsResponse.data
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
        if (seasonsResponse.data && seasonsResponse.data.pagination) {
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

/**
 * GET /api/darkiworld/episodes/:titleId/:seasonNumber
 * Récupérer les épisodes d'une saison depuis DarkiWorld
 * Params: titleId (ID DarkiWorld de la série), seasonNumber (numéro de la saison: 0, 1, 2, etc.)
 * Query: page (optionnel, défaut: 1), perPage (optionnel, défaut: 30)
 */
app.get('/api/darkiworld/episodes/:titleId/:seasonNumber', async (req, res) => {
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


// === VOIRDRAMA CONFIGURATION ===
const VOIRDRAMA_BASE_URL = 'https://voirdrama.org';

async function fetchDramaTvData(tmdbId, season, episode) {
  try {
    // 1. Get Series Name from TMDB
    const tmdbResponse = await axios.get(`${TMDB_API_URL}/tv/${tmdbId}`, {
      params: {
        api_key: TMDB_API_KEY,
        language: 'fr-FR',
        append_to_response: 'credits'
      }
    });

    const showName = tmdbResponse.data.name;
    const firstAirDate = tmdbResponse.data.first_air_date; // Format: YYYY-MM-DD

    // 2. Construct Search Query
    // Si c'est saison 1, tu prends le nom direct, si c'est saison 2, 3 etc, tu mets ex : Culinary Class Wars 2
    let searchQuery = showName;
    if (parseInt(season) > 1) {
      searchQuery += ` ${season}`;
    }

    // 3. Search on Voirdrama
    const formData = new URLSearchParams();
    formData.append('action', 'ajaxsearchpro_search');
    formData.append('aspp', searchQuery);
    formData.append('asid', '7');
    formData.append('asp_inst_id', '7_1');
    formData.append('options', 'aspf[vf__1]=vf&asp_gen[]=excerpt&asp_gen[]=content&asp_gen[]=title&filters_initial=1&filters_changed=0&qtranslate_lang=0&current_page_id=510');

    // Proxy handling for search - Utiliser proxy SOCKS5h comme demandé
    const proxy = pickRandomProxyOrNone();
    const agent = proxy ? getProxyAgent(proxy) : null;

    const axiosConfig = {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': VOIRDRAMA_BASE_URL
      },
      proxy: false
    };

    if (agent) {
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
    }

    const searchResponse = await axios.post(`${VOIRDRAMA_BASE_URL}/wp-admin/admin-ajax.php`, formData, axiosConfig);

    // 4. Parse Search Result
    const rawData = searchResponse.data;
    // Extract HTML part between markers
    // ___ASPSTART_HTML___ ... ___ASPEND_HTML___
    const htmlMatch = rawData.match(/___ASPSTART_HTML___([\s\S]*?)___ASPEND_HTML___/);

    if (!htmlMatch) {
      console.log('[VOIRDRAMA] Structure de réponse de recherche invalide ou pas de résultats HTML');
      return { success: false, error: 'Film/Série non trouvé sur Voirdrama' };
    }

    const $ = cheerio.load(htmlMatch[1]);

    let bestLink = null;
    let fallbackLink = $('div.asp_content h3 a.asp_res_url').first().attr('href');

    if (!firstAirDate) {
      bestLink = fallbackLink;
    } else {
      // Month map for parsing "Dec 12, 2025"
      const monthsMap = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
        'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
      };

      // Try to find a date match
      const candidates = [];
      $('div.item').each((i, el) => {
        const link = $(el).find('a.asp_res_url').attr('href');
        const dateText = $(el).find('.summary-content').text().trim();

        if (link) {
          candidates.push({ link, dateText });
        }
      });

      for (const candidate of candidates) {
        const { link, dateText } = candidate;
        let matched = false;

        // 1. Try to check date from search result if present
        if (dateText) {
          const parts = dateText.split(/[\s,]+/);
          if (parts.length >= 3) {
            const mStr = parts[0].substring(0, 3);
            const dStr = parts[1];
            const yStr = parts[2];
            const month = monthsMap[mStr];

            if (month && dStr && yStr) {
              const day = dStr.padStart(2, '0');
              const formattedDate = `${yStr}-${month}-${day}`;
              if (formattedDate === firstAirDate) {
                bestLink = link;
                matched = true;
              }
            }
          }
        }

        if (matched) break;

        // 2. If no match yet (or no dateText), fetch the page to check the date
        if (!bestLink) {
          try {
            // Determine proxy usage for this request
            const pageConfig = {
              headers: {
                'User-Agent': axiosConfig.headers['User-Agent']
              },
              proxy: false
            };
            if (agent) {
              pageConfig.httpAgent = agent;
              pageConfig.httpsAgent = agent;
            }

            const pageResponse = await axios.get(link, pageConfig);
            const $page = cheerio.load(pageResponse.data);

            let pageDateFound = false;

            $page('.summary-content').each((_, el) => {
              const txt = $(el).text().trim();
              // Try parsing this text
              const parts = txt.split(/[\s,]+/);
              if (parts.length >= 3) {
                const mStr = parts[0].substring(0, 3);
                const dStr = parts[1];
                const yStr = parts[2];
                const month = monthsMap[mStr];
                if (month && dStr && yStr) {
                  const day = dStr.padStart(2, '0');
                  const fDate = `${yStr}-${month}-${day}`;
                  if (fDate === firstAirDate) {
                    pageDateFound = true;
                    return false;
                  }
                }
              }
            });

            if (pageDateFound) {
              bestLink = link;
              break;
            }

          } catch (err) {
            // Check next candidate
          }
        }
      }
    }

    // Fallback if no specific date match found
    if (!bestLink) {
      return { success: false, error: 'Série non trouvée sur Voirdrama (Aucune date correspondante)' };
    }

    // 5. Construct Episode URL
    // Format: https://voirdrama.org/drama/slug/ -> https://voirdrama.org/drama/slug/slug-episode-vostfr/
    // Remove trailing slash if present
    const cleanLink = bestLink.replace(/\/$/, '');
    const slug = cleanLink.split('/').pop();

    const paddedEpisode = episode.toString().padStart(2, '0');
    // Note: User example had slug repeated: /slug/slug-01-vostfr/
    const episodeUrl = `${cleanLink}/${slug}-${paddedEpisode}-vostfr/`;

    // 6. Fetch Episode Page
    const episodeConfig = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
      proxy: false
    };

    if (agent) {
      episodeConfig.httpAgent = agent;
      episodeConfig.httpsAgent = agent;
    }

    const episodeResponse = await axios.get(episodeUrl, episodeConfig);

    // 7. Extract Sources
    const episodeHtml = episodeResponse.data;
    const sourcesMatch = episodeHtml.match(/var thisChapterSources = ({[\s\S]*?});/);

    if (!sourcesMatch) {
      return { success: false, error: 'Sources non trouvées sur la page de l\'épisode' };
    }

    const sourcesJson = JSON.parse(sourcesMatch[1]);
    const sources = [];

    for (const [key, value] of Object.entries(sourcesJson)) {
      // 1. Clean Name
      let name = key;
      try {
        name = JSON.parse(`"${key}"`); // Decode unicode if needed
      } catch (e) { }

      // Remove "☰", "LECTEUR", numbers and extra spaces
      name = name.replace(/[☰]/g, '').replace(/LECTEUR\s*\d+/i, '').trim();

      // Map common abbreviated names if possible
      if (name === 'VIDM') name = 'Vidmoly';
      if (name === 'RU') name = 'Ok.ru';
      if (name === 'VOE') name = 'Voe';
      if (name === 'UQLOAD') name = 'Uqload';
      if (name === 'UPSTREAM') name = 'Upstream';
      if (name === 'DOOD') name = 'Doodstream';


      // 2. Extract Link
      let url = null;

      // Look for iframe src specifically to avoid script tags
      const iframeMatch = value.match(/<iframe[^>]+src="([^"]+)"/i);
      if (iframeMatch) {
        url = iframeMatch[1];
      } else {
        // Fallback: try to find http links that look like video embeds
        const urlMatch = value.match(/https?:\/\/[^"\s']+/);
        if (urlMatch) {
          const candidate = urlMatch[0];
          // Exclude recaptcha, google api, and local admin-ajax
          if (!candidate.includes('google.com/recaptcha') && !candidate.includes('admin-ajax.php')) {
            url = candidate;
          }
        }
      }

      // 3. Filter and Add
      if (url) {
        sources.push({
          name: name,
          link: url,
          // raw: value // Optional: keep raw for debug if needed, but user didn't ask for it
        });
      }
    }

    return {
      success: true,
      data: sources,
      tmdbId: tmdbId,
      season: season,
      episode: episode
    };

  } catch (error) {
    console.error('[VOIRDRAMA] Error:', error.message);
    return { success: false, error: error.message };
  }
}

// Route /api/drama/:type/:tmdbid
// Options: season (saison), episode (episode)
app.get('/api/drama/:type/:tmdbid', async (req, res) => {
  const { type, tmdbid } = req.params;
  const { season, episode } = req.query;

  if (type !== 'tv') {
    return res.status(400).json({
      success: false,
      error: 'Ce point de terminaison ne supporte que type=tv pour le moment avec saison/episode'
    });
  }

  if (!season || !episode) {
    return res.status(400).json({
      success: false,
      error: 'Les paramètres ?season= et ?episode= sont requis.'
    });
  }

  const cacheKey = generateCacheKey(`voirdrama_${tmdbid}_${season}_${episode}`);
  const cacheDir = path.join(__dirname, 'cache', 'voirdrama');

  try {
    await fsp.mkdir(cacheDir, { recursive: true });

    // Stale-while-revalidate: return cached data immediately
    const cachedData = await getFromCacheNoExpiration(cacheDir, cacheKey);
    let dataReturned = false;

    if (cachedData) {
      // Return cached data immediately
      if (!cachedData.success) {
        res.status(404).json(cachedData);
      } else {
        res.json(cachedData);
      }
      dataReturned = true;

      // Background update if cache should be updated
      const shouldUpdate = await shouldUpdateCache24h(cacheDir, cacheKey);
      if (shouldUpdate) {
        // Background update (non-blocking)
        (async () => {
          try {
            const freshData = await fetchDramaTvData(tmdbid, season, episode);
            await saveToCache(cacheDir, cacheKey, freshData);
          } catch (bgError) {
            console.error(`[VOIRDRAMA] Background update error:`, bgError.message);
          }
        })();
      }
      return;
    }

    // No cache - fetch fresh data
    const result = await fetchDramaTvData(tmdbid, season, episode);

    // Save to cache (both success and error results)
    await saveToCache(cacheDir, cacheKey, result);

    if (!result.success) {
      return res.status(404).json(result);
    }

    res.json(result);

  } catch (error) {
    console.error('[API DRAMA] Error:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne',
      details: error.message
    });
  }
});

// Helper function to extract poster ID from Purstream large_poster_path
// e.g., "https://www.themoviedb.org/t/p/w600_and_h900_bestv2/xEx4dHi2IrTB0vkVPccrGrMcZQW.jpg"
// returns "/xEx4dHi2IrTB0vkVPccrGrMcZQW.jpg"
const extractPosterPathFromPurstream = (largePosterPath) => {
  if (!largePosterPath) return null;
  const match = largePosterPath.match(/\/([a-zA-Z0-9]+\.jpg)$/);
  return match ? `/${match[1]}` : null;
};

// Helper function to normalize date for comparison (YYYY-MM-DD or just YYYY)
const normalizeDate = (dateStr) => {
  if (!dateStr) return null;
  // Handle format like "2016-02-11 00:00:00" or "2016-02-11"
  const match = dateStr.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!match) return null;
  return {
    year: parseInt(match[1]),
    month: match[2] ? parseInt(match[2]) : null,
    day: match[3] ? parseInt(match[3]) : null,
    yearStr: match[1]
  };
};

// Helper function to normalize title for comparison
const normalizeTitle = (title) => {
  if (!title) return '';
  return title.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/[^a-z0-9\s]/g, '') // Remove special chars
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim();
};

// ============================
// === DRAGIV SOURCE (FILMS UNIQUEMENT) ===
// ============================

const DRAGIV_BASE = 'https://kimpav.com';
const DRAGIV_KEY = 'ph4p9rv4jpx7mg';

// Deduplication des requêtes Dragiv en cours
const ongoingDragivRequests = new Map();

const getOrCreateDragivRequest = async (cacheKey, requestFunction) => {
  if (ongoingDragivRequests.has(cacheKey)) {
    return ongoingDragivRequests.get(cacheKey);
  }
  const requestPromise = (async () => {
    try {
      return await requestFunction();
    } finally {
      ongoingDragivRequests.delete(cacheKey);
    }
  })();
  ongoingDragivRequests.set(cacheKey, requestPromise);
  return await requestPromise;
};

/**
 * Récupère la liste des films depuis Dragiv
 */
async function fetchDragivHomeMovies() {
  const homeUrl = `${DRAGIV_BASE}/${DRAGIV_KEY}/home/kimpav`;

  const response = await axios.get(homeUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': DRAGIV_BASE
    },
    timeout: 15000
  });

  const html = response.data;
  const movieRegex = /href="(\/ph4p9rv4jpx7mg\/b\/kimpav\/\d+)"[^>]*>([^<]+)/g;
  const matches = [...html.matchAll(movieRegex)];

  const movies = [];
  const seen = new Set();

  for (const match of matches) {
    const moviePath = match[1];
    const movieId = moviePath.split('/').pop();
    const title = match[2].trim();

    if (!seen.has(movieId)) {
      seen.add(movieId);
      movies.push({
        id: movieId,
        title: title,
        url: `${DRAGIV_BASE}${moviePath}`,
        path: moviePath
      });
    }
  }

  return movies;
}

/**
 * Récupère les sources d'un film Dragiv par son ID interne
 */
async function fetchDragivMovieData(movieId) {
  const movieUrl = `${DRAGIV_BASE}/${DRAGIV_KEY}/b/kimpav/${movieId}`;

  const response = await axios.get(movieUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `${DRAGIV_BASE}/${DRAGIV_KEY}/home/kimpav`
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

/**
 * Calcule un score de correspondance entre titres Dragiv
 * Utilise Jaccard similarity sur les mots pour éviter les faux positifs
 */
function calculateDragivMatchScore(dragivTitle, searchTitle, tmdbTitle, tmdbOriginalTitle) {
  const normalize = (str) => str.toLowerCase()
    .replace(/[:\-–—'"]/g, ' ')
    .replace(/[^\w\s\u00C0-\u024F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const removeYear = (str) => str.replace(/\(?\d{4}\)?$/, '').trim();
  const sequelTokenRegex = /^(\d+|i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i;
  const getSequelTokens = (str) => {
    if (!str) return new Set();
    return new Set(
      str
        .split(' ')
        .map(token => token.trim().toLowerCase())
        .filter(token => sequelTokenRegex.test(token))
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

// === ROUTE : Chercher un film Dragiv par TMDB ID ===
app.get('/api/dragiv/movie/:tmdbid', async (req, res) => {
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
    console.error('[DRAGIV API] Error:', error.message);
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// === ROUTE : Vider le cache Dragiv d'un film ===
app.get('/api/dragiv/movie/:tmdbid/clear-cache', async (req, res) => {
  const { tmdbid } = req.params;
  const cacheKey = generateCacheKey(`dragiv_movie_${tmdbid}`);
  const cacheFilePath = path.join(CACHE_DIR.DRAGIV, `${cacheKey}.json`);

  try {
    await fsp.unlink(cacheFilePath);
    console.log(`[DRAGIV Cache] Cache cleared for movie ${tmdbid}`);
    res.json({ success: true, message: `Cache cleared for movie ${tmdbid}` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: `No cache found for movie ${tmdbid}` });
    } else {
      console.error(`[DRAGIV Cache] Error clearing cache:`, error.message);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

/**
 * Cherche un film sur Dragiv à partir de son TMDB ID
 */
async function fetchDragivByTmdbId(tmdbId) {
  try {
    // 1. Récupérer les infos TMDB
    const tmdbApiKey = process.env.TMDB_API_KEY || 'feb30ec8227ccefb4502124a5af8dffa';
    const tmdbUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbApiKey}&language=fr-FR`;
    const tmdbResponse = await axios.get(tmdbUrl, { timeout: 10000 });
    const tmdbMovie = tmdbResponse.data;

    if (!tmdbMovie || !tmdbMovie.title) {
      return { success: false, error: 'TMDB movie not found', tmdb_id: tmdbId };
    }

    const year = tmdbMovie.release_date ? tmdbMovie.release_date.split('-')[0] : null;
    const searchTitle = year ? `${tmdbMovie.title} (${year})` : tmdbMovie.title;

    // 2. Récupérer la liste des films Dragiv
    const allMovies = await fetchDragivHomeMovies();

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
          console.warn(`[DRAGIV] Post-fetch title mismatch: page="${movieData.title}" vs tmdb="${tmdbMovie.title}" (score=${postFetchScore})`);
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
    console.error('[DRAGIV] fetchDragivByTmdbId error:', error.message);
    return { success: false, error: error.message, tmdb_id: tmdbId };
  }
}

/**
 * Background update du cache Dragiv
 */
async function updateDragivCache(cacheKey, tmdbid) {
  try {
    const newData = await fetchDragivByTmdbId(tmdbid);
    if (newData && newData.success) {
      await fsp.writeFile(path.join(CACHE_DIR.DRAGIV, `${cacheKey}.json`), JSON.stringify(newData), 'utf-8');
      console.log(`[DRAGIV Cache] Updated background cache for movie ${tmdbid}`);
    }
  } catch (error) {
    // Ne pas toucher au cache existant en cas d'erreur
  }
}

console.log('✅ DRAGIV source loaded (films only)');

// ===========================================================================================
// ===== FRANCE.TV (FTV) SOURCE — Recherche + épisodes d'une série/collection =====
// ===========================================================================================

const FTV_BASE = 'https://www.france.tv';

// --- FTV: Cache du next-action hash (TTL 30 min) ---
let ftvNextActionHash = null;
let ftvNextActionExpiry = 0;

// Headers complets pour simuler un vrai navigateur Chrome sur france.tv
const FTV_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Récupère dynamiquement le hash next-action depuis la page /recherche/
 * Ce hash change à chaque redéploiement de france.tv (Next.js Server Actions).
 * 
 * Étapes :
 * 1. GET https://www.france.tv/recherche/
 * 2. Trouver le <script src="/_next/static/chunks/app/recherche/page-XXXX.js">
 * 3. GET ce fichier JS
 * 4. Extraire le hash de createServerReference("HASH", ...)
 * 
 * Retente jusqu'à 3 fois en cas d'échec (connexion directe, sans proxy).
 */
async function getFtvNextActionHash() {
  const now = Date.now();
  if (ftvNextActionHash && now < ftvNextActionExpiry) {
    return ftvNextActionHash;
  }

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[FTV] Fetching next-action hash (attempt ${attempt}/${MAX_RETRIES}, direct) ...`);

    try {
      // Étape 1: Charger la page /recherche/
      const pageResponse = await axios.get(`${FTV_BASE}/recherche/`, {
        headers: { ...FTV_BROWSER_HEADERS },
        proxy: false,
        timeout: 15000,
        maxRedirects: 5,
      });

      const html = pageResponse.data;
      let hash = null;

      // Étape 2: Trouver le script chunk de la page recherche
      // Pattern: <script src="/_next/static/chunks/app/recherche/page-XXXX.js" async="">
      const scriptMatch = html.match(/<script[^>]+src="(\/_next\/static\/chunks\/app\/recherche\/page-[^"]+\.js)"/);
      
      if (scriptMatch) {
        const scriptUrl = `${FTV_BASE}${scriptMatch[1]}`;
        console.log(`[FTV] Found recherche chunk: ${scriptUrl}`);

        // Étape 3: Télécharger le fichier JS
        try {
          const jsResponse = await axios.get(scriptUrl, {
            headers: {
              'User-Agent': FTV_BROWSER_HEADERS['User-Agent'],
              'Accept': '*/*',
              'Accept-Language': 'fr-FR,fr;q=0.9',
              'Accept-Encoding': 'gzip, deflate, br, zstd',
              'Referer': `${FTV_BASE}/recherche/`,
              'Sec-Ch-Ua': FTV_BROWSER_HEADERS['Sec-Ch-Ua'],
              'Sec-Ch-Ua-Mobile': '?0',
              'Sec-Ch-Ua-Platform': '"Windows"',
              'Sec-Fetch-Dest': 'script',
              'Sec-Fetch-Mode': 'no-cors',
              'Sec-Fetch-Site': 'same-origin',
            },
            proxy: false,
            timeout: 15000,
          });

          const jsCode = jsResponse.data;

          // Étape 4: Extraire le hash de createServerReference("HASH", ...)
          const serverRefMatch = jsCode.match(/createServerReference\)\s*\(\s*"([a-f0-9]{40,})"/);
          if (serverRefMatch) {
            hash = serverRefMatch[1];
            console.log(`[FTV] Found next-action hash via createServerReference: ${hash}`);
          }

          // Fallback: chercher aussi le pattern searchAction
          if (!hash) {
            const searchActionMatch = jsCode.match(/"([a-f0-9]{40,})"[^]*?"searchAction"/);
            if (searchActionMatch) {
              hash = searchActionMatch[1];
              console.log(`[FTV] Found next-action hash via searchAction: ${hash}`);
            }
          }
        } catch (jsErr) {
          console.error(`[FTV] Error fetching JS chunk: ${jsErr.message}`);
        }
      } else {
        console.warn('[FTV] Could not find recherche page chunk script tag');
      }

      // Fallback: chercher directement dans le HTML
      if (!hash) {
        const actionIdMatch = html.match(/\$ACTION_ID_([a-f0-9]{40,})/);
        if (actionIdMatch) {
          hash = actionIdMatch[1];
          console.log(`[FTV] Found next-action hash via $ACTION_ID_ fallback: ${hash}`);
        }
      }

      if (hash) {
        ftvNextActionHash = hash;
        ftvNextActionExpiry = now + 30 * 60 * 1000; // Cache 30 min
        return hash;
      }

      console.warn(`[FTV] Attempt ${attempt}: could not extract hash from page content`);
    } catch (err) {
      console.error(`[FTV] Attempt ${attempt} failed (direct): ${err.response?.status || err.message}`);
      if (attempt < MAX_RETRIES) {
        // Petit délai avant de retry avec un autre proxy
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  console.warn('[FTV] Could not extract next-action hash after all retries');
  return null;
}

/**
 * POST /api/ftv/search
 * Body: { "query": "ninjago" }
 * Recherche sur france.tv et renvoie les programmes (séries/collections) et vidéos individuelles.
 */
app.post('/api/ftv/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, error: 'Le paramètre "query" est requis' });
    }

    const searchTerm = query.trim();

    // Check cache (1h expiration for search)
    const cacheKey = generateCacheKey(`ftv_search_${searchTerm.toLowerCase()}`);
    const cached = await getFromCacheWithExpiration(CACHE_DIR.FTV, cacheKey, 1);
    if (cached) {
      console.log(`[FTV] Search cache hit for "${searchTerm}"`);
      return res.json(cached);
    }

    // Récupérer dynamiquement le hash next-action (change à chaque déploiement de france.tv)
    const nextActionHash = await getFtvNextActionHash();
    if (!nextActionHash) {
      return res.status(502).json({ success: false, error: 'Impossible de récupérer le hash de recherche France.tv. Le site a peut-être changé.' });
    }

    console.log(`[FTV] Using next-action hash: ${nextActionHash}`);

    const response = await axios.post(`${FTV_BASE}/recherche/`, [searchTerm], {
      headers: {
        'accept': 'text/x-component',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': nextActionHash,
        'next-router-state-tree': '%5B%22%22%2C%7B%22children%22%3A%5B%22recherche%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
        'origin': FTV_BASE,
        'pragma': 'no-cache',
        'priority': 'u=1, i',
        'referer': `${FTV_BASE}/recherche/`,
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': FTV_BROWSER_HEADERS['User-Agent'],
      },
      proxy: false,
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log(`[FTV] Search response status: ${response.status}`);
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    console.log(`[FTV] Response text length: ${text.length}`);

    // Si 404, le hash a expiré entre-temps, forcer un refresh
    if (response.status === 404) {
      console.warn('[FTV] Got 404 — next-action hash is stale, invalidating cache...');
      ftvNextActionHash = null;
      ftvNextActionExpiry = 0;
      return res.json({ success: true, programs: [], videos: [], error_hint: 'Hash expiré, réessayez' });
    }

    // Parse RSC streaming format: lines like "1:{...json...}"
    const lines = text.split('\n');
    let searchData = null;
    for (const line of lines) {
      if (line.trim()) console.log(`[FTV] RSC Line prefix: ${line.substring(0, 10)}...`);
      // Chercher la ligne de données — peut commencer par 1:, 2:, etc.
      const dataMatch = line.match(/^(\d+):\s*(\{.+)/);
      if (dataMatch) {
        console.log(`[FTV] Found data line starting with ${dataMatch[1]}: (length ${line.length})`);
        try {
          const parsed = JSON.parse(dataMatch[2]);
          // Le résultat de recherche contient taxonomy et/ou video
          if (parsed.taxonomy || parsed.video) {
            searchData = parsed;
            console.log(`[FTV] Parsed success. Taxonomy items: ${parsed.taxonomy ? parsed.taxonomy.length : 0}, Videos: ${parsed.video ? parsed.video.length : 0}`);
            break;
          }
        } catch (e) {
          console.error(`[FTV] JSON Parse error on line ${dataMatch[1]}:: ${e.message}`);
        }
      }
    }

    if (!searchData) {
      console.log('[FTV] No searchData found in RSC response lines.');
      // Log premiers 500 chars pour debug
      console.log(`[FTV] Response preview: ${text.substring(0, 500)}`);
      return res.json({ success: true, programs: [], videos: [] });
    }

    // Extract programs from taxonomy array
    const programs = (searchData.taxonomy || [])
      .filter(item => item.content && item.content.url)
      .map(item => ({
        title: item.content.title || '',
        description: item.content.description || '',
        url: `${FTV_BASE}${item.content.url}`,
        thumbnail: item.content.thumbnail?.x2 || item.content.thumbnail?.x1 || null,
        type: item.content.type || 'program', // "program" or "collection"
        channel: item.content.channel || null,
        category: item.content.category?.label || null,
        program_id: item.tracking?.program_id || null,
      }));

    // Extract videos (individual episodes / films)
    const videos = (searchData.video || [])
      .filter(item => item.content && item.content.url)
      .map(item => ({
        title: item.content.title || '',
        titleLeading: item.content.titleLeading || '',
        description: item.content.description || '',
        url: `${FTV_BASE}${item.content.url}`,
        thumbnail: item.content.thumbnail?.x2 || item.content.thumbnail?.x1 || null,
        type: item.content.type || 'video',
        channel: item.content.channel || null,
        category: item.content.category?.label || null,
        id: item.content.id || null,
        season: item.content.title?.match(/^S(\d+)/)?.[1] || null,
        episode: item.content.title?.match(/E(\d+)/)?.[1] || null,
        csa: item.content.csa || null,
        caption: item.content.caption || null,
      }));

    console.log(`[FTV] Search results - Programs: ${programs.length}, Videos: ${videos.length}`);
    const searchResult = { success: true, programs, videos };
    await saveToCache(CACHE_DIR.FTV, cacheKey, searchResult);
    return res.json(searchResult);

  } catch (error) {
    console.error('[FTV] Search error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ftv/episodes?url=https://www.france.tv/france-3/lego-ninjago
 * Récupère la page d'un programme et extrait tous les épisodes disponibles.
 * Retourne la liste des épisodes avec leur URL d'extraction.
 */
app.get('/api/ftv/episodes', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !url.includes('france.tv')) {
      return res.status(400).json({ success: false, error: 'URL france.tv requise' });
    }

    // Check cache (4h expiration for episodes)
    const epCacheKey = generateCacheKey(`ftv_episodes_${url}`);
    const epCached = await getFromCacheWithExpiration(CACHE_DIR.FTV, epCacheKey, 4);
    if (epCached) {
      console.log(`[FTV] Episodes cache hit for ${url}`);
      return res.json(epCached);
    }

    const response = await axios.get(url, {
      headers: { ...FTV_BROWSER_HEADERS },
      proxy: false,
      timeout: 15000,
    });

    const html = response.data;
    const episodes = [];
    const seen = new Set();

    // Extract JSON data from self.__next_f.push() calls in the HTML
    const scriptRegex = /self\.__next_f\.push\(\[1,"(.*?)"\]\)/gs;
    let scriptMatch;
    let fullJsonText = '';

    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      // Unescape the string content
      let chunk = scriptMatch[1];
      try {
        // The content is JSON-escaped (\\", \\n, \\u00xx, etc.)
        chunk = JSON.parse(`"${chunk}"`);
      } catch { /* use as-is */ }
      fullJsonText += chunk;
    }

    // Find video objects within the extracted text
    // Pattern: objects with "url" containing france.tv path and "type":"video"
    const videoPattern = /"content"\s*:\s*\{[^}]*"url"\s*:\s*"(\/[^"]+\.html)"[^}]*"type"\s*:\s*"video"/g;
    let videoMatch;

    // More robust: find all JSON-like structures with video content
    // Scan for content objects that have a url ending in .html and type=video
    const contentBlockRegex = /\{"ariaLabel":\s*"[^"]*"[^]*?"content":\s*\{[^]*?"url":\s*"(\/[^"]+)"[^]*?"type":\s*"video"[^]*?\}[^]*?"variant":\s*"[^"]*"\}/g;
    
    // Simpler approach: find all url+title pairs from the JSON data
    // Look for patterns like: "url":"/france-3/lego-ninjago/saison-17/7075787-les-disparus.html"
    const urlTitleRegex = /"title"\s*:\s*"([^"]+)"[^]*?"titleLeading"\s*:\s*"([^"]*)"[^]*?"url"\s*:\s*"(\/[^"]+\.html)"|"url"\s*:\s*"(\/[^"]+\.html)"[^]*?"title"\s*:\s*"([^"]+)"/g;
    
    // Better: parse all the JSON chunks individually
    // Each push contains partial RSC data; some contain full JSON arrays / objects
    const allJsonChunks = [];
    const jsonArrayRegex = /\[[\s\S]*?\{[\s\S]*?"content"[\s\S]*?"url"[\s\S]*?\}[\s\S]*?\]/g;
    
    // Actually, let's use a targeted regex to extract episode data
    // from the full text blob. Each video entry looks like:
    // "title":"S17 E11 - Les drainés","titleLeading":"Ninjago"..."url":"/france-3/lego-ninjago/saison-17/7452542-les-draines.html"..."type":"video"
    
    // Collect all .html URLs that are episode links
    const episodeUrlRegex = /("url"\s*:\s*")(\/[^"]+\/(\d+)-[^"]+\.html)(")/g;
    const titleRegex = /"title"\s*:\s*"([^"]+)"/g;
    const titleLeadingRegex = /"titleLeading"\s*:\s*"([^"]+)"/g;
    const descRegex = /"description"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/g;
    const thumbRegex1 = /"x2"\s*:\s*"(https:\/\/medias\.france\.tv\/[^"]+)"/g;
    const idRegex = /"id"\s*:\s*(\d{4,})/g;
    
    // Most reliable: extract via Cheerio + script parsing
    const $ = cheerio.load(html);
    
    // Gather ALL text from __next_f scripts  
    let allScriptData = '';
    $('script').each((_, el) => {
      const raw = $(el).html() || '';
      if (raw.includes('__next_f')) {
        const pushMatch = raw.match(/self\.__next_f\.push\(\[1,"(.*)"\]\)/s);
        if (pushMatch) {
          try {
            allScriptData += JSON.parse(`"${pushMatch[1]}"`);
          } catch {
            allScriptData += pushMatch[1];
          }
        }
      }
    });

    // Now parse the concatenated text to find video objects
    // Split by "variant" which marks the end of each card object
    const cardChunks = allScriptData.split('"variant"');
    
    for (const chunk of cardChunks) {
      // Check if this chunk has a video-type content with a .html URL
      if (!chunk.includes('"type":"video"') && !chunk.includes('"type": "video"')) continue;
      
      const urlMatch = chunk.match(/"url"\s*:\s*"(\/[^"]+\.html)"/);
      if (!urlMatch) continue;
      
      const epUrl = urlMatch[1];
      if (seen.has(epUrl)) continue;
      seen.add(epUrl);
      
      // Extract fields from this chunk
      const titleMatch = chunk.match(/"title"\s*:\s*"([^"]+)"/);
      const leadMatch = chunk.match(/"titleLeading"\s*:\s*"([^"]+)"/);
      const descMatch = chunk.match(/"description"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
      const thumbMatch = chunk.match(/"x2"\s*:\s*"(https:\/\/medias\.france\.tv\/[^"]+)"/);
      const idMatch = chunk.match(/"id"\s*:\s*(\d{4,})/);
      const csaMatch = chunk.match(/"csa"\s*:\s*"([^"]+)"/);
      
      const title = titleMatch ? titleMatch[1] : '';
      const seasonMatch = title.match(/^S(\d+)/);
      const episodeMatch = title.match(/E(\d+)/);
      
      let desc = descMatch ? descMatch[1] : '';
      try { desc = JSON.parse(`"${desc}"`); } catch { /* use as-is */ }
      
      episodes.push({
        title: title,
        program: leadMatch ? leadMatch[1] : '',
        description: desc,
        url: `${FTV_BASE}${epUrl}`,
        thumbnail: thumbMatch ? thumbMatch[1] : null,
        id: idMatch ? parseInt(idMatch[1]) : null,
        season: seasonMatch ? parseInt(seasonMatch[1]) : null,
        episode: episodeMatch ? parseInt(episodeMatch[1]) : null,
        csa: csaMatch ? csaMatch[1] : null,
      });
    }

    // Sort by season then episode
    episodes.sort((a, b) => {
      if (a.season !== b.season) return (a.season || 0) - (b.season || 0);
      return (a.episode || 0) - (b.episode || 0);
    });

    const episodesResult = {
      success: true,
      program_url: url,
      total: episodes.length,
      episodes,
    };
    await saveToCache(CACHE_DIR.FTV, epCacheKey, episodesResult);
    return res.json(episodesResult);

  } catch (error) {
    console.error('[FTV] Episodes error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/ftv/info?url=https://www.france.tv/france-5/le-monde-de-jamy/...
 * Récupère les informations d'une page film (player) ou série (programme).
 * Détecte automatiquement le type de page et retourne les données structurées.
 */
app.get('/api/ftv/info', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !url.includes('france.tv')) {
      return res.status(400).json({ success: false, error: 'URL france.tv requise' });
    }

    // Check cache (4h expiration for info)
    const infoCacheKey = generateCacheKey(`ftv_info_${url}`);
    const infoCached = await getFromCacheWithExpiration(CACHE_DIR.FTV, infoCacheKey, 4);
    if (infoCached) {
      console.log(`[FTV] Info cache hit for ${url}`);
      return res.json(infoCached);
    }

    const response = await axios.get(url, {
      headers: { ...FTV_BROWSER_HEADERS },
      proxy: false,
      timeout: 15000,
    });

    const html = response.data;

    // ---- Extract all RSC data from self.__next_f.push() calls ----
    const pushRegex = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
    let allRscText = '';
    let pushMatch;
    while ((pushMatch = pushRegex.exec(html)) !== null) {
      let chunk = pushMatch[1];
      try { chunk = JSON.parse(`"${chunk}"`); } catch { /* use as-is */ }
      allRscText += chunk;
    }

    // ---- Detect page type ----
    const isPlayer = /"pageType"\s*:\s*"player"/.test(allRscText) || /data-template-id="player-replay"/.test(html);
    const isProgramme = /"pageType"\s*:\s*"programme"/.test(allRscText) || /data-template-id="programme"/.test(html);

    if (isPlayer) {
      // ===== FILM / VIDEO PAGE =====
      const result = { success: true, type: 'video' };

      // Extract title - try JSON-LD VideoObject first
      const ldJsonRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
      let ldMatch;
      while ((ldMatch = ldJsonRegex.exec(html)) !== null) {
        try {
          const ld = JSON.parse(ldMatch[1]);
          if (ld['@type'] === 'VideoObject') {
            result.title = ld.name || '';
            result.description = ld.description || '';
            result.thumbnail = (ld.thumbnailUrl && ld.thumbnailUrl[0]) || '';
            result.duration = ld.duration || '';
            result.director = ld.director ? (ld.director.name || ld.director) : '';
            result.uploadDate = ld.uploadDate || '';
            result.expires = ld.expires || '';
            break;
          }
        } catch { /* skip invalid JSON-LD */ }
      }

      // Extract additional fields from RSC data
      const csaMatch = allRscText.match(/"csaCode"\s*:\s*"([^"]+)"/);
      result.csa = csaMatch ? csaMatch[1] : null;

      const channelMatch = allRscText.match(/"broadcastChannel"\s*:\s*"([^"]+)"/);
      result.channel = channelMatch ? channelMatch[1] : null;
      if (!result.channel) {
        const ch2 = allRscText.match(/"channel"\s*:\s*"([^"]+)"/);
        result.channel = ch2 ? ch2[1] : null;
      }

      // Extract title from RSC if not from JSON-LD
      if (!result.title) {
        const titleMatch = allRscText.match(/"pageName"\s*:\s*"([^"]+)"/);
        result.title = titleMatch ? titleMatch[1].replace(/_/g, ' ') : '';
      }

      // Extract description from RSC if not from JSON-LD
      if (!result.description) {
        const descMatch = allRscText.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (descMatch) {
          try { result.description = JSON.parse(`"${descMatch[1]}"`); }
          catch { result.description = descMatch[1]; }
        }
      }

      // Extract thumbnail from RSC if not from JSON-LD
      if (!result.thumbnail) {
        const thumbMatch = allRscText.match(/"vignette_16x9"[^}]*?"1800"\s*:\s*"([^"]+)"/);
        result.thumbnail = thumbMatch ? thumbMatch[1] : null;
        if (!result.thumbnail) {
          const thumbAlt = allRscText.match(/https:\/\/medias\.france\.tv\/[^"]+\.jpg/);
          result.thumbnail = thumbAlt ? thumbAlt[0] : null;
        }
      }

      // Extract duration in seconds from RSC if available
      const durationSecMatch = allRscText.match(/"duration"\s*:\s*(\d{2,})/);
      result.durationSeconds = durationSecMatch ? parseInt(durationSecMatch[1]) : null;

      // Extract program name
      const progMatch = allRscText.match(/"programName"\s*:\s*"([^"]+)"/);
      result.program = progMatch ? progMatch[1].replace(/_/g, ' ') : null;

      // Extract categories
      const catMatch = allRscText.match(/"categories"\s*:\s*\["([^"]+)"\]/);
      result.category = catMatch ? catMatch[1] : null;

      await saveToCache(CACHE_DIR.FTV, infoCacheKey, result);
      return res.json(result);
    } else if (isProgramme) {
      // ===== SÉRIE / PROGRAMME PAGE =====
      const result = { success: true, type: 'programme' };

      // Extract programme title from <title> tag or RSC  
      const titleTagMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
      result.title = titleTagMatch ? titleTagMatch[1].replace(/ - (Regarder|France \d|France\.tv).*$/i, '').trim() : '';

      // Extract description
      const metaDescMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
      result.description = metaDescMatch ? metaDescMatch[1] : '';

      // Try to get full description from RSC if meta one is truncated
      if (result.description.endsWith('...') || result.description.endsWith('…') || result.description.length < 150) {
        const rscDescMatch = allRscText.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (rscDescMatch) {
          try { 
            const parsedDesc = JSON.parse(`"${rscDescMatch[1]}"`);
            if (parsedDesc.length > result.description.length) {
              result.description = parsedDesc;
            }
          } catch { 
            if (rscDescMatch[1].length > result.description.length) {
              result.description = rscDescMatch[1];
            }
          }
        }
      }

      // Extract thumbnail from og:image  
      const ogImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
      result.thumbnail = ogImageMatch ? ogImageMatch[1] : null;

      // Extract channel
      const channelMatch = allRscText.match(/"channel"\s*:\s*"([^"]+)"/);
      result.channel = channelMatch ? channelMatch[1] : null;

      // Extract program_id
      const progIdMatch = allRscText.match(/"program_id"\s*:\s*"(\d+)"/);
      result.programId = progIdMatch ? progIdMatch[1] : null;

      // Extract category
      const catMatch = allRscText.match(/"category"\s*:\s*"([^"]+)"/);
      result.category = catMatch ? catMatch[1] : null;

      // ---- Extract cast/crew from RSC text ----
      const directorMatch = allRscText.match(/Réalisé par\s*:\s*([^"\\]+)/);
      result.director = directorMatch ? directorMatch[1].trim() : null;

      const castMatch = allRscText.match(/Avec\s*:\s*([^"\\]+)/);
      result.cast = castMatch ? castMatch[1].trim() : null;

      // ---- Extract seasons and episodes ----
      const seasons = [];
      const $ = cheerio.load(html);

      // Gather ALL text from __next_f scripts
      let allScriptData = '';
      $('script').each((_, el) => {
        const raw = $(el).html() || '';
        if (raw.includes('__next_f')) {
          const pm = raw.match(/self\.__next_f\.push\(\[1,"(.*)"\]\)/s);
          if (pm) {
            try { allScriptData += JSON.parse(`"${pm[1]}"`); }
            catch { allScriptData += pm[1]; }
          }
        }
      });

      // Find seasonsMap data - look for array of [seasonName, {contents, href}]
      // The seasonsMap is encoded in RSC chunks as arrays of tuples
      const seasonRegex = /\[\s*"(Saison\s+\d+)"[^]*?"contents"\s*:\s*\[([\s\S]*?)\]\s*,\s*"href"\s*:\s*"([^"]+)"\s*\}/g;
      let seasonMatch;

      // More robust approach: split by "Saison" markers and extract episode blocks
      const seasonSplits = allScriptData.split(/(?=\["Saison\s+\d+")/);

      for (const block of seasonSplits) {
        const nameMatch = block.match(/^\["(Saison\s+\d+)"/);
        if (!nameMatch) continue;

        const seasonName = nameMatch[1];
        const seasonNum = parseInt(seasonName.match(/\d+/)[0]);
        const episodes = [];
        const seen = new Set();

        // Split by "variant" to find individual episode cards
        const cardChunks = block.split('"variant"');

        for (const chunk of cardChunks) {
          if (!chunk.includes('"type":"video"')) continue;

          const urlMatch = chunk.match(/"url"\s*:\s*"(\/[^"]+\.html)"/);
          if (!urlMatch) continue;

          const epUrl = urlMatch[1];
          if (seen.has(epUrl)) continue;
          seen.add(epUrl);

          const titleMatch = chunk.match(/"title"\s*:\s*"([^"]+)"/);
          const leadMatch = chunk.match(/"titleLeading"\s*:\s*"([^"]+)"/);
          const descMatch = chunk.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const thumbMatch = chunk.match(/"x2"\s*:\s*"(https:\/\/[^"]+)"/);
          const idMatch = chunk.match(/"content_id"\s*:\s*(\d+)/);
          if (!idMatch) {
            var idMatch2 = chunk.match(/"id"\s*:\s*(\d{4,})/);
          }
          const csaMatch = chunk.match(/"csa"\s*:\s*"([^"]+)"/);
          const durationMatch = chunk.match(/"duration"\s*:\s*"([^"]+)"/);
          const vfIdMatch = chunk.match(/"video_factory_id"\s*:\s*"([0-9a-f-]{36})"/);

          const title = titleMatch ? titleMatch[1] : '';
          const epNumMatch = title.match(/E(\d+)/);

          let desc = descMatch ? descMatch[1] : '';
          try { desc = JSON.parse(`"${desc}"`); } catch { /* use as-is */ }

          episodes.push({
            title,
            program: leadMatch ? leadMatch[1] : '',
            description: desc,
            url: `${FTV_BASE}${epUrl}`,
            thumbnail: thumbMatch ? thumbMatch[1] : null,
            contentId: (idMatch ? parseInt(idMatch[1]) : (idMatch2 ? parseInt(idMatch2[1]) : null)),
            videoId: vfIdMatch ? vfIdMatch[1] : null,
            season: seasonNum,
            episode: epNumMatch ? parseInt(epNumMatch[1]) : null,
            csa: csaMatch ? csaMatch[1] : null,
            duration: durationMatch ? durationMatch[1] : null,
          });
        }

        // Sort episodes by episode number
        episodes.sort((a, b) => (a.episode || 0) - (b.episode || 0));

        if (episodes.length > 0) {
          seasons.push({
            name: seasonName,
            number: seasonNum,
            episodeCount: episodes.length,
            episodes,
          });
        }
      }

      // If no seasons found with the split approach, try the card-based approach from /episodes
      if (seasons.length === 0) {
        const episodes = [];
        const seen = new Set();
        const cardChunks = allScriptData.split('"variant"');

        for (const chunk of cardChunks) {
          if (!chunk.includes('"type":"video"')) continue;
          const urlMatch = chunk.match(/"url"\s*:\s*"(\/[^"]+\.html)"/);
          if (!urlMatch) continue;
          const epUrl = urlMatch[1];
          if (seen.has(epUrl)) continue;
          seen.add(epUrl);

          const titleMatch = chunk.match(/"title"\s*:\s*"([^"]+)"/);
          const leadMatch = chunk.match(/"titleLeading"\s*:\s*"([^"]+)"/);
          const descMatch = chunk.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const thumbMatch = chunk.match(/"x2"\s*:\s*"(https:\/\/[^"]+)"/);
          const idMatch = chunk.match(/"content_id"\s*:\s*(\d+)/) || chunk.match(/"id"\s*:\s*(\d{4,})/);
          const vfIdMatch = chunk.match(/"video_factory_id"\s*:\s*"([0-9a-f-]{36})"/);
          const durationMatch = chunk.match(/"duration"\s*:\s*"([^"]+)"/);
          const csaMatch = chunk.match(/"csa"\s*:\s*"([^"]+)"/);
          const title = titleMatch ? titleMatch[1] : '';

          let desc = descMatch ? descMatch[1] : '';
          try { desc = JSON.parse(`"${desc}"`); } catch {}

          const seasonMatch = title.match(/S(\d+)/);
          const epMatch = title.match(/E(\d+)/);

          episodes.push({
            title,
            program: leadMatch ? leadMatch[1] : '',
            description: desc,
            url: `${FTV_BASE}${epUrl}`,
            thumbnail: thumbMatch ? thumbMatch[1] : null,
            contentId: idMatch ? parseInt(idMatch[1]) : null,
            videoId: vfIdMatch ? vfIdMatch[1] : null,
            season: seasonMatch ? parseInt(seasonMatch[1]) : null,
            episode: epMatch ? parseInt(epMatch[1]) : null,
            csa: csaMatch ? csaMatch[1] : null,
            duration: durationMatch ? durationMatch[1] : null,
          });
        }

        if (episodes.length > 0) {
          // Group by season
          const seasonMap = {};
          for (const ep of episodes) {
            const sNum = ep.season || 1;
            if (!seasonMap[sNum]) seasonMap[sNum] = [];
            seasonMap[sNum].push(ep);
          }
          for (const [sNum, eps] of Object.entries(seasonMap)) {
            eps.sort((a, b) => (a.episode || 0) - (b.episode || 0));
            seasons.push({
              name: `Saison ${sNum}`,
              number: parseInt(sNum),
              episodeCount: eps.length,
              episodes: eps,
            });
          }
          seasons.sort((a, b) => a.number - b.number);
        }
      }

      result.seasons = seasons;
      result.totalEpisodes = seasons.reduce((sum, s) => sum + s.episodeCount, 0);

      await saveToCache(CACHE_DIR.FTV, infoCacheKey, result);
      return res.json(result);

    } else {
      // Unknown page type
      return res.json({
        success: false,
        error: 'Type de page non reconnu (ni player ni programme)',
        hint: 'Vérifiez que l\'URL pointe vers un film/vidéo ou une série sur france.tv',
      });
    }

  } catch (error) {
    console.error('[FTV] Info error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

console.log('✅ FTV (france.tv) source loaded');
