const { getPool } = require('../mysqlPool');

const SUPPORTED_PROVIDERS = ['discord', 'google', 'bip39'];
const SUPPORTED_USER_TYPES = ['oauth', 'bip39'];

let ensureAccountLinksStoragePromise = null;

function isSupportedProvider(provider) {
  return SUPPORTED_PROVIDERS.includes(provider);
}

function isSupportedUserType(userType) {
  return SUPPORTED_USER_TYPES.includes(userType);
}

async function ensureAccountLinksStorage() {
  if (ensureAccountLinksStoragePromise) {
    return ensureAccountLinksStoragePromise;
  }

  ensureAccountLinksStoragePromise = (async () => {
    const pool = getPool();
    if (!pool) {
      throw new Error('MySQL pool not ready for account links');
    }

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS account_links (
        provider ENUM('discord', 'google', 'bip39') NOT NULL,
        provider_user_id VARCHAR(255) NOT NULL,
        target_user_type ENUM('oauth', 'bip39') NOT NULL,
        target_user_id VARCHAR(255) NOT NULL,
        linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, provider_user_id),
        UNIQUE KEY uniq_account_links_target_provider (target_user_type, target_user_id, provider),
        KEY idx_account_links_target (target_user_type, target_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  })().catch((error) => {
    ensureAccountLinksStoragePromise = null;
    throw error;
  });

  return ensureAccountLinksStoragePromise;
}

function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeRecord(row) {
  if (!row || !isSupportedProvider(row.provider) || !isSupportedUserType(row.target_user_type)) {
    return null;
  }

  return {
    provider: row.provider,
    providerUserId: String(row.provider_user_id),
    targetUserType: row.target_user_type,
    targetUserId: String(row.target_user_id),
    linkedAt: toIsoString(row.linked_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function getLinkedTarget(provider, providerUserId) {
  if (!isSupportedProvider(provider)) return null;

  await ensureAccountLinksStorage();
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT provider, provider_user_id, target_user_type, target_user_id, linked_at, updated_at
     FROM account_links
     WHERE provider = ? AND provider_user_id = ?
     LIMIT 1`,
    [provider, String(providerUserId)]
  );

  return normalizeRecord(rows[0]);
}

async function getLinksForTarget(targetUserType, targetUserId) {
  if (!isSupportedUserType(targetUserType)) {
    return [];
  }

  await ensureAccountLinksStorage();
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT provider, provider_user_id, target_user_type, target_user_id, linked_at, updated_at
     FROM account_links
     WHERE target_user_type = ? AND target_user_id = ?
     ORDER BY provider ASC`,
    [targetUserType, String(targetUserId)]
  );

  return rows
    .map(normalizeRecord)
    .filter(Boolean);
}

async function setLink({ provider, providerUserId, targetUserType, targetUserId }) {
  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  if (!isSupportedUserType(targetUserType)) {
    throw new Error(`Unsupported target user type: ${targetUserType}`);
  }

  await ensureAccountLinksStorage();
  const pool = getPool();
  const connection = await pool.getConnection();
  const now = new Date();

  try {
    await connection.beginTransaction();

    await connection.execute(
      `DELETE FROM account_links
       WHERE target_user_type = ? AND target_user_id = ? AND provider = ? AND provider_user_id <> ?`,
      [targetUserType, String(targetUserId), provider, String(providerUserId)]
    );

    await connection.execute(
      `INSERT INTO account_links (
        provider,
        provider_user_id,
        target_user_type,
        target_user_id,
        linked_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        target_user_type = VALUES(target_user_type),
        target_user_id = VALUES(target_user_id),
        linked_at = account_links.linked_at,
        updated_at = VALUES(updated_at)`,
      [provider, String(providerUserId), targetUserType, String(targetUserId), now, now]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const record = await getLinkedTarget(provider, providerUserId);
  if (!record) {
    throw new Error('Failed to persist account link');
  }

  return record;
}

async function removeLink(provider, providerUserId) {
  if (!isSupportedProvider(provider)) {
    return false;
  }

  await ensureAccountLinksStorage();
  const pool = getPool();
  const [result] = await pool.execute(
    'DELETE FROM account_links WHERE provider = ? AND provider_user_id = ?',
    [provider, String(providerUserId)]
  );

  return result.affectedRows > 0;
}

async function removeLinksForTargetProvider(targetUserType, targetUserId, provider) {
  if (!isSupportedUserType(targetUserType) || !isSupportedProvider(provider)) {
    return false;
  }

  await ensureAccountLinksStorage();
  const pool = getPool();
  const [result] = await pool.execute(
    `DELETE FROM account_links
     WHERE target_user_type = ? AND target_user_id = ? AND provider = ?`,
    [targetUserType, String(targetUserId), provider]
  );

  return result.affectedRows > 0;
}

module.exports = {
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  getLinkedTarget,
  getLinksForTarget,
  setLink,
  removeLink,
  removeLinksForTargetProvider,
  ensureAccountLinksStorage,
};
