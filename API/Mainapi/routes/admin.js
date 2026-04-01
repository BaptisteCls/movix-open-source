/**
 * Admin routes.
 * Extracted from server.js -- streaming links CRUD, VIP key management, admin checks, anime cache.
 * Mount point: app.use('/api', router)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fsp = require('fs').promises;
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const { isAdmin, isUploaderOrAdmin } = require('../middleware/auth');
const { getPool } = require('../mysqlPool');
const { verifyAccessKey, invalidateVipCache } = require('../checkVip');
const { ANIME_SAMA_CACHE_DIR } = require('../utils/cacheManager');
const { createRedisRateLimitStore } = require('../utils/redisRateLimitStore');

function parseAccessKeyExpiresAt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const normalizedValue = String(value).trim();
  if (!normalizedValue) {
    return null;
  }

  if (/^\d+$/.test(normalizedValue)) {
    return Number(normalizedValue);
  }

  const parsed = new Date(
    normalizedValue.includes('T')
      ? normalizedValue
      : normalizedValue.replace(' ', 'T')
  );
  const timestamp = parsed.getTime();

  if (!Number.isFinite(timestamp)) {
    throw new Error('Date d\'expiration invalide');
  }

  return timestamp;
}

function buildAccessKeyExpiryFromDuration(durationLabel) {
  if (!durationLabel) {
    return null;
  }

  const now = new Date();
  const match = durationLabel.match(/(\d+)\s*(min|minute|minutes|h|hour|hours|heure|heures|d|day|days|jour|jours|m|month|months|mois|y|year|years|an|ans)/i);

  if (!match) {
    return null;
  }

  const duration = parseInt(match[1], 10);
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

  return now.getTime();
}

// Rate limiter pour la vérification de codes VIP
// 5 tentatives par IP toutes les 15 minutes (plus strict car code bruteforceable)
const vipCodeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  store: createRedisRateLimitStore({ prefix: 'rate-limit:admin:vip-code-check:' }),
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Trop de tentatives de vérification. Réessayez dans 15 minutes.'
  },
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || ipKeyGenerator(req.ip),
  validate: { xForwardedForHeader: false, ip: false }
});

// === PUBLIC ROUTES (no authentication) ===

/**
 * GET /links/:type/:id
 * Retrieve streaming links for a movie or series
 * Params: type (movie/tv), id (TMDB ID)
 * Query: season (optional for series), episode (optional for series)
 */
router.get('/links/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { season, episode } = req.query;

    // Validation
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Type invalide. Utilisez "movie" ou "tv"' });
    }

    const pool = getPool();
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
    console.error('Error fetching streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des liens',
      message: error.message
    });
  }
});

/**
 * POST /verify-access-code
 * Verify a VIP access code (used during initial code entry)
 * Body: { code: string }
 */
router.post('/verify-access-code', vipCodeRateLimit, async (req, res) => {
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
    console.error('Error verifying access code:', error);
    return res.status(500).json({
      success: false,
      error: 'Erreur lors de la vérification du code d\'accès'
    });
  }
});

/**
 * GET /check-vip
 * Server-side VIP status check via x-access-key header.
 * Called periodically by the frontend to ensure the key is still valid.
 * If the key is no longer valid, the frontend must revoke the local VIP status.
 */
router.get('/check-vip', async (req, res) => {
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
    console.error('Error checking VIP status:', error);
    return res.status(500).json({ vip: false, error: 'Erreur interne' });
  }
});

// === ADMIN ROUTES (with authentication) ===

/**
 * POST /admin/links
 * Add or update streaming links
 * Body: { type: 'movie'|'tv', id: string, links: array, season?: number, episode?: number }
 */
router.post('/admin/links', isUploaderOrAdmin, async (req, res) => {
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

    const pool = getPool();

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
    console.error('Error adding streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'ajout des liens',
      message: error.message
    });
  }
});

/**
 * DELETE /admin/links
 * Delete streaming links
 * Body: { type: 'movie'|'tv', id: string, season?: number, episode?: number }
 */
router.delete('/admin/links', isUploaderOrAdmin, async (req, res) => {
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

    const pool = getPool();

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
    console.error('Error deleting streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la suppression des liens',
      message: error.message
    });
  }
});

/**
 * PUT /admin/links
 * Modify streaming links (complete replacement)
 * Body: { type: 'movie'|'tv', id: string, links: array, season?: number, episode?: number }
 */
router.put('/admin/links', isUploaderOrAdmin, async (req, res) => {
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

    const pool = getPool();
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
    console.error('Error updating streaming links:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la modification des liens',
      message: error.message
    });
  }
});

// === ADMIN ROUTES - VIP KEY MANAGEMENT ===

/**
 * GET /admin/check
 * Verify admin rights (admin or uploader)
 */
router.get('/admin/check', isUploaderOrAdmin, async (req, res) => {
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
    console.error('Admin check error:', error);
    res.status(500).json({ success: false, error: 'Erreur lors de la vérification admin' });
  }
});

/**
 * GET /admin/vip-keys
 * Retrieve all VIP keys
 * Query: active (optional, true/false), used (optional, true/false), search, page, limit
 */
router.get('/admin/vip-keys', isAdmin, async (req, res) => {
  try {
    const { active, used } = req.query;
    const search = String(req.query.search || '').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
    const offset = (page - 1) * limit;

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

    if (search) {
      const likeSearch = `%${search}%`;
      conditions.push(`(
        key_value LIKE ?
        OR COALESCE(duree_validite, '') LIKE ?
        OR COALESCE(CAST(expires_at AS CHAR), '') LIKE ?
        OR COALESCE(DATE_FORMAT(FROM_UNIXTIME(expires_at / 1000), '%Y-%m-%d %H:%i:%s'), '') LIKE ?
        OR COALESCE(DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s'), '') LIKE ?
      )`);
      params.push(likeSearch, likeSearch, likeSearch, likeSearch, likeSearch);
    }

    let whereClause = '';
    if (conditions.length > 0) {
      whereClause = ` WHERE ${conditions.join(' AND ')}`;
    }

    const pool = getPool();
    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM access_keys${whereClause}`,
      params
    );
    const total = Number(countRow?.total || 0);

    const [rows] = await pool.execute(
      `SELECT * FROM access_keys${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      keys: rows,
      count: rows.length,
      total,
      page,
      limit,
      hasMore: offset + rows.length < total
    });

  } catch (error) {
    console.error('Error fetching VIP keys:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des clés VIP',
      message: error.message
    });
  }
});

/**
 * POST /admin/vip-keys
 * Add a new VIP key
 * Body: { key: string, duree_validite?: string, expires_at?: string }
 */
router.post('/admin/vip-keys', isAdmin, async (req, res) => {
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

    const pool = getPool();

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
    let expiresAtValue = parseAccessKeyExpiresAt(expires_at);

    if (duree_validite && !expires_at) {
      expiresAtValue = buildAccessKeyExpiryFromDuration(duree_validite);
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
    console.error('Error adding VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'ajout de la clé VIP',
      message: error.message
    });
  }
});

/**
 * PUT /admin/vip-keys/:key
 * Modify a VIP key (expiration, duration, status)
 * Body: { duree_validite?: string, expires_at?: string, active?: boolean, used?: boolean }
 */
router.put('/admin/vip-keys/:key', isAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { duree_validite, expires_at, active, used } = req.body;

    const pool = getPool();

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
        const computedExpiresAt = buildAccessKeyExpiryFromDuration(duree_validite);
        if (computedExpiresAt !== null) {
          updates.push('expires_at = ?');
          params.push(computedExpiresAt);
        }
      }
    }

    if (expires_at !== undefined) {
      updates.push('expires_at = ?');
      params.push(parseAccessKeyExpiresAt(expires_at));
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
    console.error('Error updating VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la modification de la clé VIP',
      message: error.message
    });
  }
});

/**
 * DELETE /admin/vip-keys/:key
 * Delete a VIP key
 */
router.delete('/admin/vip-keys/:key', isAdmin, async (req, res) => {
  try {
    const { key } = req.params;

    const pool = getPool();
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
    console.error('Error deleting VIP key:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la suppression de la clé VIP',
      message: error.message
    });
  }
});

module.exports = router;
