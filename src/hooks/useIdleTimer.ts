import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Hook that detects user inactivity and triggers a callback.
 * Uses setInterval polling instead of setTimeout for mobile reliability
 * (mobile browsers throttle/suspend setTimeout in background).
 */
export function useIdleTimer(timeoutMs: number, enabled: boolean = true) {
  const [isIdle, setIsIdle] = useState(false);
  const idleStartRef = useRef<number | null>(null);
  const idleLogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const isIdleRef = useRef(false); // Mirror state in ref for event handlers
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    isIdleRef.current = isIdle;
  }, [isIdle]);

  // Log idle duration periodically
  useEffect(() => {
    if (isIdle) {
      idleStartRef.current = Date.now();
      const elapsed = ((Date.now() - lastActivityRef.current) / 1000).toFixed(0);
      console.log(`[IdleTimer] 💤 Utilisateur inactif depuis ${elapsed}s — screensaver activé`);

      idleLogIntervalRef.current = setInterval(() => {
        if (idleStartRef.current) {
          const secs = ((Date.now() - idleStartRef.current) / 1000).toFixed(0);
          console.log(`[IdleTimer] ⏱️ Idle depuis ${secs}s`);
        }
      }, 10_000);
    } else {
      if (idleStartRef.current) {
        const duration = ((Date.now() - idleStartRef.current) / 1000).toFixed(1);
        console.log(`[IdleTimer] ✅ Retour actif — idle pendant ${duration}s`);
        idleStartRef.current = null;
      }
      if (idleLogIntervalRef.current) {
        clearInterval(idleLogIntervalRef.current);
        idleLogIntervalRef.current = null;
      }
      lastActivityRef.current = Date.now();
    }

    return () => {
      if (idleLogIntervalRef.current) {
        clearInterval(idleLogIntervalRef.current);
        idleLogIntervalRef.current = null;
      }
    };
  }, [isIdle]);

  const wake = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIsIdle(false);
    isIdleRef.current = false;
  }, []);

  useEffect(() => {
    if (!enabled) {
      setIsIdle(false);
      isIdleRef.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
      console.log('[IdleTimer] ⚫ Screensaver désactivé');
      return;
    }

    console.log(`[IdleTimer] 🟢 Screensaver activé — timeout: ${(timeoutMs / 1000).toFixed(0)}s`);
    lastActivityRef.current = Date.now();

    // Events qui détectent l'activité pour RETARDER l'idle
    const idleDetectionEvents = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'touchmove', 'touchend', 'wheel'];
    // Events qui peuvent RÉVEILLER depuis l'idle (seulement clic/touche/touch)
    const wakeEvents = ['mousedown', 'keydown', 'touchstart', 'touchend'];

    // Quand pas idle: enregistrer l'activité
    const handleActivity = () => {
      if (!isIdleRef.current) {
        lastActivityRef.current = Date.now();
      }
    };

    // Quand idle: seuls clic/touche/touch réveillent
    const handleWake = () => {
      if (isIdleRef.current) {
        lastActivityRef.current = Date.now();
        isIdleRef.current = false;
        setIsIdle(false);
      }
    };

    // Vérifier aussi quand l'onglet redevient visible (mobile: retour à l'app)
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !isIdleRef.current) {
        lastActivityRef.current = Date.now();
      }
    };

    idleDetectionEvents.forEach((ev) => window.addEventListener(ev, handleActivity, { passive: true }));
    wakeEvents.forEach((ev) => window.addEventListener(ev, handleWake, { passive: true }));
    document.addEventListener('visibilitychange', handleVisibility);

    // Polling: vérifier toutes les 2s si le timeout est dépassé
    // Beaucoup plus fiable que setTimeout sur mobile
    pollRef.current = setInterval(() => {
      if (isIdleRef.current) return;
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= timeoutMs) {
        console.log(`[IdleTimer] ⏰ Polling: ${(elapsed / 1000).toFixed(0)}s écoulées → idle`);
        isIdleRef.current = true;
        setIsIdle(true);
      }
    }, 2000);

    return () => {
      idleDetectionEvents.forEach((ev) => window.removeEventListener(ev, handleActivity));
      wakeEvents.forEach((ev) => window.removeEventListener(ev, handleWake));
      document.removeEventListener('visibilitychange', handleVisibility);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [timeoutMs, enabled]);

  return { isIdle, wake };
}
