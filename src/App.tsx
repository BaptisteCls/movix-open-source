import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigationType, useNavigate } from 'react-router-dom';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import Header from './components/Header';
import Home from './pages/Home';
import Search from './pages/Search';
import MovieDetails from './pages/MovieDetails';
import TVDetails from './pages/TVDetails';
import Movies from './pages/Movies';
import TVShows from './pages/TVShows';
import Collections from './pages/Collections';
import CollectionDetails from './pages/CollectionDetails';
import GenrePage from './pages/GenrePage';
import WatchMovie from './pages/Watch/WatchMovie';
import WatchTv from './pages/Watch/WatchTv';
import { Analytics } from "@vercel/analytics/react"
import ProviderContent from './pages/ProviderContent';
import ProviderCatalogPage from './pages/ProviderCatalogPage';
import RoulettePage from './pages/RoulettePage';
import DiscordAuth from './components/DiscordAuth';
import GoogleAuth from './components/GoogleAuth';
import Profile from './pages/Profile';
import { AdFreePopupProvider } from './context/AdFreePopupContext';
import { SearchProvider } from './context/SearchContext';
import { AuthProvider } from './context/AuthContext';
import { AdWarningProvider } from './context/AdWarningContext';
import { VipModalProvider } from './context/VipModalContext';
import { ProfileProvider, useProfile } from './context/ProfileContext';
import { TurnstileProvider } from './context/TurnstileContext';

import LiveTV from './pages/LiveTV';
import PersonDetails from './pages/PersonDetails';
import SuggestionPage from './pages/SuggestionPage';
import ExtensionPage from './pages/ExtensionPage';
import SharedListPage from './pages/SharedListPage';
import SharedListsCatalogPage from './pages/SharedListsCatalogPage';
import NotFound from './pages/NotFound';
import 'video.js/dist/video-js.css';
import './styles/videojs-custom.css';
import WatchAnime from './pages/Watch/WatchAnime';
import WatchPartyCreate from './pages/WatchPartyCreate';
import WatchPartyRoom from './pages/WatchPartyRoom';
import WatchPartyJoin from './pages/WatchPartyJoin';
import WatchPartyList from './pages/WatchPartyList';
import axios from 'axios';
import Footer from './components/Footer';
import CreateAccount from './pages/CreateAccount';
import LoginBip39 from './pages/LoginBip39';
import AlertsPage from './pages/AlertsPage';
import { AlertService } from './services/alertService';
import NotificationToast from './components/NotificationToast';
import { NotificationData } from './types/alerts';
import DMCA from './pages/DMCA';
import AdminPage from './pages/AdminPage';
import DownloadPage from './pages/DownloadPage';
import DebridPage from './pages/DebridPage';
import ProfileSelection from './pages/ProfileSelection';
import ProfileManagement from './pages/ProfileManagement';
import RedirectPopup from './components/RedirectPopup';
import WishboardPage from './pages/Greenlight/WishboardPage';
import WishboardNewRequest from './pages/Greenlight/WishboardNewRequest';
import WishboardUserRequests from './pages/Greenlight/WishboardUserRequests';
import SubmitLinkPage from './pages/Greenlight/SubmitLinkPage';
import VipPage from './pages/VipPage';
import VipDonatePage from './pages/VipDonatePage';
import VipInvoicePage from './pages/VipInvoicePage';
import VipGiftPage from './pages/VipGiftPage';
import WhatIsMovixPage from './pages/WhatIsMovixPage';
import Privacy from './pages/Privacy';
import TermsOfService from './pages/TermsOfService';
import SmoothScroll from './components/SmoothScroll';
import WrappedPage from './pages/WrappedPage';
import CineGraphPage from './pages/CineGraph';
import SettingsPage from './pages/SettingsPage';
import Top10Page from './pages/Top10Page';
import FranceTVBrowse from './pages/FranceTV/FranceTVBrowse';
import FranceTVInfo from './pages/FranceTV/FranceTVInfo';
import FranceTVPlayer from './pages/FranceTV/FranceTVPlayer';
import AprilFoolsAdminPage from './pages/AprilFoolsAdminPage';
import ScreenSaver from './components/ScreenSaver';
import { useIdleTimer } from './hooks/useIdleTimer';
import { startVipVerification } from './utils/vipUtils';
import { getResolvedAccountContext } from './utils/accountAuth';
import { isSyncableStorageKey } from './utils/syncStorage';
import i18n, { detectInitialLanguage } from './i18n';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import IntroAnimation from './components/IntroAnimation';
import { IntroProvider, useIntro } from './context/IntroContext';
import { APRIL_FOOLS_ADMIN_PATH, isAprilFoolsAdminEnabled } from './utils/aprilFools';

// Démarrer la vérification périodique du VIP au lancement de l'app
startVipVerification();

// Detect and set language on first visit (browser language + IP geolocation)
detectInitialLanguage();

// Global 401 handler: on any 401 from axios, clear storage and redirect to /
// 403 is NOT intercepted here — it can come from Turnstile, admin checks, etc.
// Uses __forceClearInProgress flag to prevent sync operations during forced clear
(function setupAxios401Handler() {
  if ((window as any).__axios401Set) return;
  (window as any).__axios401Set = true;
  axios.interceptors.response.use(
    (resp) => resp,
    (error) => {
      const status = error?.response?.status;
      if (status === 401) {
        // Déterminer le domaine de la requête ayant échoué
        const cfg = error?.config || error?.response?.config || {};
        const baseURL = cfg.baseURL || '';
        const urlPart = cfg.url || '';
        let fullUrl = '';
        try {
          fullUrl = urlPart && /^https?:\/\//i.test(urlPart)
            ? urlPart
            : (baseURL ? new URL(urlPart || '', baseURL).toString() : (urlPart || ''));
        } catch {
          fullUrl = urlPart || '';
        }
        let hostname = '';
        try { hostname = fullUrl ? new URL(fullUrl).hostname : ''; } catch { hostname = ''; }

        // Vérifier si c'est la route /api/admin/check - ne pas déconnecter pour cette route
        const isAdminCheckRoute = fullUrl.includes('/api/admin/check') || urlPart.includes('/api/admin/check');

        // N'appliquer le clear/redirect que pour le domaine API configuré et pas pour /api/admin/check
        if (API_HOSTNAME && hostname === API_HOSTNAME && !isAdminCheckRoute) {
          // Marquer qu'on est en train de faire un clear forcé pour éviter le sync
          (window as any).__forceClearInProgress = true;

          try { localStorage.clear(); } catch { }
          try { sessionStorage.clear(); } catch { }

          // Réinitialiser le flag après un court délai
          setTimeout(() => {
            (window as any).__forceClearInProgress = false;
          }, 1000);

          window.location.href = '/';
        }
      }
      return Promise.reject(error);
    }
  );
})();

// Get API URL from environment variable
const API_URL = import.meta.env.VITE_MAIN_API
const API_HOSTNAME = (() => {
  try {
    return API_URL ? new URL(API_URL).hostname : '';
  } catch {
    return '';
  }
})();

// Component to manage episode alerts notifications
const AlertNotificationManager: React.FC = () => {
  const [notifications, setNotifications] = useState<NotificationData[]>([]);

  // Function to check and display alerts
  const checkAlerts = (forceCheck = false) => {
    console.log('Checking alerts...', forceCheck ? '(forced)' : '');

    // Only proceed if it's time to check (unless forced)
    if (!forceCheck && !AlertService.shouldRunCheck()) {
      console.log('Not time to check yet, skipping...');
      return;
    }

    const { alertsToShow, alertsToRemove } = AlertService.checkAlertsToTrigger();

    console.log('Alerts to show:', alertsToShow);
    console.log('Alerts to remove:', alertsToRemove);

    // Remove expired alerts
    alertsToRemove.forEach(alertId => {
      AlertService.removeAlert(alertId);
    });

    // Show new notifications and mark them as notified
    if (alertsToShow.length > 0) {
      // Double-check that none of the alerts are dismissed before showing
      const validAlerts = alertsToShow.filter(alert => {
        const alertData = AlertService.getAlert(alert.showId, alert.season, alert.episode);
        return alertData && !alertData.dismissed;
      });

      if (validAlerts.length > 0) {
        setNotifications(prev => [...prev, ...validAlerts]);
        // Mark alerts as notified
        validAlerts.forEach(alert => {
          AlertService.markAsNotified(alert.id);
        });
      }
    }

    // Update last check time
    AlertService.updateLastCheckTime();
  };

  useEffect(() => {
    // Force check immediately on mount/refresh (regardless of last check time)
    checkAlerts(true);

    // Set up interval to check every 5 minutes after the initial check
    const interval = setInterval(() => checkAlerts(false), 5 * 60 * 1000); // 5 minutes

    return () => clearInterval(interval);
  }, []);

  const handleDismissNotification = (notificationId: string) => {
    setNotifications(prev => prev.filter(n => n.id !== notificationId));
    // Dismiss the alert permanently (only when user explicitly clicks "Ignorer")
    AlertService.dismissAlert(notificationId);
  };

  const handleRemindLater = (notificationId: string) => {
    setNotifications(prev => prev.filter(n => n.id !== notificationId));
    // Reset notification status so it can be shown again later
    AlertService.resetNotificationStatus(notificationId);
  };

  const handleGoToShow = (showId: string, notificationId: string) => {
    setNotifications(prev => prev.filter(n => n.id !== notificationId));
    // Mark as dismissed since user took action
    AlertService.dismissAlert(notificationId);
    window.location.href = `/tv/${showId}`;
  };

  return (
    <>
      {notifications.map(notification => (
        <NotificationToast
          key={notification.id}
          notification={notification}
          onDismiss={() => handleDismissNotification(notification.id)}
          onGoToShow={() => handleGoToShow(notification.showId, notification.id)}
          onRemindLater={() => handleRemindLater(notification.id)}
        />
      ))}
    </>
  );
};

// Helper function to detect iOS standalone mode (added to home screen)
const isInStandaloneMode = () => {
  return (
    ('standalone' in window.navigator) &&
    ((window.navigator as any).standalone === true) ||
    window.matchMedia('(display-mode: standalone)').matches
  );
};

const shouldPreserveScrollOnBack = () => localStorage.getItem('settings_disable_auto_scroll') === 'true';

const shouldDisableRouteScrollToTop = () => localStorage.getItem('settings_disable_route_scroll_to_top') === 'true';

const isSmoothScrollEnabled = () => localStorage.getItem('settings_smooth_scroll') !== 'false';

const shouldAnimateScrollToTop = () => {
  if (!isSmoothScrollEnabled()) {
    return false;
  }

  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

const syncHistoryScrollRestoration = () => {
  const preserveScrollOnBack = shouldPreserveScrollOnBack();
  const disableRouteScrollToTop = shouldDisableRouteScrollToTop();

  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = preserveScrollOnBack || disableRouteScrollToTop ? 'auto' : 'manual';
  }

  return {
    preserveScrollOnBack,
    disableRouteScrollToTop
  };
};

const resetNestedScrollableContainers = () => {
  const scrollableElements = document.querySelectorAll<HTMLElement>(
    '[data-scroll="true"], [data-radix-scroll-area-viewport], .overflow-y-auto, .overflow-y-scroll, .overflow-auto, .overflow-scroll'
  );

  scrollableElements.forEach((element) => {
    if (element.scrollTop !== 0) {
      element.scrollTop = 0;
    }
  });
};

const forceViewportTop = () => {
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
};

const scrollViewportToTop = (mode: 'smooth' | 'instant') => {
  const lenis = (window as any).lenis;

  if (lenis?.scrollTo) {
    lenis.scrollTo(0, {
      immediate: mode === 'instant',
      duration: mode === 'smooth' ? 0.55 : undefined,
      force: true
    });
  } else {
    window.scrollTo({ top: 0, left: 0, behavior: mode === 'smooth' ? 'smooth' : 'auto' });
  }

  if (mode === 'instant') {
    forceViewportTop();
  }
};

// Composant pour faire défiler automatiquement vers le haut lors des changements de route
const ScrollToTop = () => {
  const location = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    const handleRestorationSync = (event?: StorageEvent) => {
      if (
        event instanceof StorageEvent &&
        event.key &&
        event.key !== 'settings_disable_auto_scroll' &&
        event.key !== 'settings_disable_route_scroll_to_top'
      ) {
        return;
      }

      syncHistoryScrollRestoration();
    };

    handleRestorationSync();

    window.addEventListener('storage', handleRestorationSync);
    window.addEventListener('settings_auto_scroll_changed', handleRestorationSync as EventListener);
    window.addEventListener('settings_route_scroll_changed', handleRestorationSync as EventListener);

    return () => {
      window.removeEventListener('storage', handleRestorationSync);
      window.removeEventListener('settings_auto_scroll_changed', handleRestorationSync as EventListener);
      window.removeEventListener('settings_route_scroll_changed', handleRestorationSync as EventListener);
      if ('scrollRestoration' in window.history) {
        window.history.scrollRestoration = 'auto';
      }
    };
  }, []);

  useLayoutEffect(() => {
    const { preserveScrollOnBack, disableRouteScrollToTop } = syncHistoryScrollRestoration();
    const isBackOrForward = navigationType === 'POP';

    if (disableRouteScrollToTop) {
      return undefined;
    }

    if (preserveScrollOnBack && isBackOrForward) {
      return undefined;
    }

    let cancelled = false;
    let frameId = 0;
    let nestedFrameId = 0;
    let settleTimeout = 0;
    let userInteracted = false;

    const cancelPendingAdjustments = () => {
      userInteracted = true;
      window.clearTimeout(settleTimeout);
    };

    const handleUserInteraction = () => {
      if (!cancelled) {
        cancelPendingAdjustments();
      }
    };

    const scrollToTop = (mode: 'smooth' | 'instant') => {
      try {
        scrollViewportToTop(mode);
        resetNestedScrollableContainers();
      } catch (error) {
        console.warn('ScrollToTop: Error during scroll operation', error);
      }
    };

    const shouldAnimate = shouldAnimateScrollToTop();

    window.addEventListener('wheel', handleUserInteraction, { passive: true });
    window.addEventListener('touchstart', handleUserInteraction, { passive: true });
    window.addEventListener('touchmove', handleUserInteraction, { passive: true });
    window.addEventListener('pointerdown', handleUserInteraction, { passive: true });
    window.addEventListener('keydown', handleUserInteraction);

    frameId = requestAnimationFrame(() => {
      if (cancelled) return;

      scrollToTop(shouldAnimate ? 'smooth' : 'instant');

      nestedFrameId = requestAnimationFrame(() => {
        if (cancelled || userInteracted) return;
        resetNestedScrollableContainers();
      });

      if (!shouldAnimate) {
        settleTimeout = window.setTimeout(() => {
          if (cancelled || userInteracted) return;
          scrollToTop('instant');
          resetNestedScrollableContainers();
        }, 120);
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      cancelAnimationFrame(nestedFrameId);
      window.clearTimeout(settleTimeout);
      window.removeEventListener('wheel', handleUserInteraction);
      window.removeEventListener('touchstart', handleUserInteraction);
      window.removeEventListener('touchmove', handleUserInteraction);
      window.removeEventListener('pointerdown', handleUserInteraction);
      window.removeEventListener('keydown', handleUserInteraction);
    };
  }, [location.pathname, location.search, navigationType]);

  return null;
};

// iOS standalone mode handler component
const IOSHomeScreenHandler = () => {
  useEffect(() => {
    // Handle iOS standalone mode
    if (isInStandaloneMode()) {
      // Prevent standard link behavior in standalone mode
      document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const closestLink = target.closest('a');

        if (closestLink &&
          !closestLink.getAttribute('target') &&
          closestLink.getAttribute('href')?.indexOf('http') === 0) {
          e.preventDefault();
          window.location.href = closestLink.href;
        }
      });

      // Add class to body when in standalone mode for specific styling if needed
      document.body.classList.add('ios-standalone');
    }
  }, []);

  return null;
};

const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
  const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
  const isGoogleAuth = localStorage.getItem('google_auth') === 'true';
  const isBip39Auth = localStorage.getItem('bip39_auth') === 'true';
  const isVipUser = localStorage.getItem('is_vip') === 'true';

  // Vérifier l'ancienne méthode d'authentification VIP (pour compatibilité)
  let isVipAuth = false;
  const authStr = localStorage.getItem('auth');
  if (authStr) {
    try {
      const authObj = JSON.parse(authStr);
      if (authObj.userProfile && authObj.userProfile.provider === 'access_code') {
        isVipAuth = true;
      }
    } catch { }
  }

  const isAuthenticated = isDiscordAuth || isGoogleAuth || isBip39Auth || isVipAuth || isVipUser;
  return isAuthenticated ? children : <Navigate to="/login" />;
};

// PersistenceManager component to sync localStorage with backend (disabled for guests and VIP)
const PersistenceManager = () => {
  const [isInitialSyncDone, setIsInitialSyncDone] = useState<boolean>(false);
  const location = useLocation();

  // Delta-sync queues
  const generalOpsRef = useRef<any[]>([]);
  const progressOpsMapRef = useRef<Map<string, any>>(new Map());
  const suppressSyncRef = useRef<boolean>(false);

  const MAX_SYNC_OPS_PER_REQUEST = 100;
  const isProgressKey = (k: string) => k.startsWith('progress_');

  // Track if we're in the middle of loading profile data to avoid sync
  const isProfileDataLoadingRef = useRef<boolean>(false);

  // Expose function to control profile data loading state
  React.useEffect(() => {
    (window as any).setProfileDataLoading = (loading: boolean) => {
      isProfileDataLoadingRef.current = loading;
      console.log('Profile data loading state changed:', loading);
    };

    return () => {
      delete (window as any).setProfileDataLoading;
    };
  }, []);

  // Check if we're on a watch route - if so, disable initial data loading but allow sync
  const isWatchRoute = location.pathname.startsWith('/watch/') || location.pathname.startsWith('/watchparty/room/');

  // Store current user info in a ref to track changes
  const currentUserInfo = React.useRef<{ type: string | null, id: string | null }>(
    { type: null, id: null }
  );

  // Store auth states in refs to avoid dependency issues
  const discordAuth = React.useRef(localStorage.getItem('discord_auth') === 'true');
  const googleAuth = React.useRef(localStorage.getItem('google_auth') === 'true');

  // Track user authentication changes
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent | null) => {
      // Process auth changes (now allowed on watch routes)

      // Check if this is a relevant auth change
      const isAuthChange = e === null || // null means manual trigger
        e.key === 'auth' ||
        e.key === 'discord_auth' ||
        e.key === 'google_auth' ||
        e.key === 'discord_user' ||
        e.key === 'google_user' ||
        e.key === 'is_vip' ||
        e.key === 'access_code' ||
        e.key === 'access_code_expires' ||
        e.key === 'auth_token'; // Also watch for auth_token changes

      // Update auth refs
      discordAuth.current = localStorage.getItem('discord_auth') === 'true';
      googleAuth.current = localStorage.getItem('google_auth') === 'true';

      // Check if user type has changed
      if (isAuthChange) {
        const newUserInfo = getUserInfo();
        const oldUserInfo = currentUserInfo.current;

        // Update the current user info
        currentUserInfo.current = newUserInfo;

        // If user type or ID changed, reset sync state for new load
        if (newUserInfo.type !== oldUserInfo.type || newUserInfo.id !== oldUserInfo.id) {
          console.log('Auth changed. Resetting sync state and refreshing user info.');
          // Add a small delay to ensure auth process is complete
          setTimeout(() => {
            setIsInitialSyncDone(false);
          }, 1000); // Wait 1 second before triggering sync
        }
      }
    };

    // Initialize current user info
    currentUserInfo.current = getUserInfo();

    // Listen for storage events from other tabs/windows
    window.addEventListener('storage', handleStorageChange);

    // Listen for our custom event for changes within this tab
    window.addEventListener('auth_changed', () => handleStorageChange(null));

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('auth_changed', () => handleStorageChange(null));
    };
  }, [isWatchRoute]); // Add isWatchRoute as dependency

  // Delta-sync: capture and buffer granular localStorage changes
  useEffect(() => {
    // Setup localStorage sync (now allowed on watch routes)

    // Initialize snapshot of current localStorage
    const prevValues = new Map<string, string | null>();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) prevValues.set(k, localStorage.getItem(k));
    }

    const prevValuesRefLocal = { current: prevValues } as { current: Map<string, string | null> };

    const generalFlushTimeoutRef = { current: null as any };

    // Detect Safari and Firefox/Librewolf browsers and check localStorage availability
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isFirefox = /firefox/i.test(navigator.userAgent) || /librewolf/i.test(navigator.userAgent);
    console.log('Browser detection - Safari:', isSafari, 'Firefox/Librewolf:', isFirefox);

    // Check if localStorage is available and working (important for Safari private mode)
    const isLocalStorageAvailable = (() => {
      try {
        const testKey = '__localStorage_test__';
        localStorage.setItem(testKey, 'test');
        localStorage.removeItem(testKey);
        return true;
      } catch (e) {
        console.warn('localStorage not available:', e);
        return false;
      }
    })();

    console.log('localStorage available:', isLocalStorageAvailable);

    const enqueueGeneralOp = (op: any) => {
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) return;

      generalOpsRef.current.push(op);
      if (generalFlushTimeoutRef.current) return;
      generalFlushTimeoutRef.current = setTimeout(() => {
        flushGeneralOps();
        generalFlushTimeoutRef.current = null;
      }, 1000); // coalesce <1s into one POST
    };

    const sendOps = async (ops: any[]) => {
      if (!ops.length) return;

      // Vérifier si un clear forcé est en cours (erreur 401)
      if ((window as any).__forceClearInProgress) {
        console.log('Skipping sync - force clear in progress');
        return;
      }

      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) {
        console.log('Skipping sync - profile data loading in progress');
        return;
      }

      const userInfo = getUserInfo();
      // Only sync for oauth and bip39 users with a selected profile
      if (!userInfo.type || !userInfo.profileId || !['oauth', 'bip39'].includes(userInfo.type)) return;

      const authToken = localStorage.getItem('auth_token');
      if (!authToken) {
        console.log('Skipping sync - no auth token available');
        return;
      }

      try {
        for (let index = 0; index < ops.length; index += MAX_SYNC_OPS_PER_REQUEST) {
          const batch = ops.slice(index, index + MAX_SYNC_OPS_PER_REQUEST);
          const syncPayload: any = {
            userType: userInfo.type,
            profileId: userInfo.profileId,
            ops: batch
          };

          if (userInfo.id) {
            syncPayload.userId = userInfo.id;
          }

          console.log(`Sending sync request (${batch.length} operations) - route: ${location.pathname}`);
          await axios.post(`${API_URL}/api/sync`, syncPayload, {
            headers: { Authorization: `Bearer ${authToken}` }
          });
        }

        console.log('Sync request successful');
        window.dispatchEvent(new CustomEvent('sync_storage_updated'));
      } catch (e) {
        console.error('Delta sync failed', e);
      }
    };

    const flushGeneralOps = () => {
      const ops = generalOpsRef.current;
      generalOpsRef.current = [];
      // Skip sync during profile data loading (but allow on watch routes)
      if (!isProfileDataLoadingRef.current && ops.length) sendOps(ops);
    };

    const flushProgressOps = () => {
      if (progressOpsMapRef.current.size === 0) return;
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) return;

      const ops: any[] = [];
      for (const [key, deltaOrValue] of progressOpsMapRef.current.entries()) {
        // deltaOrValue is { set: {...}, remove: [...] }
        const delta = deltaOrValue?.delta;
        if (delta && (Object.keys(delta.set || {}).length || (delta.remove || []).length)) {
          ops.push({ op: 'objPatch', key, delta });
        } else if (deltaOrValue && typeof deltaOrValue.value === 'string') {
          ops.push({ op: 'set', key, value: deltaOrValue.value });
        }
      }
      progressOpsMapRef.current.clear();
      if (ops.length) sendOps(ops);
    };

    const computeArrayDiffOps = (key: string, oldStr: string | null, newStr: string) => {
      let oldArr: any[] = [];
      let newArr: any[] = [];
      try { oldArr = oldStr ? JSON.parse(oldStr) : []; } catch { }
      try { newArr = newStr ? JSON.parse(newStr) : []; } catch { }
      // Only handle true top-level arrays; for objects or non-arrays, let object patch handle
      if (!Array.isArray(oldArr) || !Array.isArray(newArr)) return null as any;

      const oldMapById = new Map<number | string, any>();
      oldArr.forEach((it: any) => {
        if (it && typeof it === 'object' && 'id' in it) oldMapById.set((it as any).id, it);
      });

      const ops: any[] = [];

      // Additions and updates
      newArr.forEach((it: any) => {
        const id = it && typeof it === 'object' && 'id' in it ? (it as any).id : undefined;
        if (id !== undefined && oldMapById.has(id)) {
          const prev = oldMapById.get(id);
          if (JSON.stringify(prev) !== JSON.stringify(it)) {
            // Model as remove then add for updated item
            ops.push({ op: 'arrayRemove', key, value: { id } });
            ops.push({ op: 'arrayAdd', key, value: it });
          }
        } else if (id !== undefined) {
          ops.push({ op: 'arrayAdd', key, value: it });
        } else {
          // Primitive arrays or objects without id - fallback to full set
          ops.length = 0;
          ops.push({ op: 'set', key, value: newStr });
        }
      });

      // Removals
      const newIds = new Set(newArr.filter((x: any) => x && typeof x === 'object' && 'id' in x).map((x: any) => x.id));
      oldArr.forEach((it: any) => {
        const id = it && typeof it === 'object' && 'id' in it ? it.id : undefined;
        if (id !== undefined && !newIds.has(id)) {
          ops.push({ op: 'arrayRemove', key, value: { id } });
        }
      });

      return ops.length ? ops : [{ op: 'set', key, value: newStr }];
    };

    const computeObjectPatch = (oldStr: string | null, newStr: string) => {
      let oldObj: any = {};
      let newObj: any = {};
      try { oldObj = oldStr ? JSON.parse(oldStr) : {}; } catch { }
      try { newObj = newStr ? JSON.parse(newStr) : {}; } catch { }
      if (typeof oldObj !== 'object' || typeof newObj !== 'object') return null;
      const set: any = {};
      const remove: string[] = [];
      const oldKeys = new Set(Object.keys(oldObj));
      const newKeys = new Set(Object.keys(newObj));

      // Generic nested array diff for any array valued field with identifiable ids
      for (const k of newKeys) {
        const oldVal = oldObj[k];
        const newVal = newObj[k];
        if (Array.isArray(newVal)) {
          const oldArr = Array.isArray(oldVal) ? oldVal : [];
          const newArr = newVal;

          // Build id maps
          const oldById = new Map<any, any>();
          oldArr.forEach((it: any) => {
            if (it && typeof it === 'object' && 'id' in it) oldById.set(it.id, it);
          });
          const newById = new Map<any, any>();
          newArr.forEach((it: any) => {
            if (it && typeof it === 'object' && 'id' in it) newById.set(it.id, it);
          });

          // If items don't have ids, fallback to full set
          const canId = newArr.every((it: any) => !it || (typeof it === 'object' && 'id' in it));
          if (!canId) {
            if (JSON.stringify(oldArr) !== JSON.stringify(newArr)) set[k] = newArr;
            continue;
          }

          const add: any[] = [];
          const update: any[] = [];
          const removeIds: Array<string | number> = [];

          newArr.forEach((it: any) => {
            const id = it && typeof it === 'object' ? it.id : undefined;
            if (id === undefined) return;
            const prev = oldById.get(id);
            if (!prev) add.push(it);
            else if (JSON.stringify(prev) !== JSON.stringify(it)) update.push(it);
          });
          oldArr.forEach((it: any) => {
            const id = it && typeof it === 'object' ? it.id : undefined;
            if (id === undefined) return;
            if (!newById.has(id)) removeIds.push(id);
          });

          if (add.length || update.length || removeIds.length) {
            set[k] = { __arrayPatch: { add, update, removeIds } };
          }
        }
      }
      // Changed or added (fallback generic for non-array fields)
      for (const k of newKeys) {
        if (Array.isArray(newObj[k])) continue; // handled above
        if (!oldKeys.has(k) || JSON.stringify(oldObj[k]) !== JSON.stringify(newObj[k])) {
          set[k] = newObj[k];
        }
      }
      // Removed
      for (const k of oldKeys) {
        if (!newKeys.has(k)) remove.push(k);
      }
      if (Object.keys(set).length || remove.length) return { set, remove };
      return null;
    };

    const processSet = (key: string, oldVal: string | null, newVal: string) => {
      if (suppressSyncRef.current) return;
      if (!isSyncableStorageKey(key)) return;
      // Vérifier si un clear forcé est en cours (erreur 401)
      if ((window as any).__forceClearInProgress) return;
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) return;
      if (isProgressKey(key)) {
        // Accumulate latest patch for progress keys
        const delta = computeObjectPatch(oldVal, newVal);
        if (delta) {
          const existing = progressOpsMapRef.current.get(key) || { delta: { set: {}, remove: [] as string[] } };
          existing.delta.set = { ...existing.delta.set, ...delta.set };
          existing.delta.remove = Array.from(new Set([...(existing.delta.remove || []), ...delta.remove]));
          progressOpsMapRef.current.set(key, existing);
        } else {
          // If cannot diff, fallback to set
          progressOpsMapRef.current.set(key, { value: newVal });
        }
        return;
      }

      // Try array diff first
      const arrayOps = computeArrayDiffOps(key, oldVal, newVal);
      if (arrayOps && arrayOps.length) {
        arrayOps.forEach(enqueueGeneralOp);
        return;
      }

      // Try object patch with generic nested array support
      const delta = computeObjectPatch(oldVal, newVal);
      if (delta) {
        enqueueGeneralOp({ op: 'objPatch', key, delta });
      } else {
        enqueueGeneralOp({ op: 'set', key, value: newVal });
      }
    };

    const processRemove = (key: string) => {
      if (suppressSyncRef.current) return;
      if (!isSyncableStorageKey(key)) return;
      // Vérifier si un clear forcé est en cours (erreur 401)
      if ((window as any).__forceClearInProgress) return;
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) return;
      enqueueGeneralOp({ op: 'remove', key });
      if (isProgressKey(key)) {
        progressOpsMapRef.current.delete(key);
      }
    };

    // Safari and Firefox/Librewolf-specific localStorage monitoring with enhanced detection
    const browserPollingInterval = ((isSafari || isFirefox) && isLocalStorageAvailable) ? setInterval(() => {
      try {
        // Check for changes in localStorage
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;

          const currentValue = localStorage.getItem(key);
          const prevValue = prevValuesRefLocal.current.get(key);

          if (currentValue !== prevValue) {
            console.log(`${isSafari ? 'Safari' : 'Firefox/Librewolf'} detected localStorage change for key: ${key}`, {
              oldValue: prevValue,
              newValue: currentValue
            });

            // Process changes (sync is now allowed on watch routes)
            if (currentValue === null) {
              // Key was removed
              processRemove(key);
              prevValuesRefLocal.current.delete(key);
            } else {
              // Key was added or changed
              processSet(key, prevValue || null, currentValue);
              prevValuesRefLocal.current.set(key, currentValue);
            }
          }
        }

        // Check for removed keys
        const currentKeys = new Set<string>();
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) currentKeys.add(key);
        }

        prevValuesRefLocal.current.forEach((_, key) => {
          if (!currentKeys.has(key)) {
            console.log(`${isSafari ? 'Safari' : 'Firefox/Librewolf'} detected localStorage key removal: ${key}`);
            // Process key removal (sync is now allowed on watch routes)
            processRemove(key);
            prevValuesRefLocal.current.delete(key);
          }
        });
      } catch (error) {
        console.warn(`${isSafari ? 'Safari' : 'Firefox/Librewolf'} localStorage polling error:`, error);
      }
    }, 2000) : null; // Poll every 2 seconds for Safari and Firefox/Librewolf

    // Additional browser-specific: Monitor for direct localStorage access
    // This helps catch changes made by third-party scripts or direct access
    const browserDirectAccessMonitor = ((isSafari || isFirefox) && isLocalStorageAvailable) ? setInterval(() => {
      try {
        // Force a check by comparing current localStorage state with our snapshot
        const currentSnapshot = new Map<string, string | null>();
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) {
            currentSnapshot.set(key, localStorage.getItem(key));
          }
        }

        // Compare snapshots
        const hasChanges = currentSnapshot.size !== prevValuesRefLocal.current.size ||
          Array.from(currentSnapshot.entries()).some(([key, value]) =>
            prevValuesRefLocal.current.get(key) !== value
          );

        if (hasChanges) {
          console.log(`${isSafari ? 'Safari' : 'Firefox/Librewolf'} detected localStorage changes via direct access monitoring`);
          // Update our snapshot to match current state (sync is now allowed on watch routes)
          prevValuesRefLocal.current.clear();
          currentSnapshot.forEach((value, key) => {
            prevValuesRefLocal.current.set(key, value);
          });
        }
      } catch (error) {
        console.warn(`${isSafari ? 'Safari' : 'Firefox/Librewolf'} direct access monitoring error:`, error);
      }
    }, 5000) : null; // Check every 5 seconds

    const originalSetItem = localStorage.setItem;
    const originalRemoveItem = localStorage.removeItem;
    const originalClear = localStorage.clear;

    localStorage.setItem = function (key: string, value: string) {
      if (!isLocalStorageAvailable) return;

      const oldVal = prevValuesRefLocal.current.get(key) ?? localStorage.getItem(key);
      originalSetItem.call(localStorage, key, value);
      prevValuesRefLocal.current.set(key, value);

      // Always trigger processing for all browsers (unless during profile data loading)
      if (!isProfileDataLoadingRef.current) {
        processSet(key, oldVal, value);
      }
    } as any;

    localStorage.removeItem = function (key: string) {
      if (!isLocalStorageAvailable) return;

      originalRemoveItem.call(localStorage, key);
      prevValuesRefLocal.current.delete(key);

      // Always trigger processing for all browsers (unless during profile data loading)
      if (!isProfileDataLoadingRef.current) {
        processRemove(key);
      }
    } as any;

    localStorage.clear = function () {
      if (!isLocalStorageAvailable) return;

      // Create remove ops for all keys
      const keys: string[] = [];
      prevValuesRefLocal.current.forEach((_, k) => keys.push(k));
      originalClear.call(localStorage);

      // Vérifier si un clear forcé est en cours (erreur 401)
      if (!(window as any).__forceClearInProgress && !isProfileDataLoadingRef.current) {
        keys.forEach(k => processRemove(k));
      }

      prevValuesRefLocal.current.clear();
    } as any;

    const storageListener = (e: StorageEvent) => {
      if (!e.key) return;
      // Skip sync during profile data loading (but allow on watch routes)
      if (isProfileDataLoadingRef.current) return;

      if (e.newValue === null) {
        processRemove(e.key);
        prevValuesRefLocal.current.delete(e.key);
      } else {
        processSet(e.key, e.oldValue, e.newValue);
        prevValuesRefLocal.current.set(e.key, e.newValue);
      }
    };
    window.addEventListener('storage', storageListener);

    const progressInterval = setInterval(() => {
      // Skip sync during profile data loading (but allow on watch routes)
      if (!isProfileDataLoadingRef.current) {
        flushProgressOps();
      }
    }, 10000); // every 10s

    return () => {
      window.removeEventListener('storage', storageListener);
      if (generalFlushTimeoutRef.current) clearTimeout(generalFlushTimeoutRef.current);
      clearInterval(progressInterval);
      if (browserPollingInterval) clearInterval(browserPollingInterval);
      if (browserDirectAccessMonitor) clearInterval(browserDirectAccessMonitor);
      localStorage.setItem = originalSetItem as any;
      localStorage.removeItem = originalRemoveItem as any;
      localStorage.clear = originalClear as any;
    };
  }, [isWatchRoute]); // Add isWatchRoute as dependency

  // Determine user type, ID, and profile ID (only oauth and bip39 users can sync)
  const getUserInfo = () => {
    const profileId = localStorage.getItem('selected_profile_id');
    const account = getResolvedAccountContext();

    if (!account.userType) {
      return { type: null, id: null, profileId: null };
    }

    return {
      type: account.userType,
      id: account.userId,
      profileId,
    };
  };

  // Guest UUID generation removed - no sync for guests

  // Load user data when authenticated via OAuth/BIP39 - only once when auth status changes
  useEffect(() => {
    // Skip if initial sync is already done
    if (isInitialSyncDone) {
      return;
    }

    // Skip initial data loading on watch routes (but allow sync)
    if (isWatchRoute) {
      console.log("Skipping initial data loading - on watch route");
      return;
    }

    const userInfo = getUserInfo();

    // Only load data for oauth and bip39 users with a selected profile
    // Note: ProfileContext now handles loading profile data, so we just mark sync as done
    if (userInfo.type && userInfo.id && userInfo.profileId && ['oauth', 'bip39'].includes(userInfo.type)) {
      // ProfileContext will handle loading the profile data
      console.log("Profile data loading handled by ProfileContext");
      setIsInitialSyncDone(true);
    } else {
      // For users without sync capability, just mark sync as done
      setIsInitialSyncDone(true);
    }
  }, [isInitialSyncDone, isWatchRoute]); // Add isWatchRoute as dependency



  return null;
};



// Nudge popup when user still has the default profile
const DefaultProfileNudge: React.FC = () => {
  let currentProfile = null;
  let profiles: any[] = [];
  try {
    const ctx = useProfile();
    currentProfile = ctx.currentProfile;
    profiles = ctx.profiles;
  } catch {
    // ProfileProvider might not be available
  }
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Show nudge when user still has the default name AND default avatar
  const defaultNames = [t('nav.profile').toLowerCase(), 'profil', 'profile'];
  const isDefault =
    currentProfile &&
    profiles.length === 1 &&
    defaultNames.includes(currentProfile.name?.toLowerCase().trim()) &&
    currentProfile.avatar === '/avatars/disney/disney_avatar_1.png';

  useEffect(() => {
    if (!isDefault || dismissed) { setVisible(false); return; }
    // Don't show if already dismissed
    if (sessionStorage.getItem('profile_nudge_dismissed')) { return; }
    const timer = setTimeout(() => setVisible(true), 2500);
    return () => clearTimeout(timer);
  }, [isDefault, dismissed]);

  const handleDismiss = () => {
    setDismissed(true);
    setVisible(false);
    sessionStorage.setItem('profile_nudge_dismissed', 'true');
  };

  const handleCustomize = () => {
    handleDismiss();
    navigate('/profile');
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 40, scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 300, damping: 28 }}
          className="fixed bottom-6 right-4 sm:right-6 z-[10000] max-w-xs w-[calc(100vw-32px)] sm:w-80"
        >
          <div className="bg-gray-900/95 backdrop-blur-xl border border-gray-700/80 rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-4">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-full overflow-hidden ring-2 ring-red-500/50 flex-shrink-0">
                  <img
                    src="/avatars/disney/disney_avatar_1.png"
                    alt=""
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white">{t('profile.defaultProfileNudgeTitle')}</p>
                  <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{t('profile.defaultProfileNudgeMessage')}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={handleCustomize}
                  className="flex-1 px-3 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  {t('profile.defaultProfileNudgeCta')}
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={handleDismiss}
                  className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors"
                >
                  {t('profile.defaultProfileNudgeDismiss')}
                </motion.button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// Profile Gate Component - checks if user needs to select a profile
const ProfileGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentProfile, profiles, isLoading } = useProfile();
  const location = useLocation();
  const [loadingTimedOut, setLoadingTimedOut] = React.useState(false);

  // Skip profile gate on watch routes and BIP39 link flows
  const isWatchRoute = location.pathname.startsWith('/watch/');
  const isBip39LinkRoute = location.pathname.startsWith('/link-bip39');

  // Check if user is authenticated
  const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
  const isGoogleAuth = localStorage.getItem('google_auth') === 'true';
  const isBip39Auth = localStorage.getItem('bip39_auth') === 'true';
  const isVipUser = localStorage.getItem('is_vip') === 'true';

  // Vérifier l'ancienne méthode d'authentification VIP (pour compatibilité)
  let isVipAuth = false;
  const authStr = localStorage.getItem('auth');
  if (authStr) {
    try {
      const authObj = JSON.parse(authStr);
      if (authObj.userProfile && authObj.userProfile.provider === 'access_code') {
        isVipAuth = true;
      }
    } catch { }
  }

  const isAuthenticated = isDiscordAuth || isGoogleAuth || isBip39Auth || isVipAuth || isVipUser;

  // Timeout mechanism: if loading takes more than 5 seconds, continue without profiles
  React.useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    if (isLoading || (profiles.length === 0 && isAuthenticated && !loadingTimedOut)) {
      timeoutId = setTimeout(() => {
        console.warn('ProfileGate: Loading timeout reached (5s), continuing without profile data');
        setLoadingTimedOut(true);
      }, 5000);
    }

    // Reset timeout state when loading completes successfully
    if (!isLoading && profiles.length > 0) {
      setLoadingTimedOut(false);
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [isLoading, profiles.length, isAuthenticated, loadingTimedOut]);

  // Don't show profile gate for non-authenticated users, VIP users, watch routes, or BIP39 link flows
  if (!isAuthenticated || isVipUser || isVipAuth || isWatchRoute || isBip39LinkRoute) {
    if (isWatchRoute || isBip39LinkRoute) {
      console.log('ProfileGate: Skipping profile gate for route:', location.pathname);
    }
    return <>{children}</>;
  }

  // If loading timed out, continue without profile data
  if (loadingTimedOut) {
    console.log('ProfileGate: Timeout reached, skipping profile gate');
    return <>{children}</>;
  }

  // Show loading while profiles are being loaded or created
  if (isLoading || (profiles.length === 0 && isAuthenticated)) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-red-600 mx-auto mb-4"></div>
          <p className="text-white">{i18n.t('profile.loadingProfiles')}</p>
        </div>
      </div>
    );
  }

  // If no profiles exist or no profile is selected, show profile selection
  if (profiles.length === 0 || !currentProfile) {
    return <ProfileSelection />;
  }

  // User has selected a profile, show the app
  return <>{children}</>;
};

const AppWithIntro: React.FC = () => {
  const location = useLocation();
  const [showRedirectPopup, setShowRedirectPopup] = useState(false);
  const { showIntro, completeIntro } = useIntro();

  // Détecter si on est sur une route /watch ou la page 404
  const isWatchRoute = location.pathname.startsWith('/watch/') || location.pathname.startsWith('/watchparty/room/') || location.pathname.startsWith('/ftv/watch/');
  const isScreensaverDisabledRoute = isWatchRoute || location.pathname.startsWith('/live-tv');

  // Screensaver logic
  const [screensaverEnabled, setScreensaverEnabled] = useState(() => localStorage.getItem('screensaver_enabled') === 'true');
  const [screensaverTimeout, setScreensaverTimeout] = useState(() => {
    const saved = localStorage.getItem('screensaver_timeout');
    return saved ? parseInt(saved, 10) : 60;
  });

  const shouldEnableScreensaver = screensaverEnabled && !isScreensaverDisabledRoute;
  const { isIdle, wake } = useIdleTimer(screensaverTimeout * 1000, shouldEnableScreensaver);

  // Listen for settings changes from Profile page
  React.useEffect(() => {
    const handleSettingsChange = () => {
      setScreensaverEnabled(localStorage.getItem('screensaver_enabled') === 'true');
      const t = localStorage.getItem('screensaver_timeout');
      setScreensaverTimeout(t ? parseInt(t, 10) : 60);
    };
    window.addEventListener('screensaver_settings_changed', handleSettingsChange);
    return () => window.removeEventListener('screensaver_settings_changed', handleSettingsChange);
  }, []);
  // Pages avec hero header (pas d'espace top): Home, ProviderContent, Movies, TVShows
  const currentPath = location.pathname;
  const isHeroHeaderPage =
    currentPath === '/' ||
    currentPath === '/movies' ||
    currentPath === '/tv-shows' ||
    currentPath.startsWith('/provider/');
  const isAprilFoolsAdminRouteEnabled = isAprilFoolsAdminEnabled(location.search);
  const isNotFoundPage = location.pathname === '*' || location.pathname.match(/\/(?!(watch\/|watchparty\/room\/)).*/) === null;
  // Pages sans footer: watch routes, 404, profile selection, profile management, wrapped
  const isWrappedPage = currentPath === '/wrapped' || currentPath.startsWith('/wrapped/');
  const isCineGraphPage = currentPath === '/cinegraph';
  const isNoFooterPage = isWatchRoute || isNotFoundPage || currentPath === '/profile-selection' || currentPath === '/profile-management' || isWrappedPage || isCineGraphPage;

  React.useEffect(() => {
    // Masquer le footer sur les routes /watch, 404, et pages de profil
    const footer = document.querySelector('footer');
    if (footer) {
      if (isNoFooterPage) {
        footer.style.display = 'none';
      } else {
        footer.style.display = '';
      }
    }
    // Nettoyage au démontage
    return () => {
      if (footer) footer.style.display = '';
    };
  }, [isNoFooterPage]);

  // Apply profile page styles
  React.useEffect(() => {
    const isProfilePage = currentPath === '/profile-selection' || currentPath === '/profile-management';

    if (isProfilePage) {
      document.body.classList.add('profile-page');
      document.documentElement.classList.add('profile-page');
    } else {
      document.body.classList.remove('profile-page');
      document.documentElement.classList.remove('profile-page');
    }

    // Cleanup
    return () => {
      document.body.classList.remove('profile-page');
      document.documentElement.classList.remove('profile-page');
    };
  }, [currentPath]);

  // Scroll to top when ad popup is accepted (lecture click)
  React.useEffect(() => {
    const onAccepted = () => {
      try {
        scrollViewportToTop(shouldAnimateScrollToTop() ? 'smooth' : 'instant');
      } catch { }
    };
    window.addEventListener('ad_popup_accepted', onAccepted);
    return () => window.removeEventListener('ad_popup_accepted', onAccepted);
  }, []);

  // Check for redirect parameter
  React.useEffect(() => {
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get('redirect') !== null) {
      setShowRedirectPopup(true);
    }
  }, [location.search]);

  return (
    <div className="min-h-screen bg-black text-white relative overflow-hidden">
      {/* Intro overlay — le site charge derrière */}
      {showIntro && <IntroAnimation onAnimationComplete={completeIntro} />}
      {/* Global styles for profile pages */}
      <style>
        {`
          body.profile-page {
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
          }
          html.profile-page {
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
          }
        `}
      </style>
      {/* Composant pour faire défiler vers le haut lors des changements de route */}
      <ScrollToTop />
      {/* Animation de scroll fluide globale (Lenis) */}
      <SmoothScroll />
      {/* Ne pas afficher le Header sur les routes /watch, pages de profil et wrapped */}
      {!isWatchRoute && currentPath !== '/profile-selection' && currentPath !== '/profile-management' && !isWrappedPage && <Header />}
      <PersistenceManager />
      <div className={!isWatchRoute && !isHeroHeaderPage && currentPath !== '/profile-selection' && currentPath !== '/profile-management' && !isWrappedPage ? 'pt-20' : ''}>
        <AlertNotificationManager />
        <DefaultProfileNudge />
        <ProfileGate>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/search" element={<Search />} />
            <Route path="/movies" element={<Movies />} />
            <Route path="/tv-shows" element={<TVShows />} />
            <Route path="/collections" element={<Collections />} />
            <Route path="/collection/:id" element={<CollectionDetails />} />
            <Route path="/movie/:id" element={<MovieDetails />} />
            <Route path="/tv/:id" element={<TVDetails />} />
            <Route path="/download/:type/:id" element={<DownloadPage />} />
            <Route path="/debrid" element={<DebridPage />} />
            <Route path="/genre/:mediaType/:genreId" element={<GenrePage />} />
            <Route path="/roulette" element={<RoulettePage />} />
            <Route path="/provider/:providerId" element={<ProviderContent />} />
            <Route path="/provider/:providerId/:type" element={<ProviderCatalogPage />} />
            <Route path="/provider/:providerId/:type/:genreId" element={<ProviderCatalogPage />} />
            <Route path="/auth" element={<DiscordAuth />} />
            <Route path="/auth/google" element={<GoogleAuth />} />
            <Route path="/create-account" element={<CreateAccount />} />
            <Route path="/login-bip39" element={<LoginBip39 />} />
            <Route path="/link-bip39" element={<LoginBip39 mode="link" />} />
            <Route path="/link-bip39/create" element={<CreateAccount mode="link" />} />
            <Route path="/person/:id" element={<PersonDetails />} />
            <Route path="/profile" element={<PrivateRoute><Profile /></PrivateRoute>} />
            <Route path="/alerts" element={<AlertsPage />} />
            <Route path="/live-tv" element={<LiveTV />} />
            <Route path="/watch/movie/:tmdbid" element={<WatchMovie />} />
            <Route path="/watch/tv/:tmdbid/s/:season/e/:episode" element={<WatchTv />} />
            <Route path="/watch/anime/:id/season/:season/episode/:episode" element={<WatchAnime />} />
            {/* Watch Party Routes */}
            <Route path="/watchparty/create" element={<WatchPartyCreate />} />
            <Route path="/watchparty/room/:roomId" element={<WatchPartyRoom />} />
            <Route path="/watchparty/join" element={<WatchPartyJoin />} />
            <Route path="/watchparty/join/:code" element={<WatchPartyJoin />} />
            <Route path="/watchparty/list" element={<WatchPartyList />} />
            <Route path="/suggestion" element={<SuggestionPage />} />
            <Route path="/extension" element={<ExtensionPage />} />
            <Route path="/list/:shareCode" element={<SharedListPage />} />
            <Route path="/list-catalog" element={<SharedListsCatalogPage />} />
            <Route path="/dmca" element={<DMCA />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path={APRIL_FOOLS_ADMIN_PATH} element={isAprilFoolsAdminRouteEnabled ? <AprilFoolsAdminPage /> : <Navigate to="/" replace />} />
            <Route path="/profile-selection" element={<ProfileSelection />} />
            <Route path="/profile-management" element={<ProfileManagement />} />
            {/* Wishboard / Greenlight Routes */}
            <Route path="/wishboard" element={<WishboardPage />} />
            <Route path="/wishboard/new" element={<WishboardNewRequest />} />
            <Route path="/wishboard/my-requests" element={<WishboardUserRequests />} />
            <Route path="/wishboard/submit-link" element={<SubmitLinkPage />} />
            {/* VIP Route */}
            <Route path="/vip" element={<VipPage />} />
            <Route path="/vip/don" element={<VipDonatePage />} />
            <Route path="/vip/invoice/:publicId" element={<VipInvoicePage />} />
            <Route path="/vip/cadeau/:giftToken" element={<VipGiftPage />} />
            {/* What is Movix Route */}
            <Route path="/about" element={<WhatIsMovixPage />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms-of-service" element={<TermsOfService />} />
            <Route path="/terms" element={<Navigate to="/terms-of-service" replace />} />
            {/* CinéGraph Route */}
            <Route path="/cinegraph" element={<CineGraphPage />} />
            {/* Settings Route */}
            <Route path="/settings" element={<SettingsPage />} />
            {/* Top 10 Route */}
            <Route path="/top10" element={<Top10Page />} />
            {/* France.tv Routes */}
            <Route path="/ftv" element={<FranceTVBrowse />} />
            <Route path="/ftv/info/:encoded" element={<FranceTVInfo />} />
            <Route path="/ftv/watch/:encoded" element={<FranceTVPlayer />} />
            {/* Wrapped Route */}
            <Route path="/wrapped" element={<WrappedPage />} />
            <Route path="/wrapped/:year" element={<WrappedPage />} />
            {/* Route catch-all pour la page 404 */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ProfileGate>
        <Analytics />
        <Footer />
      </div>

      {/* Redirect Popup */}
      <RedirectPopup
        isOpen={showRedirectPopup}
        onClose={() => setShowRedirectPopup(false)}
      />

      {/* Screensaver */}
      {shouldEnableScreensaver && <ScreenSaver isIdle={isIdle} onWake={wake} />}
    </div>
  );
};

const MAINTENANCE_MODE = false; // Mettre à `false` pour désactiver le mode maintenance

// Composant pour bloquer l'embed depuis wavewatch.xyz
const EmbedBlockPage = () => (
  <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4 text-center sm:p-6 lg:p-8">
    <h1 className="text-4xl font-bold mb-4 sm:text-5xl lg:text-6xl">{i18n.t('embed.blocked')}</h1>
    <div className="border-2 border-red-700 bg-red-950/60 rounded-lg p-6 max-w-md w-full shadow-lg sm:max-w-lg lg:max-w-2xl">
      <h2 className="text-2xl font-semibold mb-3 sm:text-3xl lg:text-4xl">{i18n.t('embed.unauthorized')}</h2>
      <p className="text-base mb-4 sm:text-lg lg:text-xl">
        {i18n.t('embed.message')}
      </p>
      <a
        href="https://movix.website"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition sm:py-3 sm:px-6 lg:py-4 lg:px-8"
      >
        {i18n.t('embed.goToSite')}
      </a>
    </div>
  </div>
);

const MaintenancePage = ({ onContinue }: { onContinue: () => void }) => (
  <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-4 text-center sm:p-6 lg:p-8">
    <h1 className="text-4xl font-bold mb-4 sm:text-5xl lg:text-6xl">{i18n.t('maintenance.title')}</h1>
    <div className="border-2 border-red-700 bg-red-950/60 rounded-lg p-6 max-w-md w-full shadow-lg sm:max-w-lg lg:max-w-2xl">
      <h2 className="text-2xl font-semibold mb-3 sm:text-3xl lg:text-4xl">{i18n.t('maintenance.subtitle')}</h2>
      <p className="text-base mb-4 sm:text-lg lg:text-xl">
        {i18n.t('maintenance.message')}
      </p>
      <button
        onClick={onContinue}
        className="mt-2 inline-block bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-2 px-4 rounded transition sm:py-3 sm:px-6 lg:py-4 lg:px-8"
      >
        {i18n.t('maintenance.continueAnyway')}
      </button>
    </div>
  </div>
);

function App() {
  const [forceContinue, setForceContinue] = React.useState(false);

  // Vérifier si le site est embarqué depuis wavewatch.xyz (DÉSACTIVÉ)
  const isEmbeddedFromWavewatch = React.useMemo(() => {
    try {
      return false; // Désactivé - ne bloque plus l'embed
      // return document.referrer && document.referrer.includes('embed.wavewatch.xyz');
    } catch (error) {
      return false;
    }
  }, []);

  // Bloquer l'accès si embarqué depuis wavewatch.xyz (DÉSACTIVÉ)
  if (isEmbeddedFromWavewatch) {
    return <EmbedBlockPage />;
  }

  if (MAINTENANCE_MODE && !forceContinue) {
    return <MaintenancePage onContinue={() => setForceContinue(true)} />;
  }

  return (
    <BrowserRouter>
      <TooltipProvider delayDuration={300}>
      <SearchProvider>
        <AdFreePopupProvider>
          <AuthProvider>
            <AdWarningProvider>
              <VipModalProvider>
                <ProfileProvider>
                  <TurnstileProvider>
                    <IntroProvider>
                      <IOSHomeScreenHandler />
                      <AppWithIntro />
                      <Toaster position="bottom-right" richColors />
                    </IntroProvider>
                  </TurnstileProvider>
                </ProfileProvider>
              </VipModalProvider>
            </AdWarningProvider>
          </AuthProvider>
        </AdFreePopupProvider>
      </SearchProvider>
      </TooltipProvider>
    </BrowserRouter>
  );
};

export default App;
