/**
 * Utility functions for authentication in the comments system
 */
import { isUserVip as checkVip, getVipHeaders } from './vipUtils';
import i18n from '../i18n';

export interface UserInfo {
  id: string;
  name: string;
  avatar: string | null;
  type: 'google' | 'discord' | 'bip39';
  is_vip: boolean;
  is_admin: boolean;
}

/**
 * Get user authentication token
 * Checks for auth_token or falls back to session_id
 */
export function getAuthToken(): string | null {
  const authToken = localStorage.getItem('auth_token');
  if (authToken) return authToken;

  // Fallback to session_id if auth_token doesn't exist
  const sessionId = localStorage.getItem('session_id');
  return sessionId;
}

/**
 * Get current user information from localStorage
 * Supports Discord, Google, and BIP39 authentication
 */
export function getCurrentUser(): UserInfo | null {
  // Check if user is authenticated
  const discordAuth = localStorage.getItem('discord_auth') === 'true';
  const googleAuth = localStorage.getItem('google_auth') === 'true';
  const bip39Auth = localStorage.getItem('bip39_auth') === 'true';
  const auth = localStorage.getItem('auth');

  const isAuthenticated = discordAuth || googleAuth || bip39Auth || !!auth;

  if (!isAuthenticated) {
    return null;
  }

  const isVip = checkVip(); // Vérification VIP via serveur MySQL (au lieu de hardcoded true)
  const isAdmin = localStorage.getItem('is_admin') === 'true';

  // Try to get user info from different auth sources
  let userId: string | null = null;
  let userName: string | null = null;
  let userAvatar: string | null = null;
  let userType: 'google' | 'discord' | 'bip39' | null = null;

  // 1. Check BIP39 auth first
  if (bip39Auth && auth) {
    try {
      const { userProfile } = JSON.parse(auth);
      if (userProfile && (userProfile.provider === 'bip39' || userProfile.provider === 'access_code')) {
        userId = localStorage.getItem('user_id') || userProfile.id || 'bip39_user';
        userName = userProfile.username || localStorage.getItem('user_name') || i18n.t('auth.userBip39');
        userAvatar = userProfile.avatar || localStorage.getItem('avatar_url');
        userType = 'bip39';
      }
    } catch (error) {
      console.error('Error parsing BIP39 auth:', error);
    }
  }

  // 2. Check Discord auth
  if (!userId && discordAuth) {
    try {
      // Try to get from auth object first
      if (auth) {
        const { userProfile } = JSON.parse(auth);
        if (userProfile) {
          const discordUserData = localStorage.getItem('discord_user');
          if (discordUserData) {
            const discordUser = JSON.parse(discordUserData);
            userId = discordUser.id || localStorage.getItem('user_id') || 'discord_user';
            userName = userProfile.username || discordUser.username || localStorage.getItem('user_name') || i18n.t('auth.userDiscord');
            userAvatar = userProfile.avatar || discordUser.avatar || localStorage.getItem('avatar_url');
            userType = 'discord';
          }
        }
      }

      // Fallback to discord_user
      if (!userId) {
        const discordUserData = localStorage.getItem('discord_user');
        if (discordUserData) {
          const discordUser = JSON.parse(discordUserData);
          userId = discordUser.id || localStorage.getItem('user_id') || 'discord_user';
          userName = discordUser.username || localStorage.getItem('user_name') || i18n.t('auth.userDiscord');
          userAvatar = discordUser.avatar || localStorage.getItem('avatar_url');
          userType = 'discord';
        }
      }
    } catch (error) {
      console.error('Error parsing Discord auth:', error);
    }
  }

  // 3. Check Google auth
  if (!userId && googleAuth) {
    try {
      // Try to get from auth object first
      if (auth) {
        const { userProfile } = JSON.parse(auth);
        if (userProfile) {
          const googleUserData = localStorage.getItem('google_user');
          if (googleUserData) {
            const googleUser = JSON.parse(googleUserData);
            userId = googleUser.id || localStorage.getItem('user_id') || 'google_user';
            userName = userProfile.username || googleUser.name || localStorage.getItem('user_name') || i18n.t('auth.userGoogle');
            userAvatar = userProfile.avatar || googleUser.picture || localStorage.getItem('avatar_url');
            userType = 'google';
          }
        }
      }

      // Fallback to google_user
      if (!userId) {
        const googleUserData = localStorage.getItem('google_user');
        if (googleUserData) {
          const googleUser = JSON.parse(googleUserData);
          userId = googleUser.id || localStorage.getItem('user_id') || 'google_user';
          userName = googleUser.name || localStorage.getItem('user_name') || i18n.t('auth.userGoogle');
          userAvatar = googleUser.picture || localStorage.getItem('avatar_url');
          userType = 'google';
        }
      }
    } catch (error) {
      console.error('Error parsing Google auth:', error);
    }
  }

  // Fallback to localStorage keys
  if (!userId) {
    userId = localStorage.getItem('user_id');
    userName = localStorage.getItem('user_name');
    userAvatar = localStorage.getItem('avatar_url');
    const storedUserType = localStorage.getItem('user_type') as 'google' | 'discord' | 'bip39' | null;
    userType = storedUserType;
  }

  // If we still don't have required info, return null
  if (!userId || !userName || !userType) {
    console.warn('User is authenticated but missing required info:', { userId, userName, userType });
    return null;
  }

  return {
    id: userId,
    name: userName,
    avatar: userAvatar,
    type: userType,
    is_vip: isVip,
    is_admin: isAdmin
  };
}

/**
 * Check if user is authenticated
 */
export function isUserAuthenticated(): boolean {
  const discordAuth = localStorage.getItem('discord_auth') === 'true';
  const googleAuth = localStorage.getItem('google_auth') === 'true';
  const bip39Auth = localStorage.getItem('bip39_auth') === 'true';
  const auth = localStorage.getItem('auth');

  return discordAuth || googleAuth || bip39Auth || !!auth;
}

/**
 * Check if user is VIP (vérification serveur via MySQL access_keys)
 */
export function isUserVip(): boolean {
  return checkVip();
}

/**
 * Get headers for API calls that need VIP verification
 */
export { getVipHeaders };
