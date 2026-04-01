import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ExternalLink, Bell, Calendar, Clock } from 'lucide-react';
import { NotificationToastProps } from '../types/alerts';
import { useTranslation } from 'react-i18next';

const NotificationToast: React.FC<NotificationToastProps> = ({
  notification,
  onDismiss,
  onGoToShow,
  onRemindLater
}) => {
  const { t, i18n } = useTranslation();
  const [isVisible, setIsVisible] = useState(true);
  const [progress, setProgress] = useState(100);
  const [isExiting, setIsExiting] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-dismiss after 15 seconds
  useEffect(() => {
    const duration = 15000; // 15 seconds
    const interval = 100; // Update every 100ms
    const decrement = (interval / duration) * 100;

    progressTimerRef.current = setInterval(() => {
      setProgress(prev => {
        const newProgress = prev - decrement;
        if (newProgress <= 0) {
          if (progressTimerRef.current) {
            clearInterval(progressTimerRef.current);
          }
          // Don't auto-dismiss, just stop the progress bar
          return 0;
        }
        return newProgress;
      });
    }, interval);

    // Auto-dismiss after 15 seconds (but don't mark as dismissed)
    timerRef.current = setTimeout(() => {
      handleAutoDismiss();
    }, duration);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, []);

  const handleAutoDismiss = () => {
    if (isExiting) return;
    setIsExiting(true);
    setIsVisible(false);

    // Clear timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);

    // Wait for exit animation before calling onRemindLater (auto-dismiss = remind later)
    setTimeout(() => {
      onRemindLater();
    }, 400);
  };

  const handleExplicitDismiss = () => {
    if (isExiting) return;
    setIsExiting(true);
    setIsVisible(false);

    // Clear timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);

    // Wait for exit animation before calling onDismiss (explicit dismiss = permanent)
    setTimeout(() => {
      onDismiss();
    }, 400);
  };

  const handleGoToShow = () => {
    if (isExiting) return;
    setIsExiting(true);
    setIsVisible(false);

    // Clear timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);

    // Wait for exit animation before calling onGoToShow
    setTimeout(() => {
      onGoToShow();
    }, 400);
  };

  const handleRemindLater = () => {
    if (isExiting) return;
    setIsExiting(true);
    setIsVisible(false);

    // Clear timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);

    // Wait for exit animation before calling onRemindLater
    setTimeout(() => {
      onRemindLater();
    }, 400);
  };

  const formatAirDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(i18n.language, {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  };

  return (
    <AnimatePresence mode="wait">
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, x: 300, scale: 0.9 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{
            opacity: 0,
            x: 300,
            scale: 0.9,
            transition: { duration: 0.4, ease: "easeInOut" }
          }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed top-4 right-2 z-[10000] max-w-xs w-[calc(100vw-16px)] sm:max-w-sm sm:w-full sm:mx-0 sm:right-4"
        >
          <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-sm">
            {/* Progress bar */}
            <div className="h-1 bg-gray-800">
              <motion.div
                className="h-full bg-gradient-to-r from-yellow-500 to-orange-500"
                style={{ width: `${progress}%` }}
                transition={{ duration: 0.1 }}
              />
            </div>

            {/* Content */}
            <div className="p-3 sm:p-4">
              {/* Header */}
              <div className="flex items-start justify-between mb-2 sm:mb-3">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <div className="p-1 sm:p-1.5 bg-yellow-500/20 rounded-lg">
                    <Bell className="w-3 h-3 sm:w-4 sm:h-4 text-yellow-500" />
                  </div>
                  <span className="text-xs sm:text-sm font-medium text-yellow-500">
                    {t('alerts.episodeAlert')}
                  </span>
                </div>
                <button
                  onClick={handleAutoDismiss}
                  className="p-1 hover:bg-gray-800 rounded-lg transition-colors"
                  title={t('notifications.closeRemindLater')}
                >
                  <X className="w-3 h-3 sm:w-4 sm:h-4 text-gray-400" />
                </button>
              </div>

              {/* Message */}
              <div className="mb-3 sm:mb-4">
                <p className="text-white font-medium text-xs sm:text-sm leading-relaxed">
                  {notification.message}
                </p>

                {/* Episode details */}
                <div className="mt-1.5 sm:mt-2 text-xs text-gray-400 space-y-1">
                  {notification.episodeName && (
                    <div className="truncate">"{notification.episodeName}"</div>
                  )}
                  <div className="flex items-center gap-1">
                    <Calendar className="w-3 h-3 flex-shrink-0" />
                    <span className="text-xs">{t('alerts.airsOn', { date: formatAirDate(notification.airDate) })}</span>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-1.5 sm:gap-2">
                <motion.button
                  onClick={handleGoToShow}
                  className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2 bg-yellow-600 hover:bg-yellow-700 text-white text-xs sm:text-sm font-medium rounded-lg transition-colors"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <ExternalLink className="w-3 h-3" />
                  <span className="hidden sm:inline">{t('alerts.viewShow')}</span>
                  <span className="sm:hidden">{t('common.show')}</span>
                </motion.button>
                <div className="flex gap-1.5 sm:gap-2">
                  <motion.button
                    onClick={handleRemindLater}
                    className="flex-1 sm:flex-none flex items-center justify-center gap-1 px-2.5 py-1.5 sm:px-3 sm:py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs sm:text-sm font-medium rounded-lg transition-colors"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    title={t('common.remindLater')}
                  >
                    <Clock className="w-3 h-3" />
                    <span className="hidden sm:inline">{t('common.later')}</span>
                    <span className="sm:hidden">+{t('common.later')}</span>
                  </motion.button>
                  <motion.button
                    onClick={handleExplicitDismiss}
                    className="flex-1 sm:flex-none px-2.5 py-1.5 sm:px-3 sm:py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs sm:text-sm font-medium rounded-lg transition-colors"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    title={t('notifications.ignorePermanently')}
                  >
                    {t('common.ignore')}
                  </motion.button>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default NotificationToast;
