import { useEffect } from 'react';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

const LENIS_BYPASS_SELECTOR = [
  '[data-lenis-prevent]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[data-notifications-popup]',
  '[data-radix-popper-content-wrapper]',
  '[data-radix-scroll-area-viewport]',
].join(', ');

const hasScrollableOverflow = (value: string) =>
  value === 'auto' || value === 'scroll' || value === 'overlay';

const isScrollableElement = (node: HTMLElement) => {
  const style = window.getComputedStyle(node);

  return hasScrollableOverflow(style.overflowY) || hasScrollableOverflow(style.overflowX);
};

const isFloatingLayer = (node: HTMLElement) => {
  const style = window.getComputedStyle(node);

  if (style.position !== 'fixed' && style.position !== 'absolute') {
    return false;
  }

  const zIndex = Number.parseInt(style.zIndex || '', 10);

  return Number.isNaN(zIndex) || zIndex >= 40;
};

const hasFloatingLayerAncestor = (node: HTMLElement) => {
  let current: HTMLElement | null = node;

  while (current && current !== document.body && current !== document.documentElement) {
    if (isFloatingLayer(current)) {
      return true;
    }

    current = current.parentElement;
  }

  return false;
};

const shouldPreventLenis = (node: HTMLElement) => {
  if (node.matches(LENIS_BYPASS_SELECTOR) || node.closest(LENIS_BYPASS_SELECTOR)) {
    return true;
  }

  return isScrollableElement(node) && hasFloatingLayerAncestor(node);
};

const SmoothScroll = () => {
  useEffect(() => {
    let lenis: Lenis | null = null;
    let rafId = 0;

    const stopRaf = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    const raf = (time: number) => {
      if (!lenis || document.hidden) {
        rafId = 0;
        return;
      }

      lenis.raf(time);
      rafId = requestAnimationFrame(raf);
    };

    const startRaf = () => {
      if (!lenis || rafId || document.hidden) return;
      rafId = requestAnimationFrame(raf);
    };

    const initLenis = () => {
      const isEnabled = localStorage.getItem('settings_smooth_scroll') !== 'false';

      if (!isEnabled) {
        if (lenis) {
          stopRaf();
          lenis.destroy();
          lenis = null;
          delete (window as typeof window & { lenis?: Lenis }).lenis;
          document.documentElement.style.scrollBehavior = 'auto';
        }
        return;
      }

      if (lenis) return;

      document.documentElement.style.scrollBehavior = 'auto';

      lenis = new Lenis({
        duration: 1.2,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        orientation: 'vertical',
        gestureOrientation: 'vertical',
        smoothWheel: true,
        wheelMultiplier: 1,
        touchMultiplier: 2,
        prevent: shouldPreventLenis,
      });

      startRaf();
      (window as typeof window & { lenis?: Lenis }).lenis = lenis;
    };

    initLenis();

    const handleStorageChange = (e: StorageEvent | CustomEvent) => {
      if (e instanceof StorageEvent && e.key !== 'settings_smooth_scroll') return;
      initLenis();
    };

    const handleVisibilityChange = () => {
      if (!lenis) return;

      if (document.hidden) {
        stopRaf();
        lenis.stop();
        return;
      }

      lenis.start();
      startRaf();
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('settings_smooth_scroll_changed', handleStorageChange as EventListener);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopRaf();

      if (lenis) {
        lenis.destroy();
        delete (window as typeof window & { lenis?: Lenis }).lenis;
      }

      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('settings_smooth_scroll_changed', handleStorageChange as EventListener);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return null;
};

export default SmoothScroll;
