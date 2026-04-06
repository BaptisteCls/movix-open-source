import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, Settings, Shield, Monitor, Smartphone, Tablet,
  Copy, X, Snowflake, Activity, Trash2, Crown, Volume2,
  Database, Key, Lock, Palette, Eye, Download, Upload, Globe, AlertTriangle, History, CalendarClock, FlaskConical, Link2
} from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';

import { discordAuth } from '../services/discordAuth';
import { googleAuth } from '../services/googleAuth';
import { isUserVip } from '../utils/authUtils';
import { clearStoredAuthSession, getResolvedAccountContext, setPendingAuthLink } from '../utils/accountAuth';
import {
  formatStorageBytes,
  getAllLocalStorageEntries,
  getLocalStorageMetrics,
  getNonSyncableLocalStorageEntries,
  type NonSyncableLocalStorageEntry,
  type NonSyncableStorageReason,
  isSyncableStorageKey
} from '../utils/syncStorage';
import {
  areSoundEffectsEnabled,
  setSoundEffectsEnabled,
  SOUND_EFFECTS_CHANGED_EVENT
} from '../utils/soundSettings';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_LANGUAGES, changeLanguage, type SupportedLanguage } from '../i18n';
import { SquareBackground } from '../components/ui/square-background';

const API_URL = import.meta.env.VITE_MAIN_API;

// ─── Types ───────────────────────────────────────────────────────────────────

interface VipStatus {
  isVip: boolean;
  expiresAt?: string;
  features: string[];
}

interface UserSession {
  id: string;
  userId: string;
  createdAt: string;
  accessedAt: string;
  device: string;
  userAgent: string;
}

type LinkProvider = 'discord' | 'google' | 'bip39';

interface LinkedAccountStatus {
  linked: boolean;
  providerUserId: string | null;
  linkedAt: string | null;
  updatedAt: string | null;
}

interface LinkedAccountsMeta {
  accountProvider: LinkProvider | null;
  authMethod: LinkProvider | null;
  canManageLinks: boolean;
  manageWithProvider: LinkProvider | null;
}

function isLinkProvider(value: string | null | undefined): value is LinkProvider {
  return value === 'discord' || value === 'google' || value === 'bip39';
}

interface ImportedMediaItem {
  id?: string | number;
  type?: string;
  title?: string;
  name?: string;
  poster_path?: string;
  episodeInfo?: unknown;
  addedAt?: string;
}

interface LocalStorageMetrics {
  totalBytes: number;
  syncableBytes: number;
  totalKeys: number;
  syncableKeys: number;
}

interface SyncServerStats {
  profileId: string;
  profileBytes: number;
  profileKeyCount: number;
  profileQuotaBytes: number;
  legacySyncBytes: number;
  legacySyncKeyCount: number;
  totalSyncBytes: number;
}

function getNonSyncReasonTranslationKey(reason: NonSyncableStorageReason) {
  switch (reason) {
    case 'blocked':
      return 'settings.nonSyncReasonBlocked';
    case 'invalid_format':
      return 'settings.nonSyncReasonInvalidFormat';
    case 'not_allowlisted':
    default:
      return 'settings.nonSyncReasonNotAllowlisted';
  }
}

// ─── Section IDs for sidebar navigation ──────────────────────────────────────

const SECTIONS = [
  { id: 'appearance', labelKey: 'settings.sections.appearance', icon: Palette },
  { id: 'language', labelKey: 'settings.sections.language', icon: Globe },
  { id: 'vip', labelKey: 'settings.sections.vip', icon: Crown },
  { id: 'sessions', labelKey: 'settings.sections.sessions', icon: Monitor },
  { id: 'accounts', labelKey: 'settings.sections.accounts', icon: Link2 },
  { id: 'privacy', labelKey: 'settings.sections.privacy', icon: Shield },
  { id: 'data', labelKey: 'settings.sections.data', icon: Database },
] as const;

// ─── Settings Page ───────────────────────────────────────────────────────────

const SettingsPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const contentRef = useRef<HTMLDivElement>(null);
  const { t, i18n } = useTranslation();
  // Active section tracking
  const [activeSection, setActiveSection] = useState<string>(() => {
    const hash = location.hash.replace('#', '');
    return hash || 'appearance';
  });

  // ─── Appearance settings state ───────────────────────────────────────────

  const [disableAutoScroll, setDisableAutoScroll] = useState(() => {
    return localStorage.getItem('settings_disable_auto_scroll') === 'true';
  });

  const [disableRouteScrollToTop, setDisableRouteScrollToTop] = useState(() => {
    return localStorage.getItem('settings_disable_route_scroll_to_top') === 'true';
  });

  const [smoothScrollEnabled, setSmoothScrollEnabled] = useState(() => {
    return localStorage.getItem('settings_smooth_scroll') !== 'false';
  });

  const [soundEffectsEnabled, setSoundEffectsEnabledState] = useState(() => {
    return areSoundEffectsEnabled();
  });

  const [isSnowfallActive, setIsSnowfallActive] = useState(() => {
    return sessionStorage.getItem('snowfall_active') === 'true';
  });

  const [bgMode, setBgMode] = useState<'combined' | 'static' | 'animated'>(() => {
    return (localStorage.getItem('settings_bg_mode') as 'combined' | 'static' | 'animated') || 'combined';
  });

  const [introEnabled, setIntroEnabled] = useState(() => {
    return localStorage.getItem('movix_intro_enabled') === 'true';
  });

  const [screensaverEnabled, setScreensaverEnabled] = useState(() => {
    return localStorage.getItem('screensaver_enabled') === 'true';
  });
  const [screensaverTimeout, setScreensaverTimeout] = useState(() => {
    return parseInt(localStorage.getItem('screensaver_timeout') || '60', 10);
  });
  const [screensaverMode, setScreensaverMode] = useState(() => {
    return localStorage.getItem('screensaver_mode') || 'backdrop';
  });

  // ─── VIP state ───────────────────────────────────────────────────────────

  const [vipStatus, setVipStatus] = useState<VipStatus>({ isVip: false, features: [] });
  const [premiumKey, setPremiumKey] = useState('');
  const [vipKeyError, setVipKeyError] = useState<string | null>(null);
  const [isActivatingKey, setIsActivatingKey] = useState(false);
  const [isVipKeyHovered, setIsVipKeyHovered] = useState(false);
  const { checkAccessCode, error: authError, lastAttempt } = useAuth();

  // ─── Sessions state ──────────────────────────────────────────────────────

  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // —— Linked accounts state ———————————————————————————————————————————————————————

  const [linkedAccounts, setLinkedAccounts] = useState<Record<LinkProvider, LinkedAccountStatus>>({
    discord: { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
    google: { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
    bip39: { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
  });
  const [linkModal, setLinkModal] = useState<{ provider: LinkProvider; action: 'link' | 'unlink' } | null>(null);
  const [isClosingLinkModal, setIsClosingLinkModal] = useState(false);
  const [linkActionError, setLinkActionError] = useState<string | null>(null);
  const [isLoadingLinks, setIsLoadingLinks] = useState(false);
  const [isSubmittingLinkAction, setIsSubmittingLinkAction] = useState(false);
  const [linkedAccountsMeta, setLinkedAccountsMeta] = useState<LinkedAccountsMeta>(() => {
    const account = getResolvedAccountContext();
    return {
      accountProvider: account.accountProvider,
      authMethod: account.authMethod,
      canManageLinks: Boolean(
        account.accountProvider &&
        account.authMethod &&
        account.accountProvider === account.authMethod
      ),
      manageWithProvider: account.accountProvider,
    };
  });

  // ─── Privacy state ───────────────────────────────────────────────────────

  const [dataCollection, setDataCollection] = useState(() => {
    return localStorage.getItem('privacy_data_collection') !== 'false';
  });

  const [historyDisabled, setHistoryDisabled] = useState(() => {
    return localStorage.getItem('settings_disable_history') === 'true';
  });
  const [showHistoryConfirm, setShowHistoryConfirm] = useState(false);
  const [showDataCollectionConfirm, setShowDataCollectionConfirm] = useState(false);

  // ─── Data popups state ───────────────────────────────────────────────────

  const [showIdPopup, setShowIdPopup] = useState(false);
  const [isClosingIdPopup, setIsClosingIdPopup] = useState(false);
  const [accountIdInfo, setAccountIdInfo] = useState<{ id: string; provider: 'discord' | 'google' | 'bip39' | 'oauth' | 'unknown' } | null>(null);

  const [showLocalStoragePopup, setShowLocalStoragePopup] = useState(false);
  const [isClosingLocalStoragePopup, setIsClosingLocalStoragePopup] = useState(false);
  const [localStorageData, setLocalStorageData] = useState<string>('');
  const [showNonSyncablePopup, setShowNonSyncablePopup] = useState(false);
  const [isClosingNonSyncablePopup, setIsClosingNonSyncablePopup] = useState(false);
  const [nonSyncableEntries, setNonSyncableEntries] = useState<NonSyncableLocalStorageEntry[]>([]);

  const [showImportPopup, setShowImportPopup] = useState(false);
  const [isClosingImportPopup, setIsClosingImportPopup] = useState(false);
  const [importData, setImportData] = useState<string>('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(() => localStorage.getItem('selected_profile_id'));
  const [storageMetrics, setStorageMetrics] = useState<LocalStorageMetrics>(() => getLocalStorageMetrics());
  const [serverSyncStats, setServerSyncStats] = useState<SyncServerStats | null>(null);
  const [isLoadingServerSyncStats, setIsLoadingServerSyncStats] = useState(false);

  // ─── Auth state ──────────────────────────────────────────────────────────

  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const visibleSections = React.useMemo(() => {
    if (isAuthenticated) return SECTIONS;
    return SECTIONS.filter(s => !['sessions', 'accounts', 'privacy', 'data'].includes(s.id));
  }, [isAuthenticated]);



  // ─── Check auth ──────────────────────────────────────────────────────────

  useEffect(() => {
    const checkAuth = () => {
      const auth = localStorage.getItem('auth');
      const discordAuth = localStorage.getItem('discord_auth');
      const googleAuth = localStorage.getItem('google_auth');
      const bip39Auth = localStorage.getItem('bip39_auth');
      const isAuth = discordAuth === 'true' || googleAuth === 'true' || bip39Auth === 'true' || !!auth;
      setIsAuthenticated(isAuth);
    };
    checkAuth();
    window.addEventListener('storage', checkAuth);
    window.addEventListener('auth_changed', checkAuth);
    return () => {
      window.removeEventListener('storage', checkAuth);
      window.removeEventListener('auth_changed', checkAuth);
    };
  }, []);

  useEffect(() => {
    const syncSoundEffectsPreference = () => {
      setSoundEffectsEnabledState(areSoundEffectsEnabled());
    };

    window.addEventListener('storage', syncSoundEffectsPreference);
    window.addEventListener(SOUND_EFFECTS_CHANGED_EVENT, syncSoundEffectsPreference as EventListener);

    return () => {
      window.removeEventListener('storage', syncSoundEffectsPreference);
      window.removeEventListener(SOUND_EFFECTS_CHANGED_EVENT, syncSoundEffectsPreference as EventListener);
    };
  }, []);

  const refreshStorageMetrics = useCallback(() => {
    setSelectedProfileId(localStorage.getItem('selected_profile_id'));
    setStorageMetrics(getLocalStorageMetrics());
  }, []);

  useEffect(() => {
    refreshStorageMetrics();

    const handleStorageMetricsRefresh = () => {
      refreshStorageMetrics();
    };

    window.addEventListener('storage', handleStorageMetricsRefresh);
    window.addEventListener('auth_changed', handleStorageMetricsRefresh);
    window.addEventListener('sync_storage_updated', handleStorageMetricsRefresh as EventListener);
    window.addEventListener('focus', handleStorageMetricsRefresh);

    const interval = window.setInterval(handleStorageMetricsRefresh, 5000);

    return () => {
      window.removeEventListener('storage', handleStorageMetricsRefresh);
      window.removeEventListener('auth_changed', handleStorageMetricsRefresh);
      window.removeEventListener('sync_storage_updated', handleStorageMetricsRefresh as EventListener);
      window.removeEventListener('focus', handleStorageMetricsRefresh);
      window.clearInterval(interval);
    };
  }, [refreshStorageMetrics]);

  const loadServerSyncStats = useCallback(async () => {
    const authToken = localStorage.getItem('auth_token');
    const profileId = localStorage.getItem('selected_profile_id');
    setSelectedProfileId(profileId);

    if (!isAuthenticated || !authToken || !profileId) {
      setServerSyncStats(null);
      setIsLoadingServerSyncStats(false);
      return;
    }

    try {
      setIsLoadingServerSyncStats(true);
      const response = await axios.get(`${API_URL}/api/sync/stats/${profileId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      setServerSyncStats(response.data?.stats || null);
    } catch (error) {
      console.error('Error loading sync stats:', error);
      setServerSyncStats(null);
    } finally {
      setIsLoadingServerSyncStats(false);
    }
  }, [isAuthenticated, selectedProfileId]);

  useEffect(() => {
    loadServerSyncStats();

    const handleSyncStatsRefresh = () => {
      loadServerSyncStats();
    };

    window.addEventListener('storage', handleSyncStatsRefresh);
    window.addEventListener('auth_changed', handleSyncStatsRefresh);
    window.addEventListener('sync_storage_updated', handleSyncStatsRefresh as EventListener);
    window.addEventListener('focus', handleSyncStatsRefresh);

    return () => {
      window.removeEventListener('storage', handleSyncStatsRefresh);
      window.removeEventListener('auth_changed', handleSyncStatsRefresh);
      window.removeEventListener('sync_storage_updated', handleSyncStatsRefresh as EventListener);
      window.removeEventListener('focus', handleSyncStatsRefresh);
    };
  }, [loadServerSyncStats]);

  // ─── Load VIP status ────────────────────────────────────────────────────

  useEffect(() => {
    const loadVipStatus = () => {
      const isVip = isUserVip();
      if (isVip) {
        const accessCodeExpires = localStorage.getItem('access_code_expires');
        let expiration = undefined;
        if (accessCodeExpires && accessCodeExpires !== 'never') {
          expiration = accessCodeExpires;
        }
        setVipStatus({ isVip: true, expiresAt: expiration, features: [t('settings.noAds')] });
      } else {
        setVipStatus({ isVip: false, features: [] });
      }
    };
    loadVipStatus();
    window.addEventListener('storage', loadVipStatus);
    return () => window.removeEventListener('storage', loadVipStatus);
  }, [t]);

  // ─── Load sessions ──────────────────────────────────────────────────────

  const getUserInfo = () => {
    const account = getResolvedAccountContext();
    if (!account.userType || !account.userId) return null;
    return { type: account.userType, id: account.userId };
  };

  const loadSessions = useCallback(async () => {
    try {
      const userInfo = getUserInfo();
      if (!userInfo || !['oauth', 'bip39'].includes(userInfo.type)) return;
      const response = await axios.get(`${API_URL}/api/sessions`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` }
      });
      const items = response.data?.data?.items || [];
      setSessions(items);
      const storedSessionId = localStorage.getItem('session_id');
      setCurrentSessionId(storedSessionId);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        clearStoredAuthSession();
        sessionStorage.clear();
        window.location.href = '/';
        return;
      }
      console.error('Error loading sessions:', err);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) loadSessions();
  }, [isAuthenticated, loadSessions]);

  const loadAccountLinks = useCallback(async () => {
    try {
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;

      setIsLoadingLinks(true);
      const response = await axios.get(`${API_URL}/api/auth/links`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data?.success && response.data.links) {
        setLinkedAccounts({
          discord: response.data.links.discord || { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
          google: response.data.links.google || { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
          bip39: response.data.links.bip39 || { linked: false, providerUserId: null, linkedAt: null, updatedAt: null },
        });
        setLinkedAccountsMeta({
          accountProvider: isLinkProvider(response.data.account?.provider) ? response.data.account.provider : null,
          authMethod: isLinkProvider(response.data.account?.authMethod) ? response.data.account.authMethod : null,
          canManageLinks: response.data.account?.canManageLinks !== false,
          manageWithProvider: isLinkProvider(response.data.account?.manageWithProvider) ? response.data.account.manageWithProvider : null,
        });
      }
    } catch (error) {
      console.error('Error loading account links:', error);
    } finally {
      setIsLoadingLinks(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      loadAccountLinks();
    }
  }, [isAuthenticated, loadAccountLinks]);

  // ─── Intersection Observer for active section ───────────────────────────

  // ─── Scroll Spy for Active Section ─────────────────────────────────────

  useEffect(() => {
    const handleScroll = () => {
      // 1. Check if we are at the bottom of the page
      const scrolledToBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 50;

      if (scrolledToBottom && visibleSections.length > 0) {
        // Force the last section to be active
        const lastSection = visibleSections[visibleSections.length - 1];
        if (activeSection !== lastSection.id) {
          setActiveSection(lastSection.id);
        }
        return;
      }

      // 2. Determine active section based on scroll position
      // Add offset for the fixed header (approx 100px or more)
      const scrollPosition = window.scrollY + 150;

      let currentSection: string = visibleSections[0]?.id || 'appearance';

      for (const section of visibleSections) {
        const element = document.getElementById(section.id);
        if (element) {
          // If we have scrolled past the top of this section, it's a candidate
          if (element.offsetTop <= scrollPosition) {
            currentSection = section.id;
          }
        }
      }

      if (currentSection !== activeSection) {
        setActiveSection(currentSection);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    // Trigger once on mount to set initial state correctly
    handleScroll();

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, [activeSection, visibleSections]);

  // ─── Lock body scroll on popups ──────────────────────────────────────────

  useEffect(() => {
    if (!showIdPopup && !showLocalStoragePopup && !showNonSyncablePopup && !showImportPopup && !linkModal) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const lenis = (window as Window & { lenis?: { stop: () => void; start: () => void } }).lenis;
    if (lenis) lenis.stop();
    return () => {
      document.body.style.overflow = original;
      if (lenis) lenis.start();
    };
  }, [showIdPopup, showLocalStoragePopup, showNonSyncablePopup, showImportPopup, linkModal]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handleAutoScrollToggle = () => {
    const newValue = !disableAutoScroll;
    setDisableAutoScroll(newValue);
    localStorage.setItem('settings_disable_auto_scroll', newValue.toString());
    window.dispatchEvent(new CustomEvent('settings_auto_scroll_changed'));
  };

  const handleRouteScrollToTopToggle = () => {
    const newValue = !disableRouteScrollToTop;
    setDisableRouteScrollToTop(newValue);
    localStorage.setItem('settings_disable_route_scroll_to_top', newValue.toString());
    window.dispatchEvent(new CustomEvent('settings_route_scroll_changed'));
  };

  const handleSmoothScrollToggle = () => {
    const newValue = !smoothScrollEnabled;
    setSmoothScrollEnabled(newValue);
    localStorage.setItem('settings_smooth_scroll', newValue.toString());
    window.dispatchEvent(new CustomEvent('settings_smooth_scroll_changed'));
  };

  const handleSoundEffectsToggle = () => {
    const newValue = !soundEffectsEnabled;
    setSoundEffectsEnabledState(newValue);
    setSoundEffectsEnabled(newValue);
  };

  const handleSnowfallToggle = () => {
    const newValue = !isSnowfallActive;
    setIsSnowfallActive(newValue);
    sessionStorage.setItem('snowfall_active', String(newValue));
    window.dispatchEvent(new CustomEvent('snowfall_toggled'));
  };

  const handleBgModeChange = (newMode: 'combined' | 'static' | 'animated') => {
    setBgMode(newMode);
    localStorage.setItem('settings_bg_mode', newMode);
  };

  const handleIntroToggle = () => {
    const newValue = !introEnabled;
    setIntroEnabled(newValue);
    localStorage.setItem('movix_intro_enabled', String(newValue));
    if (newValue) {
      localStorage.removeItem('movix_intro_seen');
    }
    window.dispatchEvent(new Event('intro_settings_changed'));
  };

  const handleScreensaverToggle = () => {
    const newValue = !screensaverEnabled;
    setScreensaverEnabled(newValue);
    localStorage.setItem('screensaver_enabled', String(newValue));
    window.dispatchEvent(new CustomEvent('screensaver_settings_changed'));
  };

  const handleScreensaverTimeoutChange = (seconds: number) => {
    setScreensaverTimeout(seconds);
    localStorage.setItem('screensaver_timeout', String(seconds));
    window.dispatchEvent(new CustomEvent('screensaver_settings_changed'));
  };

  const handleScreensaverModeChange = (mode: string) => {
    setScreensaverMode(mode);
    localStorage.setItem('screensaver_mode', mode);
    window.dispatchEvent(new CustomEvent('screensaver_settings_changed'));
  };

  const handleDataCollectionToggle = () => {
    if (dataCollection) {
      // Disabling → show confirmation
      setShowDataCollectionConfirm(true);
    } else {
      // Re-enabling
      setDataCollection(true);
      localStorage.setItem('privacy_data_collection', 'true');
    }
  };

  const confirmDisableDataCollection = async () => {
    setDataCollection(false);
    localStorage.setItem('privacy_data_collection', 'false');
    setShowDataCollectionConfirm(false);

    // Delete wrapped data on the backend
    try {
      const authToken = localStorage.getItem('auth_token');
      if (authToken) {
        await fetch(`${API_URL}/api/wrapped/data`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${authToken}` },
        });
      }
    } catch {
      // Silent fail — non-critical
    }
  };

  const handleHistoryToggle = () => {
    if (!historyDisabled) {
      // Enabling disable → show confirmation
      setShowHistoryConfirm(true);
    } else {
      // Re-enabling history
      setHistoryDisabled(false);
      localStorage.setItem('settings_disable_history', 'false');
    }
  };

  const confirmDisableHistory = () => {
    setHistoryDisabled(true);
    localStorage.setItem('settings_disable_history', 'true');
    localStorage.removeItem('continueWatching');
    setShowHistoryConfirm(false);
  };

  const handleActivatePremiumKey = async () => {
    if (!premiumKey.trim()) return;
    if (lastAttempt) {
      const elapsed = Date.now() - lastAttempt;
      if (elapsed < 30000) {
        const remaining = Math.ceil((30000 - elapsed) / 1000);
        setVipKeyError(t('settings.waitBeforeRetry', { seconds: remaining }));
        return;
      }
    }
    setIsActivatingKey(true);
    setVipKeyError(null);
    try {
      const discordAuth = localStorage.getItem('discord_auth') === 'true';
      const googleAuth = localStorage.getItem('google_auth') === 'true';
      const alreadyAuthenticated = discordAuth || googleAuth;
      const success = await checkAccessCode(premiumKey.trim(), alreadyAuthenticated);
      if (success) {
        const accessCodeExpires = localStorage.getItem('access_code_expires');
        let expiration = undefined;
        if (accessCodeExpires && accessCodeExpires !== 'never') expiration = accessCodeExpires;
        setVipStatus({ isVip: true, expiresAt: expiration, features: [t('settings.noAds')] });
        setPremiumKey('');
        setVipKeyError(null);
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('authStateChanged'));
      } else {
        setVipKeyError(authError || t('vip.invalidKey'));
      }
    } catch {
      setVipKeyError(t('vip.activationError'));
    } finally {
      setIsActivatingKey(false);
    }
  };

  const handleRemovePremiumKey = () => {
    localStorage.removeItem('is_vip');
    localStorage.removeItem('access_code');
    localStorage.removeItem('access_code_expires');
    setVipStatus({ isVip: false, features: [] });
    window.dispatchEvent(new Event('storage'));
  };

  const copyPremiumKey = () => {
    const accessCode = localStorage.getItem('access_code');
    if (accessCode) navigator.clipboard.writeText(accessCode);
  };

  const getProviderLabel = (provider: LinkProvider) => {
    if (provider === 'discord') return 'Discord';
    if (provider === 'google') return 'Google';
    return 'BIP39';
  };

  const openLinkModal = (provider: LinkProvider, action: 'link' | 'unlink') => {
    setIsClosingLinkModal(false);
    setLinkModal({ provider, action });
    setLinkActionError(null);
  };

  const closeLinkModal = () => {
    if (isSubmittingLinkAction) return;
    setIsClosingLinkModal(true);
    setTimeout(() => {
      setLinkModal(null);
      setIsClosingLinkModal(false);
      setLinkActionError(null);
    }, 220);
  };

  const handleConfirmLinkAction = async () => {
    if (!linkModal) return;

    const authToken = localStorage.getItem('auth_token');
    if (!authToken) {
      setLinkActionError('Session introuvable. Reconnectez-vous puis réessayez.');
      return;
    }

    setIsSubmittingLinkAction(true);
    setLinkActionError(null);

    try {
      if (linkModal.action === 'link') {
        if (linkModal.provider === 'google') {
          googleAuth.login({ mode: 'link', returnTo: '/settings#accounts' });
          return;
        }

        if (linkModal.provider === 'discord') {
          discordAuth.login({ mode: 'link', returnTo: '/settings#accounts' });
          return;
        }

        setPendingAuthLink('bip39', '/settings#accounts');
        closeLinkModal();
        window.setTimeout(() => {
          navigate('/link-bip39');
        }, 220);
        return;
      } else {
        const response = await axios.delete(`${API_URL}/api/auth/links/${linkModal.provider}`, {
          headers: { Authorization: `Bearer ${authToken}` }
        });

        if (!response.data?.success) {
          throw new Error(response.data?.error || 'Impossible de supprimer cette liaison');
        }
      }

      await loadAccountLinks();
      closeLinkModal();
    } catch (error: unknown) {
      const apiError = axios.isAxiosError(error)
        ? error.response?.data?.error
        : null;
      const message = error instanceof Error ? error.message : null;
      setLinkActionError(apiError || message || 'Une erreur est survenue');
    } finally {
      setIsSubmittingLinkAction(false);
    }
  };

  const deleteSession = async (sessionId: string) => {
    try {
      const userInfo = getUserInfo();
      if (!userInfo || !['oauth', 'bip39'].includes(userInfo.type)) return;
      const response = await axios.post(`${API_URL}/api/sessions/delete`, {
        sessionId
      }, {
        headers: { Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}` }
      });
      if (response.data.success) {
        setSessions(prev => prev.filter(s => s.id !== sessionId));
        if (sessionId === currentSessionId) {
          clearStoredAuthSession();
          window.location.href = '/';
        }
      }
    } catch (error) {
      console.error('Error deleting session:', error);
    }
  };

  // Data handlers
  const openIdPopup = () => {
    const account = getResolvedAccountContext();
    if (!account.userId) return;

    const currentAccountProvider = linkedAccountsMeta.accountProvider || account.accountProvider;
    const provider: 'discord' | 'google' | 'bip39' | 'oauth' | 'unknown' =
      currentAccountProvider === 'discord' || currentAccountProvider === 'google' || currentAccountProvider === 'bip39'
        ? currentAccountProvider
        : account.userType === 'oauth'
          ? 'oauth'
          : 'unknown';

    setAccountIdInfo({
      id: account.userId,
      provider,
    });
    setShowIdPopup(true);
  };

  const handleCloseIdPopup = () => {
    setIsClosingIdPopup(true);
    setTimeout(() => { setShowIdPopup(false); setIsClosingIdPopup(false); }, 300);
  };

  const copyLocalStorage = () => {
    try {
      const localStorageString = JSON.stringify(getAllLocalStorageEntries(), null, 2);
      setLocalStorageData(localStorageString);
      setShowLocalStoragePopup(true);
    } catch (error) {
      console.error('Erreur lors de la copie du localStorage:', error);
    }
  };

  const handleCloseLocalStoragePopup = () => {
    setIsClosingLocalStoragePopup(true);
    setTimeout(() => { setShowLocalStoragePopup(false); setIsClosingLocalStoragePopup(false); }, 300);
  };

  const openNonSyncablePopup = () => {
    setNonSyncableEntries(getNonSyncableLocalStorageEntries());
    setShowNonSyncablePopup(true);
  };

  const handleCloseNonSyncablePopup = () => {
    setIsClosingNonSyncablePopup(true);
    setTimeout(() => {
      setShowNonSyncablePopup(false);
      setIsClosingNonSyncablePopup(false);
    }, 300);
  };

  const copyNonSyncableKeys = () => {
    const payload = JSON.stringify(
      nonSyncableEntries.map((entry) => ({
        key: entry.key,
        bytes: entry.bytes,
        reason: entry.reason,
      })),
      null,
      2
    );
    navigator.clipboard.writeText(payload);
  };

  const handleCloseImportPopup = () => {
    setIsClosingImportPopup(true);
    setTimeout(() => {
      setShowImportPopup(false);
      setIsClosingImportPopup(false);
      setImportData('');
      setImportError(null);
      setImportSuccess(null);
    }, 300);
  };

  const handleImportData = () => {
    if (!importData.trim()) { setImportError(t('settings.enterDataToImport')); return; }
    try {
      const data = JSON.parse(importData);
      let importedCount = 0;
      let filteredCount = 0;
      const errors: string[] = [];
      Object.entries(data).forEach(([key, value]) => {
        try {
          if (!isSyncableStorageKey(key)) {
            filteredCount++;
            return;
          }

          if (typeof value === 'string') {
            try {
              const parsedValue = JSON.parse(value);
              if (Array.isArray(parsedValue)) {
                const convertedArray = parsedValue.map((item: ImportedMediaItem) => {
                  if (item.episodeInfo) {
                    return { id: item.id, type: item.type, title: item.title || '', poster_path: item.poster_path || '', episodeInfo: item.episodeInfo, addedAt: item.addedAt || new Date().toISOString() };
                  } else {
                    return { id: item.id, type: item.type, title: item.title || item.name || '', poster_path: item.poster_path || '', addedAt: item.addedAt || new Date().toISOString() };
                  }
                });
                localStorage.setItem(key, JSON.stringify(convertedArray));
                importedCount++;
              } else {
                localStorage.setItem(key, JSON.stringify(parsedValue));
                importedCount++;
              }
            } catch {
              localStorage.setItem(key, value as string);
              importedCount++;
            }
          } else {
            localStorage.setItem(key, JSON.stringify(value));
            importedCount++;
          }
        } catch (itemError) {
          errors.push(`Erreur pour la clé "${key}": ${itemError}`);
        }
      });
      if (errors.length > 0 || filteredCount > 0) {
        setImportError(
          filteredCount > 0
            ? t('settings.importFiltered', { count: filteredCount })
            : t('settings.importPartial', { count: importedCount })
        );
      } else {
        setImportSuccess(t('settings.importSuccess', { count: importedCount }));
      }
      refreshStorageMetrics();
      window.dispatchEvent(new CustomEvent('sync_storage_updated'));
      setTimeout(() => window.location.reload(), 2000);
    } catch {
      setImportError(t('settings.importError'));
    }
  };

  // ─── Sidebar scroll-to handler ───────────────────────────────────────────

  const scrollToSection = (sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) {
      const isMobile = window.innerWidth < 1024;
      const topOffset = isMobile ? 112 : 96;
      const targetTop = Math.max(0, window.scrollY + el.getBoundingClientRect().top - topOffset);
      const lenis = (window as Window & {
        lenis?: {
          scrollTo: (
            target: number,
            options?: { duration?: number; immediate?: boolean; force?: boolean }
          ) => void;
        };
      }).lenis;

      if (lenis?.scrollTo) {
        lenis.scrollTo(targetTop, { duration: 0.8, force: true });
      } else {
        window.scrollTo({ top: targetTop, behavior: 'smooth' });
      }

      setActiveSection(sectionId);
    }
  };

  // ─── Render helpers ──────────────────────────────────────────────────────

  const renderToggle = (value: boolean, onToggle: () => void, color: string = 'red') => {
    const bgActive = color === 'blue' ? 'bg-blue-500' : color === 'purple' ? 'bg-purple-500' : color === 'green' ? 'bg-green-500' : 'bg-red-600';
    return (
      <button
        onClick={onToggle}
        className={`relative ml-4 w-14 h-8 rounded-full transition-colors duration-300 flex-shrink-0 ${value ? bgActive : 'bg-gray-600'}`}
      >
        <span
          className={`absolute top-1 left-1 w-6 h-6 bg-white rounded-full shadow-md transform transition-transform duration-300 ${value ? 'translate-x-6' : 'translate-x-0'}`}
        />
      </button>
    );
  };

  const getDeviceIcon = (userAgent: string) => {
    const ua = userAgent.toLowerCase();
    if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
      return <Smartphone className="w-5 h-5" />;
    } else if (ua.includes('tablet') || ua.includes('ipad')) {
      return <Tablet className="w-5 h-5" />;
    }
    return <Monitor className="w-5 h-5" />;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffMins < 1) return t('common.justNow');
    if (diffMins < 60) return t('common.minutesAgo', { count: diffMins });
    if (diffHours < 24) return t('common.hoursAgo', { count: diffHours });
    if (diffDays < 7) return t('common.daysAgo', { count: diffDays });
    return date.toLocaleDateString(i18n.language);
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  const resolvedAccount = getResolvedAccountContext();
  const currentAccountProvider = linkedAccountsMeta.accountProvider || resolvedAccount.accountProvider;
  const currentAuthMethod = linkedAccountsMeta.authMethod || resolvedAccount.authMethod;
  const currentManagementProvider = linkedAccountsMeta.manageWithProvider || currentAccountProvider;
  const canManageLinkedAccounts = linkedAccountsMeta.canManageLinks;
  const currentAuthMethodLinked = currentAuthMethod ? linkedAccounts[currentAuthMethod].linked : false;
  const canShowAccountId = Boolean(resolvedAccount.userId);
  const nonSyncableKeyCount = Math.max(0, storageMetrics.totalKeys - storageMetrics.syncableKeys);
  const nonSyncableBytes = Math.max(0, storageMetrics.totalBytes - storageMetrics.syncableBytes);
  const serverQuotaUsagePercent = serverSyncStats?.profileQuotaBytes
    ? Math.min(100, Math.round((serverSyncStats.profileBytes / serverSyncStats.profileQuotaBytes) * 100))
    : 0;
  const hasServerStorageContext = Boolean(isAuthenticated && selectedProfileId);

  return (
    <SquareBackground mode={bgMode} borderColor="rgba(239, 68, 68, 0.15)" className="min-h-screen bg-[#0a0a0f] text-white">
      {/* Mobile Header */}
      <div className="lg:hidden flex items-center gap-4 p-4 border-b border-gray-800/60 bg-[#0a0a0f]">
        <button
          onClick={() => navigate(-1)}
          className="p-2 rounded-lg hover:bg-gray-800/60 transition-colors text-gray-400 hover:text-white"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-red-600/20 to-orange-600/20 border border-red-500/20">
            <Settings className="w-5 h-5 text-red-400" />
          </div>
          <h1 className="text-lg font-semibold text-white">{t('settings.title')}</h1>
        </div>
      </div>

      {/* Main layout: fixed sidebar + scrollable content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:pt-24">
        <div className="flex gap-8">

          {/* ─── Fixed Sidebar ──────────────────────────────────────── */}
          <nav className="hidden lg:flex lg:flex-col fixed left-0 top-16 md:top-20 bottom-0 w-64 z-40 bg-[#0a0a0f] border-r border-gray-800/60 px-4 py-6 overflow-y-auto">
            {/* Settings Header in Sidebar */}
            <div className="flex items-center gap-3 mb-6 pb-6 border-b border-gray-800/40">
              <button
                onClick={() => navigate(-1)}
                className="p-2 rounded-lg hover:bg-gray-800/60 transition-colors text-gray-400 hover:text-white"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div className="p-2 rounded-xl bg-gradient-to-br from-red-600/20 to-orange-600/20 border border-red-500/20">
                <Settings className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-white">{t('settings.title')}</h1>
                <p className="text-xs text-gray-500">{t('settings.subtitle')}</p>
              </div>
            </div>

            <ul className="space-y-1">
              {visibleSections.map(({ id, labelKey, icon: Icon }) => {
                const isActive = activeSection === id;
                return (
                  <li key={id}>
                    <button
                      onClick={() => scrollToSection(id)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors duration-200 border focus:outline-none ${isActive
                        ? 'bg-red-600/15 text-red-400 border-red-500/20 shadow-sm shadow-red-600/5'
                        : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-800/40'
                        }`}
                    >
                      <Icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-red-400' : 'text-gray-500'}`} />
                      {t(labelKey)}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Back to profile link */}
            <div className="mt-auto pt-6 border-t border-gray-800/40">
              <Link
                to="/profile"
                className="flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm text-gray-500 hover:text-gray-300 hover:bg-gray-800/40 transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                {t('nav.backToProfile')}
              </Link>
            </div>
          </nav>

          {/* ─── Mobile Section Tabs ────────────────────────────────── */}
          <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#0a0a0f]/95 backdrop-blur-xl border-t border-gray-800/60 px-2 pb-[env(safe-area-inset-bottom)]">
            <div className="flex items-center justify-center gap-2 pt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-gray-500">
              <span className="h-px w-5 bg-gray-800/80" />
              <span>{t('settings.mobileTabsHint')}</span>
              <span className="h-px w-5 bg-gray-800/80" />
            </div>
            <div className="relative">
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-[#0a0a0f] to-transparent" />
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-[#0a0a0f] to-transparent" />
              <div className="overflow-x-auto scrollbar-hide touch-pan-x scroll-smooth">
                <div className="mx-auto flex w-max min-w-full justify-center gap-1 px-2 py-2">
                  {visibleSections.map(({ id, labelKey, icon: Icon }) => {
                    const isActive = activeSection === id;
                    return (
                      <button
                        key={id}
                        onClick={() => scrollToSection(id)}
                        className={`flex w-[92px] flex-shrink-0 flex-col items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-center transition-all ${isActive ? 'text-red-400' : 'text-gray-500'
                          }`}
                      >
                        <Icon className="w-4 h-4" />
                        <span className="text-[10px] font-medium whitespace-nowrap">{t(labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* ─── Scrollable Content ─────────────────────────────────── */}
          <div ref={contentRef} className="flex-1 min-w-0 space-y-12 pb-24 lg:pb-8 lg:ml-72">

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Apparence                                      */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="appearance" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-purple-600/20 to-pink-600/20 border border-purple-500/20">
                  <Palette className="w-5 h-5 text-purple-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.appearance')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.appearanceDesc')}</p>
                </div>
              </div>

              <div className="space-y-3">
                {/* Conserver la position entre les pages */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.025 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all group"
                >
                  <div className="flex-1 mr-4">
                    <h4 className="font-medium text-white mb-0.5 text-sm">{t('settings.keepScrollPositionBetweenPages')}</h4>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.keepScrollPositionBetweenPagesDesc')}
                    </p>
                  </div>
                  {renderToggle(disableRouteScrollToTop, handleRouteScrollToTopToggle)}
                </motion.div>

                {/* Conserver la position */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all group"
                >
                  <div className="flex-1 mr-4">
                    <h4 className="font-medium text-white mb-0.5 text-sm">{t('settings.keepScrollPosition')}</h4>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.keepScrollPositionDesc')}
                    </p>
                  </div>
                  {renderToggle(disableAutoScroll, handleAutoScrollToggle)}
                </motion.div>

                {/* Smooth scroll */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all group"
                >
                  <div className="flex-1 mr-4">
                    <h4 className="font-medium text-white mb-0.5 text-sm">{t('settings.smoothScroll')}</h4>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.smoothScrollDesc')}
                    </p>
                  </div>
                  {renderToggle(smoothScrollEnabled, handleSmoothScrollToggle)}
                </motion.div>

                {/* Bruitages */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.125 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all group"
                >
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Volume2 className="w-3.5 h-3.5 text-orange-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.soundEffects')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.soundEffectsDesc')}
                    </p>
                  </div>
                  {renderToggle(soundEffectsEnabled, handleSoundEffectsToggle)}
                </motion.div>

                {/* Effet neige */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 }}
                  className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all group"
                >
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Snowflake className="w-3.5 h-3.5 text-blue-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.snowEffect')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.snowEffectDesc')}
                    </p>
                  </div>
                  {renderToggle(isSnowfallActive, handleSnowfallToggle, 'blue')}
                </motion.div>

                {/* Style de fond */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all"
                >
                  <div className="mb-3">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Activity className="w-3.5 h-3.5 text-red-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.backgroundStyle')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.backgroundStyleDesc')}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {([
                      { value: 'combined' as const, label: t('settings.bgCombined'), desc: t('settings.bgCombinedDesc') },
                      { value: 'static' as const, label: t('settings.bgStatic'), desc: t('settings.bgStaticDesc') },
                      { value: 'animated' as const, label: t('settings.bgAnimated'), desc: t('settings.bgAnimatedDesc') },
                    ]).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => handleBgModeChange(opt.value)}
                        className={`flex-1 min-w-[100px] p-3 rounded-xl text-left transition-all border ${bgMode === opt.value
                          ? 'bg-red-600/10 border-red-500/30 text-white'
                          : 'bg-gray-700/20 border-gray-700/40 text-gray-400 hover:bg-gray-700/40 hover:text-white'
                        }`}
                      >
                        <div className="text-xs font-semibold">{opt.label}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5">{opt.desc}</div>
                      </button>
                    ))}
                  </div>
                </motion.div>

                {/* Screensaver */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 mr-4">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Monitor className="w-3.5 h-3.5 text-purple-400" />
                        <h4 className="font-medium text-white text-sm">{t('settings.screensaver')}</h4>
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('settings.screensaverDesc')}
                      </p>
                    </div>
                    {renderToggle(screensaverEnabled, handleScreensaverToggle)}
                  </div>

                  <AnimatePresence>
                    {screensaverEnabled && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-4 space-y-4 pt-4 border-t border-gray-700/30">
                          <div>
                            <label className="text-xs font-medium text-gray-400 mb-2 block">
                              {t('settings.inactivityDelay')}
                            </label>
                            <div className="flex gap-2 flex-wrap">
                              {[
                                { value: 30, label: '30s' },
                                { value: 60, label: '1 min' },
                                { value: 120, label: '2 min' },
                                { value: 300, label: '5 min' },
                                { value: 600, label: '10 min' },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  onClick={() => handleScreensaverTimeoutChange(opt.value)}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${screensaverTimeout === opt.value
                                    ? 'bg-red-600 text-white shadow-lg shadow-red-600/20'
                                    : 'bg-gray-700/40 text-gray-400 hover:bg-gray-700 hover:text-white'
                                    }`}
                                >
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-gray-400 mb-2 block">
                              {t('settings.screensaverStyle')}
                            </label>
                            <div className="flex gap-2 flex-wrap">
                              {[
                                { value: 'backdrop', label: t('settings.cinematicCarousel'), desc: t('settings.cinematicCarouselDesc') },
                                { value: 'mosaic', label: t('settings.favoriteMosaic'), desc: t('settings.favoriteMosaicDesc') },
                              ].map((opt) => (
                                <button
                                  key={opt.value}
                                  onClick={() => handleScreensaverModeChange(opt.value)}
                                  className={`flex-1 min-w-[140px] p-3 rounded-xl text-left transition-all border ${screensaverMode === opt.value
                                    ? 'bg-red-600/10 border-red-500/30 text-white'
                                    : 'bg-gray-700/20 border-gray-700/40 text-gray-400 hover:bg-gray-700/40 hover:text-white'
                                    }`}
                                >
                                  <div className="text-xs font-semibold">{opt.label}</div>
                                  <div className="text-[10px] text-gray-500 mt-0.5">{opt.desc}</div>
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>

                {/* Intro Breaking Bad */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.35 }}
                  className="p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 mr-4">
                      <div className="flex items-center gap-2 mb-0.5">
                        <FlaskConical className="w-3.5 h-3.5 text-green-400" />
                        <h4 className="font-medium text-white text-sm">{t('settings.introAnimation')}</h4>
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('settings.introAnimationDesc')}
                      </p>
                    </div>
                    {renderToggle(introEnabled, handleIntroToggle, 'green')}
                  </div>
                </motion.div>
              </div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Langue                                         */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="language" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-sky-600/20 to-blue-600/20 border border-sky-500/20">
                  <Globe className="w-5 h-5 text-sky-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.language')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.languageDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="space-y-3"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {AVAILABLE_LANGUAGES.map((lang) => {
                    const isActive = i18n.language === lang.code;
                    return (
                      <button
                        key={lang.code}
                        onClick={() => changeLanguage(lang.code as SupportedLanguage)}
                        className={`flex items-center gap-4 p-4 rounded-xl border transition-all ${
                          isActive
                            ? 'bg-sky-600/15 border-sky-500/30 text-white shadow-sm shadow-sky-600/5'
                            : 'bg-gray-800/30 border-gray-700/40 text-gray-400 hover:bg-gray-800/50 hover:border-gray-600/50 hover:text-white'
                        }`}
                      >
                        <span className="text-2xl"><img src={lang.flagUrl} alt={lang.label} className="w-8 h-6 rounded-sm object-cover" /></span>
                        <div className="text-left">
                          <div className={`text-sm font-medium ${isActive ? 'text-sky-300' : 'text-white'}`}>{lang.label}</div>
                          <div className="text-xs text-gray-500">{lang.code.toUpperCase()}</div>
                        </div>
                        {isActive && (
                          <div className="ml-auto w-2 h-2 rounded-full bg-sky-400" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: VIP                                            */}
            {/* ════════════════════════════════════════════════════════ */}
            <section id="vip" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-yellow-600/20 to-amber-600/20 border border-yellow-500/20">
                  <Crown className="w-5 h-5 text-yellow-400" />
                </div>
                <div>
            <h2 className="text-xl font-semibold text-white">{t('vip.title')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.vipDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="bg-gray-800/30 rounded-xl border border-gray-700/40 p-6"
              >
                {!vipStatus.isVip ? (
                  <div className="space-y-4">
                    <div className="flex items-start gap-3 p-4 bg-yellow-500/5 rounded-xl border border-yellow-500/10">
                      <Key className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <h4 className="text-sm font-medium text-yellow-300">{t('settings.activateVipKey')}</h4>
                        <p className="text-xs text-gray-400 mt-1">{t('settings.activateVipKeyDesc')}</p>
                      </div>
                    </div>
                    <div className="flex flex-col md:flex-row gap-3">
                      <input
                        className="flex h-11 w-full rounded-lg pr-3 pl-4 py-2 text-sm bg-gray-900/60 border border-gray-700/50 focus:border-yellow-500/50 focus:bg-gray-900/80 text-white placeholder:text-gray-600 outline-none transition-all"
                        placeholder={t('settings.enterVipKey')}
                        value={premiumKey}
                        onChange={(e) => setPremiumKey(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleActivatePremiumKey()}
                      />
                      <button
                        className={`flex items-center justify-center font-medium h-11 text-sm px-6 rounded-lg bg-yellow-500 text-black hover:bg-yellow-400 transition-all whitespace-nowrap flex-shrink-0 ${!premiumKey.trim() || isActivatingKey ? 'opacity-30 pointer-events-none' : ''
                          }`}
                        onClick={handleActivatePremiumKey}
                        disabled={!premiumKey.trim() || isActivatingKey}
                      >
                        {isActivatingKey ? t('settings.activating') : t('settings.activate')}
                      </button>
                    </div>
                    {vipKeyError && (
                      <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="text-red-400 text-xs bg-red-500/10 p-3 rounded-lg border border-red-500/20"
                      >
                        {vipKeyError}
                      </motion.p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3 p-4 bg-yellow-500/10 rounded-xl border border-yellow-500/20">
                      <Crown className="w-5 h-5 text-yellow-400 flex-shrink-0" />
                      <div>
                        <h4 className="text-sm font-semibold text-yellow-300">{t('settings.youAreVip')}</h4>
                        <p className="text-xs text-gray-400 mt-0.5">{t('settings.vipDescription')}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40">
                      <CalendarClock className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                      <div>
                        <span className="text-xs text-gray-500">{t('settings.vipExpiresOn')}</span>
                        <p className="text-sm text-white font-medium">
                          {vipStatus.expiresAt
                            ? (() => {
                                const d = new Date(isNaN(Number(vipStatus.expiresAt)) ? vipStatus.expiresAt : Number(vipStatus.expiresAt));
                                return isNaN(d.getTime()) ? t('settings.vipNoExpiration') : d.toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' });
                              })()
                            : t('settings.vipNoExpiration')
                          }
                        </p>
                      </div>
                    </div>

                    <div
                      className="flex flex-col gap-2 border border-gray-700/40 rounded-xl px-4 pt-4 pb-3 cursor-pointer hover:border-gray-600/50 transition-colors"
                      onMouseEnter={() => setIsVipKeyHovered(true)}
                      onMouseLeave={() => setIsVipKeyHovered(false)}
                    >
                      <span className="text-xs text-gray-500">{t('settings.yourVipKey')}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-mono transition-opacity duration-200" style={{ opacity: isVipKeyHovered ? 0 : 1, display: isVipKeyHovered ? 'none' : 'block' }}>
                          {localStorage.getItem('access_code')?.replace(/./g, '•') || '••••••••••••'}
                        </span>
                        <span className="text-white text-sm font-mono transition-opacity duration-200" style={{ opacity: isVipKeyHovered ? 1 : 0, display: isVipKeyHovered ? 'block' : 'none' }}>
                          {localStorage.getItem('access_code') || ''}
                        </span>
                        <button onClick={copyPremiumKey} className="ml-auto p-1.5 rounded-lg hover:bg-gray-700/50 text-gray-500 hover:text-white transition-colors">
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <button
                      className="text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 px-4 py-2 rounded-lg transition-all"
                      onClick={handleRemovePremiumKey}
                    >
                      {t('settings.removeVipKey')}
                    </button>
                  </div>
                )}
              </motion.div>
            </section>

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Sessions                                       */}
            {/* ════════════════════════════════════════════════════════ */}
            {isAuthenticated && (
            <section id="sessions" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-green-600/20 to-emerald-600/20 border border-green-500/20">
                  <Monitor className="w-5 h-5 text-green-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.activeSessions')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.sessionsDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
              >
                {(() => {
                  const userInfo = getUserInfo();
                  if (!isAuthenticated || !userInfo || !['oauth', 'bip39'].includes(userInfo.type)) {
                    return (
                      <div className="text-center py-12 bg-gray-800/20 rounded-xl border border-gray-700/30">
                        <div className="p-3 bg-gray-800/50 rounded-full w-14 h-14 mx-auto mb-4 flex items-center justify-center">
                          <Lock className="w-6 h-6 text-gray-500" />
                        </div>
                        <h3 className="text-sm font-medium text-gray-400 mb-1">{t('settings.sessionsNotAvailable')}</h3>
                        <p className="text-xs text-gray-600 max-w-sm mx-auto">
                          {t('settings.sessionsNotAvailableDesc')}
                        </p>
                      </div>
                    );
                  }

                  if (sessions.length === 0) {
                    return (
                      <div className="text-center py-12 bg-gray-800/20 rounded-xl border border-gray-700/30">
                        <div className="p-3 bg-gray-800/50 rounded-full w-14 h-14 mx-auto mb-4 flex items-center justify-center">
                          <Monitor className="w-6 h-6 text-gray-500" />
                        </div>
                        <h3 className="text-sm font-medium text-gray-400 mb-1">{t('settings.noActiveSessions')}</h3>
                        <p className="text-xs text-gray-600">{t('settings.noActiveSessionsDesc')}</p>
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-3">
                      <AnimatePresence>
                        {sessions.map((session) => {
                          const isCurrentSession = session.id === currentSessionId;
                          return (
                            <motion.div
                              key={session.id}
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              className={`bg-gray-800/30 rounded-xl p-4 border transition-all ${isCurrentSession
                                ? 'border-green-500/30 bg-green-900/10'
                                : 'border-gray-700/40 hover:border-gray-600/50'
                                }`}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center space-x-4">
                                  <div className={`p-2.5 rounded-xl ${isCurrentSession ? 'bg-green-500/15 text-green-400' : 'bg-gray-700/40 text-gray-400'}`}>
                                    {getDeviceIcon(session.userAgent)}
                                  </div>
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                      <h4 className="font-medium text-white text-sm">
                                        {session.userAgent.includes('Chrome') ? 'Chrome' :
                                          session.userAgent.includes('Firefox') ? 'Firefox' :
                                            session.userAgent.includes('Safari') ? 'Safari' :
                                              session.userAgent.includes('Edge') ? 'Edge' : t('common.unknown')}
                                      </h4>
                                      {isCurrentSession && (
                                        <span className="px-2 py-0.5 text-[10px] bg-green-500/15 text-green-400 rounded-full font-medium">
                                          {t('settings.currentSession')}
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                                      <p>{t('settings.createdOn')} {new Date(session.createdAt).toLocaleDateString(i18n.language)} {t('common.at')} {new Date(session.createdAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</p>
                                      <p>{t('settings.lastActivity')}: {formatDate(session.accessedAt)}</p>
                                    </div>
                                  </div>
                                </div>
                                {!isCurrentSession && (
                                  <motion.button
                                    onClick={() => deleteSession(session.id)}
                                    className="p-2 hover:bg-red-500/15 rounded-lg transition-colors text-gray-500 hover:text-red-400"
                                    whileHover={{ scale: 1.1 }}
                                    whileTap={{ scale: 0.9 }}
                                    title={t('auth.disconnectSession')}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </motion.button>
                                )}
                              </div>
                            </motion.div>
                          );
                        })}
                      </AnimatePresence>
                    </div>
                  );
                })()}
              </motion.div>
            </section>
            )}

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Confidentialité                                */}
            {/* ════════════════════════════════════════════════════════ */}
            {isAuthenticated && (
            <section id="accounts" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-indigo-600/20 to-blue-600/20 border border-indigo-500/20">
                  <Link2 className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.linkedAccountsTitle', 'Comptes liés')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.linkedAccountsDesc', 'Choisissez quels moyens de connexion doivent ouvrir ce compte Movix.')}</p>
                </div>
              </div>

              {(() => {
                const account = getResolvedAccountContext();
                const currentAccountProvider = linkedAccountsMeta.accountProvider || account.accountProvider;
                const accountProviderLabel = currentAccountProvider ? getProviderLabel(currentAccountProvider) : null;
                const authMethodLabel = currentAuthMethod ? getProviderLabel(currentAuthMethod) : null;

                if (!accountProviderLabel) return null;

                return (
                  <div className="mb-4 rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-3">
                    <p className="text-sm font-medium text-white">
                      {t('settings.linkedAccountsCurrentAccount', {
                        provider: accountProviderLabel,
                        defaultValue: `Compte actuel : ${accountProviderLabel}`,
                      })}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-indigo-100/80">
                      {currentAuthMethod && currentAuthMethod !== currentAccountProvider
                        ? currentAuthMethodLinked
                          ? t('settings.linkedAccountsRedirectSummary', {
                            method: authMethodLabel,
                            provider: accountProviderLabel,
                            defaultValue: `Vous êtes connecté avec ${authMethodLabel}, mais Movix vous a redirigé vers ce compte ${accountProviderLabel}.`,
                          })
                          : t('settings.linkedAccountsSessionNoLongerLinkedSummary', {
                              method: authMethodLabel,
                              defaultValue: `Vous êtes connecté avec ${authMethodLabel} pour cette session, mais aucune redirection ${authMethodLabel} n'est active actuellement. Une prochaine connexion ${authMethodLabel} rouvrira son propre compte Movix.`,
                            })
                        : t('settings.linkedAccountsDirectSummary', {
                            provider: accountProviderLabel,
                            defaultValue: `Les connexions ${accountProviderLabel} arrivent déjà ici sans redirection.`,
                          })}
                    </p>
                  </div>
                );
              })()}

              {!canManageLinkedAccounts && currentManagementProvider && (
                <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                  <p className="text-xs leading-relaxed text-amber-100/90">
                    {t('settings.linkedAccountsManageHint', {
                      provider: getProviderLabel(currentManagementProvider),
                      defaultValue: `Pour modifier les liaisons de ce compte, reconnectez-vous avec ${getProviderLabel(currentManagementProvider)}.`,
                    })}
                  </p>
                </div>
              )}

              <div className="space-y-3">
                {(['discord', 'google', 'bip39'] as LinkProvider[]).map((provider, index) => {
                  const status = linkedAccounts[provider];
                  const providerLabel = getProviderLabel(provider);
                  const isCurrentMethod = currentAuthMethod === provider;
                  const isCurrentAccount = currentAccountProvider === provider;
                  const currentAuthLabel = currentAuthMethod ? getProviderLabel(currentAuthMethod) : providerLabel;
                  const isActionDisabled = isLoadingLinks || !canManageLinkedAccounts;
                  const accentClass =
                    provider === 'discord'
                      ? 'from-[#5865F2]/15 to-[#5865F2]/5 border-[#5865F2]/20'
                      : provider === 'google'
                        ? 'from-white/10 to-white/5 border-white/10'
                        : 'from-emerald-500/15 to-emerald-500/5 border-emerald-500/20';
                  const cardDescription = isCurrentAccount
                    ? isCurrentMethod
                      ? t('settings.linkedAccountsTargetDirectDescription', {
                          provider: providerLabel,
                          defaultValue: `C'est le compte Movix ${providerLabel} actuellement ouvert. Les connexions ${providerLabel} arrivent déjà ici sans redirection.`,
                        })
                      : t('settings.linkedAccountsTargetRedirectedDescription', {
                          provider: providerLabel,
                          method: currentAuthLabel,
                          defaultValue: `C'est le compte Movix ${providerLabel} actuellement ouvert. Vous êtes arrivé ici via ${currentAuthLabel}, car ce moyen est redirigé vers ce compte.`,
                        })
                    : status.linked
                      ? isCurrentMethod
                        ? t('settings.linkedAccountsCurrentMethodRedirectDescription', {
                            provider: providerLabel,
                            defaultValue: `Vous êtes connecté avec ${providerLabel}. Comme il est lié à ce compte, Movix vous a redirigé ici.`,
                          })
                        : t('settings.linkedAccountsLinkedDescription', {
                            provider: providerLabel,
                            defaultValue: `Quand vous vous connecterez avec ${providerLabel}, Movix vous redirigera vers ce compte.`,
                          })
                      : isCurrentMethod
                        ? t('settings.linkedAccountsCurrentMethodInactiveDescription', {
                            provider: providerLabel,
                            defaultValue: `Vous êtes connecté avec ${providerLabel} pour cette session, mais aucune redirection n'est active actuellement. Une prochaine connexion ${providerLabel} rouvrira son propre compte Movix.`,
                          })
                        : t('settings.linkedAccountsInactiveDescription', {
                          provider: providerLabel,
                          defaultValue: `Aucune redirection active. Vous pouvez lier ${providerLabel} à ce compte pour que les prochaines connexions arrivent ici.`,
                        });
                  const linkedProviderId = status.providerUserId
                    ? t('settings.linkedAccountsLinkedId', {
                        id: status.providerUserId,
                        defaultValue: `ID lié : ${status.providerUserId}`,
                      })
                    : null;

                  return (
                    <motion.div
                      key={provider}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 * (index + 1) }}
                      className={`p-4 rounded-xl border bg-gradient-to-br ${accentClass}`}
                    >
                      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                            <h4 className="font-medium text-white text-sm">{providerLabel}</h4>
                            {isCurrentAccount && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-indigo-500/15 text-indigo-200 border border-indigo-500/20">
                                {t('settings.linkedAccountsTargetBadge', 'Compte actuel')}
                              </span>
                            )}
                            {status.linked && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-green-500/15 text-green-300 border border-green-500/20">
                                {t('settings.linkedAccountsActive', 'Redirection active')}
                              </span>
                            )}
                            {isCurrentMethod && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-500/15 text-blue-300 border border-blue-500/20">
                                {t('settings.linkedAccountsCurrentMethod', 'Connexion actuelle')}
                              </span>
                            )}
                            {!isCurrentAccount && !status.linked && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] bg-gray-700/40 text-gray-400 border border-gray-700/50">
                                {t('settings.linkedAccountsInactive', 'Non lié')}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 leading-relaxed">{cardDescription}</p>
                          {linkedProviderId && (
                            <p className="mt-2 break-all font-mono text-[11px] text-gray-500">
                              {linkedProviderId}
                            </p>
                          )}
                        </div>

                        {isCurrentAccount ? (
                          <div className="px-4 py-2.5 rounded-xl text-sm font-medium md:min-w-[180px] bg-gray-700/30 text-gray-500 border border-gray-700/40 text-center opacity-70">
                            {t('settings.linkedAccountsTargetButton', 'Compte actuel')}
                          </div>
                        ) : (
                        <button
                          onClick={() => openLinkModal(provider, status.linked ? 'unlink' : 'link')}
                          disabled={isActionDisabled}
                          className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-colors md:min-w-[180px] ${
                            status.linked
                              ? 'bg-red-500/10 text-red-300 border border-red-500/20 hover:bg-red-500/15'
                              : 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 hover:bg-indigo-500/15'
                          } ${isActionDisabled ? 'opacity-50 cursor-not-allowed hover:bg-transparent' : ''}`}
                        >
                          {status.linked
                            ? t('settings.unlinkAccountButton', 'Désactiver la redirection')
                            : t('settings.linkAccountButton', 'Lier à ce compte')}
                        </button>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </section>
            )}

            {isAuthenticated && (
            <section id="privacy" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-blue-600/20 to-cyan-600/20 border border-blue-500/20">
                  <Shield className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.privacy')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.privacyDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="space-y-3"
              >
                <div className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all">
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Activity className="w-3.5 h-3.5 text-blue-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.analyticsCollection')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.analyticsCollectionDesc')}
                    </p>
                  </div>
                  {renderToggle(dataCollection, handleDataCollectionToggle, 'blue')}
                </div>

                <div className="flex items-center justify-between p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 transition-all">
                  <div className="flex-1 mr-4">
                    <div className="flex items-center gap-2 mb-0.5">
                      <History className="w-3.5 h-3.5 text-blue-400" />
                      <h4 className="font-medium text-white text-sm">{t('settings.disableHistory')}</h4>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                      {t('settings.disableHistoryDesc')}
                    </p>
                  </div>
                  {renderToggle(historyDisabled, handleHistoryToggle, 'blue')}
                </div>
              </motion.div>

              {/* Confirmation modal for disabling history */}
              <AnimatePresence>
                {showHistoryConfirm && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                    onClick={() => setShowHistoryConfirm(false)}
                  >
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9, y: 20 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.9, y: 20 }}
                      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                      className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-3 mb-4">
                        <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
                          <AlertTriangle className="w-5 h-5 text-red-400" />
                        </div>
                        <h3 className="text-lg font-semibold text-white">{t('settings.disableHistoryConfirmTitle')}</h3>
                      </div>
                      <p className="text-sm text-gray-400 mb-6 leading-relaxed">
                        {t('settings.disableHistoryConfirmDesc')}
                      </p>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setShowHistoryConfirm(false)}
                          className="flex-1 px-4 py-2.5 rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors text-sm font-medium"
                        >
                          {t('settings.disableHistoryCancel')}
                        </button>
                        <button
                          onClick={confirmDisableHistory}
                          className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white hover:bg-red-500 transition-colors text-sm font-medium"
                        >
                          {t('settings.disableHistoryConfirm')}
                        </button>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Confirmation modal for disabling data collection */}
              <AnimatePresence>
                {showDataCollectionConfirm && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm"
                    onClick={() => setShowDataCollectionConfirm(false)}
                  >
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9, y: 20 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.9, y: 20 }}
                      transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                      className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-3 mb-4">
                        <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
                          <AlertTriangle className="w-5 h-5 text-red-400" />
                        </div>
                        <h3 className="text-lg font-semibold text-white">{t('settings.disableDataConfirmTitle')}</h3>
                      </div>
                      <p className="text-sm text-gray-400 mb-6 leading-relaxed">
                        {t('settings.disableDataConfirmDesc')}
                      </p>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setShowDataCollectionConfirm(false)}
                          className="flex-1 px-4 py-2.5 rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors text-sm font-medium"
                        >
                          {t('settings.disableDataCancel')}
                        </button>
                        <button
                          onClick={confirmDisableDataCollection}
                          className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 text-white hover:bg-red-500 transition-colors text-sm font-medium"
                        >
                          {t('settings.disableDataConfirm')}
                        </button>
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
            )}

            {/* ════════════════════════════════════════════════════════ */}
            {/* SECTION: Données                                        */}
            {/* ════════════════════════════════════════════════════════ */}
            {isAuthenticated && (
            <section id="data" className="scroll-mt-24">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 rounded-xl bg-gradient-to-br from-orange-600/20 to-red-600/20 border border-orange-500/20">
                  <Database className="w-5 h-5 text-orange-400" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">{t('settings.data')}</h2>
                  <p className="text-sm text-gray-500">{t('settings.dataDesc')}</p>
                </div>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="space-y-3"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{t('settings.storageLocalTotal')}</p>
                    <p className="mt-2 text-2xl font-semibold text-white">{formatStorageBytes(storageMetrics.totalBytes)}</p>
                    <p className="mt-1 text-xs text-gray-500">{t('settings.storageKeys', { count: storageMetrics.totalKeys })}</p>
                  </div>

                  <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{t('settings.storageSyncable')}</p>
                    <p className="mt-2 text-2xl font-semibold text-white">{formatStorageBytes(storageMetrics.syncableBytes)}</p>
                    <p className="mt-1 text-xs text-gray-500">{t('settings.storageKeys', { count: storageMetrics.syncableKeys })}</p>
                  </div>

                  <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-4">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{t('settings.storageServerProfile')}</p>
                    <p className="mt-2 text-2xl font-semibold text-white">
                      {isLoadingServerSyncStats
                        ? t('common.loading')
                        : serverSyncStats
                          ? formatStorageBytes(serverSyncStats.profileBytes)
                          : t('common.notAvailable')}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {serverSyncStats
                        ? t('settings.storageKeys', { count: serverSyncStats.profileKeyCount })
                        : hasServerStorageContext
                          ? t('settings.storageServerHint')
                          : t('settings.storageServerUnavailable')}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-gray-700/40 bg-gray-900/35 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-gray-500">{t('settings.storageProfileQuota')}</p>
                        <p className="mt-2 text-2xl font-semibold text-white">
                          {serverSyncStats
                            ? `${serverQuotaUsagePercent}%`
                            : '--'}
                        </p>
                      </div>
                      {serverSyncStats && (
                        <p className="text-right text-xs text-gray-500">
                          {formatStorageBytes(serverSyncStats.profileBytes)} / {formatStorageBytes(serverSyncStats.profileQuotaBytes)}
                        </p>
                      )}
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-800/80">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-orange-500 via-amber-400 to-lime-400 transition-all duration-300"
                        style={{ width: `${serverQuotaUsagePercent}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-gray-500">
                      {selectedProfileId
                        ? t('settings.storageSelectedProfile', { profileId: selectedProfileId })
                        : t('settings.storageServerUnavailable')}
                    </p>
                  </div>
                </div>

                {serverSyncStats && serverSyncStats.legacySyncBytes > 0 && (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
                    <p className="font-medium text-amber-200">{t('settings.storageLegacyData')}</p>
                    <p className="mt-1 text-xs text-amber-100/80">
                      {formatStorageBytes(serverSyncStats.legacySyncBytes)} · {t('settings.storageKeys', { count: serverSyncStats.legacySyncKeyCount })}
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-amber-100/75">
                      {t('settings.storageLegacyDataDesc')}
                    </p>
                  </div>
                )}

                {/* Mon identifiant */}
                {isAuthenticated && canShowAccountId && (
                  <button
                    onClick={openIdPopup}
                    className="w-full flex items-center gap-4 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 hover:bg-gray-800/50 transition-all text-left group"
                  >
                    <div className="p-2.5 rounded-xl bg-gray-700/30 group-hover:bg-gray-700/50 transition-colors">
                      <Eye className="w-4 h-4 text-gray-400" />
                    </div>
                    <div className="flex-1">
                      <h4 className="font-medium text-white text-sm">{t('settings.myId')}</h4>
                      <p className="text-xs text-gray-500">{t('settings.myIdDesc')}</p>
                    </div>
                    <Copy className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors" />
                  </button>
                )}

                {/* Exporter données */}
                <button
                  onClick={copyLocalStorage}
                  className="w-full flex items-center gap-4 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 hover:bg-gray-800/50 transition-all text-left group"
                >
                  <div className="p-2.5 rounded-xl bg-gray-700/30 group-hover:bg-gray-700/50 transition-colors">
                    <Download className="w-4 h-4 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-medium text-white text-sm">{t('settings.exportData')}</h4>
                    <p className="text-xs text-gray-500">{t('settings.exportDataDesc')}</p>
                  </div>
                </button>

                {/* Importer données */}
                <button
                  onClick={openNonSyncablePopup}
                  className="w-full flex items-center gap-4 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 hover:bg-gray-800/50 transition-all text-left group"
                >
                  <div className="p-2.5 rounded-xl bg-gray-700/30 group-hover:bg-gray-700/50 transition-colors">
                    <Lock className="w-4 h-4 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-medium text-white text-sm">{t('settings.nonSyncableKeysTitle')}</h4>
                    <p className="text-xs text-gray-500">
                      {t('settings.nonSyncableKeysDesc', {
                        count: nonSyncableKeyCount,
                        size: formatStorageBytes(nonSyncableBytes),
                      })}
                    </p>
                  </div>
                </button>

                <button
                  onClick={() => setShowImportPopup(true)}
                  className="w-full flex items-center gap-4 p-4 bg-gray-800/30 rounded-xl border border-gray-700/40 hover:border-gray-600/50 hover:bg-gray-800/50 transition-all text-left group"
                >
                  <div className="p-2.5 rounded-xl bg-gray-700/30 group-hover:bg-gray-700/50 transition-colors">
                    <Upload className="w-4 h-4 text-gray-400" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-medium text-white text-sm">{t('settings.importData')}</h4>
                    <p className="text-xs text-gray-500">{t('settings.importDataDesc')}</p>
                  </div>
                </button>
              </motion.div>
            </section>
            )}
          </div>
        </div>
      </div>

      {/* ─── PORTALS: Popups ─────────────────────────────────────────── */}

      {linkModal && createPortal(
        <AnimatePresence mode="wait">
          {linkModal && !isClosingLinkModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) closeLinkModal(); }}
            >
              <motion.div
                initial={{ scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.96, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-lg w-full border border-gray-800 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-start gap-4 mb-4">
                  <div>
                    <h3 className="text-xl font-bold text-white">
                      {linkModal.action === 'link'
                        ? t('settings.linkedAccountsModalLinkTitle', {
                            provider: getProviderLabel(linkModal.provider),
                            defaultValue: `Lier ${getProviderLabel(linkModal.provider)} à ce compte ?`,
                          })
                        : t('settings.linkedAccountsModalUnlinkTitle', {
                            provider: getProviderLabel(linkModal.provider),
                            defaultValue: `Désactiver ${getProviderLabel(linkModal.provider)} pour ce compte ?`,
                          })}
                    </h3>
                    <p className="text-sm text-gray-400 mt-2 leading-relaxed">
                      {linkModal.action === 'link'
                        ? t('settings.linkedAccountsModalLinkDescription', {
                            provider: getProviderLabel(linkModal.provider),
                            defaultValue: `Quand vous vous connecterez avec ${getProviderLabel(linkModal.provider)}, Movix vous redirigera vers ce compte. Si vous désactivez plus tard cette liaison, ${getProviderLabel(linkModal.provider)} rouvrira son propre compte Movix.`,
                          })
                        : t('settings.linkedAccountsModalUnlinkDescription', {
                            provider: getProviderLabel(linkModal.provider),
                            defaultValue: `Si vous désactivez cette liaison, une future connexion avec ${getProviderLabel(linkModal.provider)} ne redirigera plus vers ce compte. Elle rouvrira le compte Movix propre à ${getProviderLabel(linkModal.provider)}.`,
                          })}
                    </p>
                  </div>
                  <button
                    onClick={closeLinkModal}
                    className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {linkActionError && (
                  <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-300">
                    {linkActionError}
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={closeLinkModal}
                    className="flex-1 px-4 py-2.5 rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors text-sm font-medium"
                    disabled={isSubmittingLinkAction}
                  >
                    {t('common.cancel', 'Annuler')}
                  </button>
                  <button
                    onClick={handleConfirmLinkAction}
                    className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                      linkModal.action === 'link'
                        ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                        : 'bg-red-600 text-white hover:bg-red-500'
                    } ${isSubmittingLinkAction ? 'opacity-60 cursor-not-allowed' : ''}`}
                    disabled={isSubmittingLinkAction}
                  >
                    {isSubmittingLinkAction
                      ? t('settings.linkedAccountsSubmitting', 'Traitement...')
                      : linkModal.action === 'link'
                        ? t('settings.linkedAccountsConfirmLink', 'Confirmer la liaison')
                        : t('settings.linkedAccountsConfirmUnlink', 'Désactiver la liaison')}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* ID Popup */}
      {showIdPopup && createPortal(
        <AnimatePresence mode="wait">
          {showIdPopup && !isClosingIdPopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseIdPopup(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-hidden border border-gray-800"
                data-lenis-prevent
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xl font-bold text-white">{t('settings.accountId')}</h3>
                  <button onClick={handleCloseIdPopup} className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div
                  className="overflow-y-auto max-h-[70vh]"
                  data-lenis-prevent
                  style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <p className="text-sm text-gray-400 mb-4">{t('settings.accountIdNote')}</p>
                  <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 mb-4">
                    {accountIdInfo?.provider && accountIdInfo.provider !== 'unknown' && (
                      <div className="text-xs text-gray-400 mb-1 capitalize">{t('settings.provider')}: {accountIdInfo.provider}</div>
                    )}
                    <div className="text-xs text-gray-400 mb-1">{t('admin.idLabel')}</div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-sm text-white break-all">{accountIdInfo?.id || ''}</span>
                      <button
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-white transition-colors"
                        onClick={() => { if (accountIdInfo?.id) navigator.clipboard.writeText(accountIdInfo.id); }}
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {t('common.copy')}
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors" onClick={handleCloseIdPopup}>
                      {t('common.understood')}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* localStorage Popup */}
      {showLocalStoragePopup && createPortal(
        <AnimatePresence mode="wait">
          {showLocalStoragePopup && !isClosingLocalStoragePopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseLocalStoragePopup(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden border border-gray-800"
                data-lenis-prevent
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xl font-bold text-white">{t('settings.localStorageData')}</h3>
                  <button onClick={handleCloseLocalStoragePopup} className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div
                  className="overflow-y-auto max-h-[70vh]"
                  data-lenis-prevent
                  style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <div className="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-4">
                    <p className="text-sm text-red-300 font-medium mb-2">{t('settings.sensitiveDataWarning')}</p>
                    <p className="text-sm text-red-200">{t('settings.sensitiveDataNote')}</p>
                  </div>
                  <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 mb-4">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div className="text-xs text-gray-400">{t('settings.localStorageJson')}</div>
                      <button
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-white transition-colors"
                        onClick={() => { if (localStorageData) navigator.clipboard.writeText(localStorageData); }}
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {t('settings.copyAll')}
                      </button>
                    </div>
                    <div
                      className="bg-gray-900/50 rounded-lg p-3 max-h-96 overflow-y-auto"
                      data-lenis-prevent
                      style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                    >
                      <pre className="font-mono text-xs text-gray-300 whitespace-pre-wrap break-all">{localStorageData}</pre>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors" onClick={handleCloseLocalStoragePopup}>
                      {t('common.close')}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {showNonSyncablePopup && createPortal(
        <AnimatePresence mode="wait">
          {showNonSyncablePopup && !isClosingNonSyncablePopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseNonSyncablePopup(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden border border-gray-800"
                data-lenis-prevent
              >
                <div className="flex justify-between items-center gap-4 mb-6">
                  <div>
                    <h3 className="text-xl font-bold text-white">{t('settings.nonSyncableKeysTitle')}</h3>
                    <p className="mt-1 text-sm text-gray-400">
                      {t('settings.nonSyncableKeysPopupDesc', {
                        count: nonSyncableEntries.length,
                        size: formatStorageBytes(nonSyncableBytes),
                      })}
                    </p>
                  </div>
                  <button onClick={handleCloseNonSyncablePopup} className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div
                  className="overflow-y-auto max-h-[70vh]"
                  data-lenis-prevent
                  style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-4 mb-4">
                    <p className="text-sm text-amber-200 font-medium mb-2">{t('settings.nonSyncableKeysWhyTitle')}</p>
                    <p className="text-sm leading-relaxed text-amber-100/85">{t('settings.nonSyncableKeysWhyDesc')}</p>
                  </div>

                  {nonSyncableEntries.length === 0 ? (
                    <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4 text-sm text-gray-300">
                      {t('settings.nonSyncableKeysEmpty')}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex justify-end">
                        <button
                          className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-gray-700 hover:bg-gray-600 text-white transition-colors"
                          onClick={copyNonSyncableKeys}
                        >
                          <Copy className="w-3.5 h-3.5" />
                          {t('settings.copyNonSyncableKeys')}
                        </button>
                      </div>

                      {nonSyncableEntries.map((entry) => (
                        <div
                          key={entry.key}
                          className="rounded-xl border border-gray-700 bg-gray-800/60 p-4"
                        >
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="font-mono text-sm text-white break-all">{entry.key}</p>
                              <p className="mt-1 text-xs text-gray-400">
                                {t(getNonSyncReasonTranslationKey(entry.reason))}
                              </p>
                            </div>
                            <p className="text-xs text-gray-500 sm:text-right">
                              {formatStorageBytes(entry.bytes)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex justify-end">
                    <button className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors" onClick={handleCloseNonSyncablePopup}>
                      {t('common.close')}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* Import Popup */}
      {showImportPopup && createPortal(
        <AnimatePresence mode="wait">
          {showImportPopup && !isClosingImportPopup && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
              onClick={(e) => { if (e.target === e.currentTarget) handleCloseImportPopup(); }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-gray-900 rounded-2xl p-6 max-w-4xl w-full max-h-[90vh] overflow-hidden border border-gray-800"
                data-lenis-prevent
              >
                <div className="flex justify-between items-center mb-6">
                  <h3 className="text-xl font-bold text-white">{t('settings.importDataTitle')}</h3>
                  <button onClick={handleCloseImportPopup} className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-800 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div
                  className="overflow-y-auto max-h-[70vh]"
                  data-lenis-prevent
                  style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' }}
                >
                  <div className="bg-blue-900/30 border border-blue-500/50 rounded-lg p-4 mb-4">
                    <p className="text-sm text-blue-300 font-medium mb-2">{t('settings.importDataNote')}</p>
                    <p className="text-sm text-blue-200">{t('settings.importDataHint')}</p>
                  </div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-300 mb-2">{t('settings.jsonToImport')}</label>
                    <textarea
                      value={importData}
                      onChange={(e) => setImportData(e.target.value)}
                      className="w-full h-64 bg-gray-800 border border-gray-700 rounded-lg p-4 text-white font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none outline-none"
                      placeholder='{"watched_tv_episodes": "...", "progress_14438": "..."}'
                    />
                  </div>
                  {importError && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-4">
                      <p className="text-sm text-red-300">❌ {importError}</p>
                    </motion.div>
                  )}
                  {importSuccess && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-green-900/30 border border-green-500/50 rounded-lg p-4 mb-4">
                      <p className="text-sm text-green-300">✅ {importSuccess}</p>
                    </motion.div>
                  )}
                  <div className="flex justify-end gap-3">
                    <button className="px-4 py-2 rounded-lg bg-gray-600 hover:bg-gray-700 text-white transition-colors" onClick={handleCloseImportPopup}>
                      {t('common.cancel')}
                    </button>
                    <button
                      className={`px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors ${!importData.trim() ? 'opacity-30 pointer-events-none' : ''}`}
                      onClick={handleImportData}
                      disabled={!importData.trim()}
                    >
                      {t('settings.import')}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </SquareBackground>
  );
};

export default SettingsPage;
