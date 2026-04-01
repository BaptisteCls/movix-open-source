import { DISCORD_CONFIG } from '../config/discord';
import { clearPendingAuthAction, setPendingAuthLink } from '../utils/accountAuth';

interface DiscordLoginOptions {
  mode?: 'login' | 'link';
  returnTo?: string;
}

export const discordAuth = {
  login: (options: DiscordLoginOptions = {}) => {
    if (options.mode === 'link') {
      setPendingAuthLink('discord', options.returnTo);
    } else {
      clearPendingAuthAction();
    }

    window.location.href = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CONFIG.CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_CONFIG.REDIRECT_URI)}&response_type=token&scope=${encodeURIComponent(DISCORD_CONFIG.SCOPES.join(' '))}`;
  }
};
