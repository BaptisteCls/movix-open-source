// Discord webhook URL
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1356950660838588456/8TVg6FQBu1aE4-YhJXzyLCgH1c1Ehby1JFYVICqpX_53QZ9a8gvxuKejLdwTf9qlUqpW';

// Types d'événements simplifiés
export enum LogType {
  ADMIN = 'ADMIN',
  USER = 'USER',
  COMMENT = 'COMMENT',
  ERROR = 'ERROR'
}

/**
 * Fonction simplifiée pour envoyer un log à Discord
 */
export const log = async (
  type: LogType,
  message: string,
  details?: any,
  userId?: string,
  username?: string
): Promise<void> => {
  // Log dans la console
  const timestamp = new Date().toISOString();
  const prefix = `[${type}]`;
  const userInfo = userId ? `[${username || userId}]` : '';
  
  // Couleurs pour la console
  let style = 'color: black';
  switch (type) {
    case LogType.ADMIN: style = 'color: purple; font-weight: bold'; break;
    case LogType.USER: style = 'color: blue'; break;
    case LogType.COMMENT: style = 'color: green'; break;
    case LogType.ERROR: style = 'color: red; font-weight: bold'; break;
  }
  
  // Affichage dans la console
  console.log(`%c${timestamp} ${prefix} ${userInfo} ${message}`, style);
  if (details) console.log('Details:', details);
  
  // Envoyer à Discord
  try {
    // Couleurs pour Discord
    const colors = {
      [LogType.ADMIN]: 0x9B59B6,   // Violet
      [LogType.USER]: 0x3498DB,    // Bleu
      [LogType.COMMENT]: 0x2ECC71, // Vert
      [LogType.ERROR]: 0xFF0000,   // Rouge
    };
    
    // Emojis pour les types
    const emojis = {
      [LogType.ADMIN]: '🔑',
      [LogType.USER]: '👤',
      [LogType.COMMENT]: '💬',
      [LogType.ERROR]: '❌',
    };
    
    // Formatage simplifié des détails
    let detailsText = '';
    if (details) {
      try {
        detailsText = '```json\n' + 
          JSON.stringify(details, null, 2).substring(0, 800) + 
          (JSON.stringify(details).length > 800 ? '\n...' : '') + 
          '\n```';
      } catch (e) {
        detailsText = '```Erreur de formatage```';
      }
    }
    
    // Payload Discord simplifié
    const payload = {
      embeds: [{
        title: `${emojis[type]} ${message}`,
        color: colors[type],
        description: detailsText,
        fields: [
          userId ? {
            name: 'Utilisateur',
            value: username ? `${username} (${userId})` : userId,
            inline: true
          } : null,
          {
            name: 'Date',
            value: new Date().toLocaleString('fr-FR'),
            inline: true
          }
        ].filter(Boolean),
        footer: { text: 'Movix' },
        timestamp: new Date().toISOString()
      }]
    };
    
    // Envoi à Discord
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error('Erreur d\'envoi au webhook:', error);
  }
};

// Fonctions d'aide simplifiées
export const logAdmin = (message: string, details?: any, userId?: string, username?: string): Promise<void> => 
  log(LogType.ADMIN, message, details, userId, username);

export const logUser = (message: string, details?: any, userId?: string, username?: string): Promise<void> => 
  log(LogType.USER, message, details, userId, username);

export const logComment = (message: string, details?: any, userId?: string, username?: string): Promise<void> => 
  log(LogType.COMMENT, message, details, userId, username);

export const logError = (message: string, error?: any, userId?: string, username?: string): Promise<void> => 
  log(LogType.ERROR, message, error ? { 
    message: error.message, 
    stack: error.stack 
  } : undefined, userId, username); 