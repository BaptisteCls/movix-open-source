/**
 * Safe file read/write operations with Redis distributed locking and atomic writes.
 * Extracted from server.js — provides safeWriteFile, safeWriteJsonFile, safeReadJsonFile.
 */

const fsp = require('fs').promises;
const path = require('path');
const writeFileAtomic = require('write-file-atomic');
const { acquireRedisLock } = require('./redisLock');

// ===== FONCTIONS SECURISEES POUR LES ECRITURES DE FICHIERS =====

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

module.exports = { safeWriteFile, safeWriteJsonFile, safeReadJsonFile };
