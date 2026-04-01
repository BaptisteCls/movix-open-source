/**
 * Discord webhook for sync error logging.
 * Extracted from server.js — sends error embeds to a Discord channel.
 */

const axios = require('axios');

// === DISCORD WEBHOOK POUR LES ERREURS DE SYNC ===
const SYNC_ERROR_WEBHOOK = process.env.DISCORD_SYNC_ERROR_WEBHOOK_URL;

async function logSyncErrorToDiscord(errorMessage, context = {}) {
  if (!SYNC_ERROR_WEBHOOK) return; // Skip if webhook not configured
  try {
    const embed = {
      title: '\u274c Erreur de Sync',
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
      embed.fields.push({ name: 'D\u00e9tails Erreur', value: `\`\`\`${String(context.error).substring(0, 500)}\`\`\``, inline: false });
    }

    if (context.payload) {
      // Tronquer le payload pour éviter de dépasser la limite Discord (1024 chars par field)
      const payloadStr = JSON.stringify(context.payload, null, 2);
      const truncatedPayload = payloadStr.length > 900 ? payloadStr.substring(0, 900) + '\n... (tronqu\u00e9)' : payloadStr;
      embed.fields.push({ name: 'Payload Requ\u00eate', value: `\`\`\`json\n${truncatedPayload}\`\`\``, inline: false });
    }

    await axios.post(SYNC_ERROR_WEBHOOK, { embeds: [embed] }, { timeout: 5000 }).catch(() => { });
  } catch (e) {
    // Silently fail - don't break sync if webhook fails
  }
}

module.exports = { logSyncErrorToDiscord };
