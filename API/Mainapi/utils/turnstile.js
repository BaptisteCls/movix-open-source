/**
 * Utilitaire partagé pour la vérification Cloudflare Turnstile.
 */

const axios = require('axios');

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

async function verifyTurnstile(token, ip, secretKey) {
  try {
    const response = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      secret: secretKey || TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: ip,
    }, { timeout: 10000 });
    return response.data.success === true;
  } catch (error) {
    console.error('Turnstile verification error:', error.message);
    return false;
  }
}

/**
 * Vérifie le token Turnstile à partir d'une requête Express.
 * Retourne { valid: true } si OK, ou { valid: false, status, error } si échec.
 * Si aucune secretKey n'est fournie et TURNSTILE_SECRET_KEY n'est pas configuré, la vérification est ignorée.
 * @param {object} req - Express request
 * @param {string} turnstileToken - Token du client
 * @param {string} [secretKey] - Clé secrète optionnelle (sinon utilise TURNSTILE_SECRET_KEY)
 */
async function verifyTurnstileFromRequest(req, turnstileToken, secretKey) {
  const key = secretKey || TURNSTILE_SECRET_KEY;
  if (!key) return { valid: true };

  if (!turnstileToken) {
    return { valid: false, status: 400, error: 'Vérification de sécurité requise' };
  }

  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const isValid = await verifyTurnstile(turnstileToken, ip, key);

  if (!isValid) {
    return { valid: false, status: 403, error: 'Vérification de sécurité échouée. Réessayez.' };
  }

  return { valid: true };
}

module.exports = { verifyTurnstile, verifyTurnstileFromRequest };
