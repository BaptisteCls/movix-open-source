export type AuthMethod = 'discord' | 'google' | 'bip39';
export type ResolvedUserType = 'oauth' | 'bip39';

interface PendingAuthAction {
  type: 'link';
  provider: AuthMethod;
  returnTo: string;
  createdAt: number;
}

interface ResolvedAccountPayload {
  userType?: ResolvedUserType;
  userId?: string | null;
  linked?: boolean;
}

interface AuthDataPayload {
  userProfile?: Record<string, unknown>;
  provider?: string;
}

export interface ResolvedAuthResponse {
  sessionId?: string | null;
  token?: string | null;
  user?: Record<string, unknown> | null;
  account?: ResolvedAccountPayload | null;
  authData?: AuthDataPayload | null;
}

interface PersistResolvedSessionOptions {
  accessToken?: string | null;
}

const DEFAULT_AVATAR = 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
const PENDING_AUTH_ACTION_KEY = 'movix_pending_auth_action';
const AUTH_KEYS = [
  'auth',
  'auth_token',
  'session_id',
  'discord_auth',
  'discord_user',
  'discord_token',
  'google_auth',
  'google_user',
  'google_token',
  'bip39_auth',
  'auth_method',
  'resolved_user_type',
  'resolved_user_id',
  'user_id',
  'selected_profile_id',
] as const;

function isAuthMethod(value: string | null): value is AuthMethod {
  return value === 'discord' || value === 'google' || value === 'bip39';
}

function isResolvedUserType(value: string | null): value is ResolvedUserType {
  return value === 'oauth' || value === 'bip39';
}

function getDiscordAvatar(rawUser?: Record<string, unknown> | null) {
  if (!rawUser) return DEFAULT_AVATAR;
  if (typeof rawUser.avatar === 'string' && rawUser.avatar.startsWith('http')) {
    return rawUser.avatar;
  }
  if (rawUser.id && rawUser.avatar) {
    return `https://cdn.discordapp.com/avatars/${rawUser.id}/${rawUser.avatar}.png`;
  }
  return DEFAULT_AVATAR;
}

function getFallbackAuthProfile(method: AuthMethod, resolvedUserId: string, rawUser?: Record<string, unknown> | null) {
  if (method === 'discord') {
    return {
      id: resolvedUserId,
      username: rawUser?.username || `Discord-${resolvedUserId}`,
      avatar: getDiscordAvatar(rawUser),
      provider: 'discord',
    };
  }

  if (method === 'google') {
    return {
      id: resolvedUserId,
      username: rawUser?.name || rawUser?.email || `Google-${resolvedUserId}`,
      avatar: rawUser?.picture || DEFAULT_AVATAR,
      provider: 'google',
    };
  }

  return {
    id: resolvedUserId,
    username: rawUser?.username || `Utilisateur-${resolvedUserId.slice(0, 8)}`,
    avatar: rawUser?.avatar || DEFAULT_AVATAR,
    provider: 'bip39',
  };
}

export function getCurrentAuthMethod(): AuthMethod | null {
  const storedMethod = localStorage.getItem('auth_method');
  if (isAuthMethod(storedMethod)) return storedMethod;

  if (localStorage.getItem('discord_auth') === 'true') return 'discord';
  if (localStorage.getItem('google_auth') === 'true') return 'google';
  if (localStorage.getItem('bip39_auth') === 'true') return 'bip39';
  return null;
}

export function getResolvedUserType(): ResolvedUserType | null {
  const storedType = localStorage.getItem('resolved_user_type');
  if (isResolvedUserType(storedType)) return storedType;

  const authStr = localStorage.getItem('auth');
  if (authStr) {
    try {
      const auth = JSON.parse(authStr);
      const provider = auth?.userProfile?.provider || auth?.provider;
      if (provider === 'bip39') return 'bip39';
    } catch {
      // Ignore malformed auth blob.
    }
  }

  return getCurrentAuthMethod() === 'bip39' ? 'bip39' : 'oauth';
}

export function getResolvedUserId(): string | null {
  const storedId = localStorage.getItem('resolved_user_id') || localStorage.getItem('user_id');
  if (storedId) return storedId;

  const authStr = localStorage.getItem('auth');
  if (authStr) {
    try {
      const auth = JSON.parse(authStr);
      const authId = auth?.userProfile?.id;
      if (authId) return String(authId);
    } catch {
      // Ignore malformed auth blob.
    }
  }

  const method = getCurrentAuthMethod();
  if (method === 'discord') {
    try {
      const user = JSON.parse(localStorage.getItem('discord_user') || '{}');
      return user?.id ? String(user.id) : null;
    } catch {
      return null;
    }
  }

  if (method === 'google') {
    try {
      const user = JSON.parse(localStorage.getItem('google_user') || '{}');
      return user?.id ? String(user.id) : null;
    } catch {
      return null;
    }
  }

  return null;
}

export function getResolvedAccountProvider(): AuthMethod | null {
  const authStr = localStorage.getItem('auth');
  if (authStr) {
    try {
      const auth = JSON.parse(authStr);
      const provider = auth?.userProfile?.provider || auth?.provider;
      if (isAuthMethod(provider)) return provider;
    } catch {
      // Ignore malformed auth blob.
    }
  }

  return getResolvedUserType() === 'bip39' ? 'bip39' : getCurrentAuthMethod();
}

export function getResolvedAccountContext() {
  return {
    authMethod: getCurrentAuthMethod(),
    accountProvider: getResolvedAccountProvider(),
    userType: getResolvedUserType(),
    userId: getResolvedUserId(),
  };
}

export function getPendingAuthAction(): PendingAuthAction | null {
  const raw = localStorage.getItem(PENDING_AUTH_ACTION_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingAuthAction;
    const isFresh = typeof parsed.createdAt === 'number' && Date.now() - parsed.createdAt < 30 * 60 * 1000;
    if (parsed?.type === 'link' && isAuthMethod(parsed.provider) && typeof parsed.returnTo === 'string' && isFresh) {
      return parsed;
    }
  } catch {
    // Ignore malformed state.
  }

  localStorage.removeItem(PENDING_AUTH_ACTION_KEY);
  return null;
}

export function setPendingAuthLink(provider: AuthMethod, returnTo = '/settings#accounts') {
  const payload: PendingAuthAction = {
    type: 'link',
    provider,
    returnTo,
    createdAt: Date.now(),
  };
  localStorage.setItem(PENDING_AUTH_ACTION_KEY, JSON.stringify(payload));
}

export function clearPendingAuthAction() {
  localStorage.removeItem(PENDING_AUTH_ACTION_KEY);
}

export function clearStoredAuthSession() {
  AUTH_KEYS.forEach((key) => localStorage.removeItem(key));
}

export function broadcastAuthChange() {
  window.dispatchEvent(new Event('storage'));
  window.dispatchEvent(new Event('auth_changed'));
}

export function persistResolvedSession(
  method: AuthMethod,
  payload: ResolvedAuthResponse,
  options: PersistResolvedSessionOptions = {}
) {
  const rawUser = payload.user || null;
  const resolvedUserType = payload.account?.userType || (method === 'bip39' ? 'bip39' : 'oauth');
  const resolvedUserId = String(
    payload.account?.userId ||
    payload.authData?.userProfile?.id ||
    rawUser?.id ||
    rawUser?.sub ||
    ''
  );

  if (!resolvedUserId) {
    throw new Error('Impossible de déterminer l’identifiant du compte résolu');
  }

  clearStoredAuthSession();

  localStorage.setItem('auth_method', method);
  localStorage.setItem('resolved_user_type', resolvedUserType);
  localStorage.setItem('resolved_user_id', resolvedUserId);
  localStorage.setItem('user_id', resolvedUserId);

  if (payload.sessionId) localStorage.setItem('session_id', payload.sessionId);
  if (payload.token) localStorage.setItem('auth_token', payload.token);

  if (method === 'discord') {
    const providerId = String(rawUser?.id || resolvedUserId);
    localStorage.setItem('discord_auth', 'true');
    localStorage.setItem('discord_user', JSON.stringify({
      id: resolvedUserId,
      providerId,
      username: rawUser?.username || payload.authData?.userProfile?.username || `Discord-${providerId}`,
      discriminator: rawUser?.discriminator,
      avatar: getDiscordAvatar(rawUser),
      roles: Array.isArray(rawUser?.roles) ? rawUser.roles : [],
      isAdmin: Boolean(rawUser?.isAdmin),
      linked: Boolean(payload.account?.linked),
    }));
    if (options.accessToken) localStorage.setItem('discord_token', options.accessToken);
  }

  if (method === 'google') {
    const providerId = String(rawUser?.sub || rawUser?.id || resolvedUserId);
    localStorage.setItem('google_auth', 'true');
    localStorage.setItem('google_user', JSON.stringify({
      id: resolvedUserId,
      providerId,
      email: rawUser?.email || '',
      name: rawUser?.name || payload.authData?.userProfile?.username || `Google-${providerId}`,
      picture: rawUser?.picture || DEFAULT_AVATAR,
      linked: Boolean(payload.account?.linked),
    }));
    if (options.accessToken) localStorage.setItem('google_token', options.accessToken);
  }

  if (method === 'bip39') {
    localStorage.setItem('bip39_auth', 'true');
  }

  const authData = payload.authData?.userProfile
    ? payload.authData
    : {
        userProfile: getFallbackAuthProfile(method, resolvedUserId, rawUser),
        provider: method,
      };

  localStorage.setItem('auth', JSON.stringify(authData));
}
