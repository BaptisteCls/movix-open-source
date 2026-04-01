import React, { useEffect, useRef } from 'react';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface TurnstileWidgetProps {
  onTokenChange: (token: string) => void;
  resetSignal?: number;
  className?: string;
  theme?: 'light' | 'dark' | 'auto';
  action?: string;
}

const TurnstileWidget: React.FC<TurnstileWidgetProps> = ({
  onTokenChange,
  resetSignal = 0,
  className,
  theme = 'dark',
  action
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) {
      onTokenChange('');
      return undefined;
    }

    let isMounted = true;

    const renderWidget = () => {
      if (!isMounted || !window.turnstile || !containerRef.current || widgetIdRef.current) {
        return;
      }

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme,
        ...(action ? { action } : {}),
        callback: (token: string) => onTokenChange(token),
        'expired-callback': () => onTokenChange(''),
        'error-callback': () => onTokenChange('')
      });
    };

    if (window.turnstile) {
      renderWidget();
    } else {
      const interval = window.setInterval(() => {
        if (window.turnstile) {
          window.clearInterval(interval);
          renderWidget();
        }
      }, 200);

      const timeout = window.setTimeout(() => {
        window.clearInterval(interval);
      }, 10000);

      return () => {
        isMounted = false;
        window.clearInterval(interval);
        window.clearTimeout(timeout);
        onTokenChange('');
        if (widgetIdRef.current && window.turnstile) {
          try {
            window.turnstile.remove(widgetIdRef.current);
          } catch {
            // Ignore cleanup errors from Cloudflare widget
          }
        }
        widgetIdRef.current = null;
      };
    }

    return () => {
      isMounted = false;
      onTokenChange('');
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Ignore cleanup errors from Cloudflare widget
        }
      }
      widgetIdRef.current = null;
    };
  }, [action, onTokenChange, theme]);

  useEffect(() => {
    onTokenChange('');
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [onTokenChange, resetSignal]);

  if (!TURNSTILE_SITE_KEY) {
    return null;
  }

  return <div ref={containerRef} className={className} />;
};

export default TurnstileWidget;
