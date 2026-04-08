import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Bell, X, Trash2 } from 'lucide-react';
import { Notification } from '../types/Comment';
import * as apiNotificationService from '../services/apiNotificationService';
import { ApiNotification } from '../services/apiNotificationService';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';

interface NotificationsPopupProps {
  onClose: () => void;
  onNotificationUpdate?: () => void;
}

const NotificationsPopup: React.FC<NotificationsPopupProps> = ({ onClose, onNotificationUpdate }) => {
  const { t } = useTranslation();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [apiNotifications, setApiNotifications] = useState<ApiNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const popupRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchNotifications = async () => {
      setLoading(true);
      setCurrentPage(1);

      try {
        const { notifications: userNotifications, apiNotifications: apiNotifs, hasMore: more } = await apiNotificationService.getUserNotificationsWithApiData(1, 20);
        setNotifications(userNotifications);
        setApiNotifications(apiNotifs);
        setHasMore(more);
      } catch (error) {
        console.error('Error fetching notifications:', error);
      }

      setLoading(false);
    };

    fetchNotifications();

    // La fermeture lors du clic extérieur est gérée par le Header
    // Pas besoin de gérer ça ici pour éviter les conflits
  }, [onClose]);

  const loadMoreNotifications = useCallback(async () => {
    if (loadingMore || !hasMore) return;

    setLoadingMore(true);
    const nextPage = currentPage + 1;

    try {
      const { notifications: newNotifications, apiNotifications: newApiNotifs, hasMore: more } = await apiNotificationService.getUserNotificationsWithApiData(nextPage, 20);

      setNotifications(prev => [...prev, ...newNotifications]);
      setApiNotifications(prev => [...prev, ...newApiNotifs]);
      setHasMore(more);
      setCurrentPage(nextPage);
    } catch (error) {
      console.error('Error loading more notifications:', error);
    }

    setLoadingMore(false);
  }, [loadingMore, hasMore, currentPage]);

  // Gestion du scroll pour charger plus automatiquement
  useEffect(() => {
    const handleScroll = () => {
      if (!scrollRef.current || loadingMore || !hasMore) return;

      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      // Charger plus quand on est à 80% du scroll
      if (scrollTop + clientHeight >= scrollHeight * 0.8) {
        loadMoreNotifications();
      }
    };

    const scrollElement = scrollRef.current;
    if (scrollElement) {
      scrollElement.addEventListener('scroll', handleScroll);
      return () => scrollElement.removeEventListener('scroll', handleScroll);
    }
  }, [loadMoreNotifications, loadingMore, hasMore]);

  const handleMarkAsRead = async (notification: Notification) => {
    const success = await apiNotificationService.markNotificationAsRead(notification.id);

    if (success) {
      // Mettre à jour l'état local pour les deux listes
      setNotifications(prevNotifications =>
        prevNotifications.map(n =>
          n.id === notification.id ? { ...n, read: true } : n
        )
      );
      setApiNotifications(prevApiNotifications =>
        prevApiNotifications.map(n =>
          n.id.toString() === notification.id ? { ...n, is_read: 1 } : n
        )
      );
      // Mettre à jour le compteur dans le Header
      if (onNotificationUpdate) {
        onNotificationUpdate();
      }
    }
  };

  const handleMarkAllAsRead = async () => {
    const success = await apiNotificationService.markAllNotificationsAsRead();

    if (success) {
      // Mettre à jour l'état local pour les deux listes
      setNotifications(prevNotifications =>
        prevNotifications.map(n => ({ ...n, read: true }))
      );
      setApiNotifications(prevApiNotifications =>
        prevApiNotifications.map(n => ({ ...n, is_read: 1 }))
      );
      // Mettre à jour le compteur dans le Header
      if (onNotificationUpdate) {
        onNotificationUpdate();
      }
    }
  };

  const handleNavigateToContent = async (notification: Notification) => {
    const apiNotif = apiNotifications.find(n => n.id.toString() === notification.id);

    if (apiNotif?.notification_type.startsWith('report')) {
      await handleMarkAsRead(notification);
      return;
    }

    // Marquer comme lu
    await handleMarkAsRead(notification);

    // Récupérer les détails du contenu depuis la notification API
    const contentDetails = apiNotificationService.getContentDetailsFromNotification(apiNotif);

    if (contentDetails) {
      // Naviguer vers la page du film ou de la série
      const { contentId, contentType } = contentDetails;
      const path = contentType === 'movie' ? `/movie/${contentId}` : `/tv/${contentId}`;

      // Ne pas fermer la popup, laisser l'utilisateur continuer à interagir
      // La popup se fermera automatiquement lors de la navigation (via l'effet dans Header.tsx)

      // Naviguer vers la page du contenu
      navigate(path);
    }
  };

  const handleDeleteNotification = async (notification: Notification, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const success = await apiNotificationService.deleteNotification(notification.id);

    if (success) {
      // Mettre à jour l'état local en supprimant la notification des deux listes
      setNotifications(prevNotifications =>
        prevNotifications.filter(n => n.id !== notification.id)
      );
      setApiNotifications(prevApiNotifications =>
        prevApiNotifications.filter(n => n.id.toString() !== notification.id)
      );
      // Mettre à jour le compteur dans le Header (si la notification était non lue, le compteur diminue)
      if (onNotificationUpdate) {
        onNotificationUpdate();
      }
    }
  };

  const formatNotificationDate = (date: Date) => {
    // Formatage relatif: aujourd'hui, hier, ou date complète
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date >= today) {
      return `${t('notifications.today')} ${format(date, 'HH:mm', { locale: fr })}`;
    } else if (date >= yesterday) {
      return `${t('notifications.yesterday')} ${format(date, 'HH:mm', { locale: fr })}`;
    } else {
      return format(date, 'dd/MM/yyyy HH:mm', { locale: fr });
    }
  };

  const getNotificationMessage = (notification: Notification) => {
    switch (notification.type) {
      case 'reply':
        return (
          <span>
            <span className="font-semibold">{notification.fromUsername}</span> {t('notifications.repliedToComment')}: <span className="italic text-sm text-gray-300">"{notification.content}"</span>
          </span>
        );
      case 'like':
      case 'reaction':
        return (
          <span>
            <span className="font-semibold">{notification.fromUsername}</span> {t('notifications.likedComment')}
          </span>
        );
      case 'mention':
        return (
          <span>
            <span className="font-semibold">{notification.fromUsername}</span> {t('notifications.mentionedYou')}
          </span>
        );
      case 'report_resolved_deleted':
        return (
          <span>
            <span className="font-semibold">{notification.fromUsername}</span> {t('notifications.reportResolvedWithDeletion')}
          </span>
        );
      case 'report_resolved':
        return (
          <span>
            <span className="font-semibold">{notification.fromUsername}</span> {t('notifications.reportResolved')}
          </span>
        );
      case 'report_dismissed':
        return (
          <span>
            <span className="font-semibold">{notification.fromUsername}</span> {t('notifications.reportDismissed')}
          </span>
        );
      default:
        return (
          <span>{t('notifications.newNotification')}</span>
        );
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      ref={popupRef}
      data-notifications-popup
      onClick={(e) => e.stopPropagation()}
      className="w-[calc(100vw-2rem)] sm:w-80 md:w-96 bg-gray-900 shadow-lg rounded-md border border-gray-700 max-h-[70vh] overflow-hidden z-50"
    >
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h3 className="text-lg font-semibold">{t('notifications.title')}</h3>
        <div className="flex gap-2">
          {notifications.some(n => !n.read) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleMarkAllAsRead();
              }}
              className="text-xs px-2 py-1.5 bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              {t('notifications.markAllRead')}
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors p-1"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="overflow-y-auto max-h-[60vh]">
        {loading ? (
          <div className="flex justify-center items-center py-8">
            <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"></div>
          </div>
        ) : notifications.length > 0 ? (
          <ul className="divide-y divide-gray-800">
            {notifications.map(notification => (
              <li
                key={notification.id}
                className={`p-4 hover:bg-gray-800 transition-colors ${!notification.read ? 'bg-gray-800/50' : ''}`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start gap-3">
                  {/* Badge de notification non lue */}
                  <div className={`w-2 h-2 rounded-full shrink-0 mt-2 ${!notification.read ? 'bg-blue-500' : 'bg-gray-600'}`}></div>

                  {/* Avatar de l'utilisateur */}
                  <div className="flex-shrink-0">
                    {notification.fromAvatar ? (
                      <img
                        src={notification.fromAvatar}
                        alt={notification.fromUsername}
                        className="w-10 h-10 rounded-full object-cover"
                        onError={(e) => {
                          // Fallback si l'image ne charge pas
                          const target = e.target as HTMLImageElement;
                          target.style.display = 'none';
                          const fallback = target.nextElementSibling as HTMLElement;
                          if (fallback) {
                            fallback.style.display = 'flex';
                          }
                        }}
                      />
                    ) : null}
                    <div className={`w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-white font-semibold text-sm ${notification.fromAvatar ? 'hidden' : 'flex'}`}>
                      {notification.fromUsername.charAt(0).toUpperCase()}
                    </div>
                  </div>

                  {/* Contenu de la notification */}
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNavigateToContent(notification);
                    }}
                  >
                    <p className="text-sm sm:text-base">{getNotificationMessage(notification)}</p>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-xs text-gray-400">{formatNotificationDate(notification.createdAt)}</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 shrink-0">
                    {!notification.read && (
                      <button
                        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                          e.stopPropagation();
                          handleMarkAsRead(notification);
                        }}
                        className="shrink-0 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                      >
                        {t('notifications.read')}
                      </button>
                    )}
                    <button
                      onClick={(e) => handleDeleteNotification(notification, e)}
                      className="shrink-0 px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors flex items-center justify-center"
                      title={t('notifications.deleteNotification')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {/* Bouton ou indicateur de chargement pour plus de notifications */}
        {!loading && notifications.length > 0 && (
          <div className="p-4 border-t border-gray-800">
            {hasMore ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  loadMoreNotifications();
                }}
                disabled={loadingMore}
                className="w-full py-2 px-4 bg-gray-800 hover:bg-gray-700 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
              >
                {loadingMore ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-gray-500 border-t-white rounded-full animate-spin"></div>
                    {t('common.loading')}
                  </span>
                ) : (
                  t('notifications.loadMore')
                )}
              </button>
            ) : notifications.length >= 20 && (
              <p className="text-center text-xs text-gray-500">{t('notifications.allLoaded')}</p>
            )}
          </div>
        )}

        {!loading && notifications.length === 0 && (
          <div className="py-8 text-center text-gray-400">
            <Bell size={32} className="mx-auto mb-2 opacity-20" />
            <p>{t('notifications.noNotifications')}</p>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default NotificationsPopup;

// Component to use in the header
export const NotificationBell: React.FC = () => {
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const fetchUnreadCount = async () => {
      const userId = getCurrentUserId();
      if (userId) {
        const count = await getUnreadNotificationsCount(userId);
        setUnreadCount(count);
      }
    };

    fetchUnreadCount();

    // Mettre à jour le compteur toutes les 30 secondes
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const getCurrentUserId = (): string | null => {
    const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
    const isGoogleAuth = localStorage.getItem('google_auth') === 'true';
    const authStr = localStorage.getItem('auth');
    let isVipAuth = false;
    let vipUser = null;
    if (authStr) {
      try {
        const authObj = JSON.parse(authStr);
        if (authObj.userProfile && authObj.userProfile.provider === 'access_code') {
          isVipAuth = true;
          vipUser = authObj.userProfile;
        }
      } catch { }
    }
    if (isDiscordAuth) {
      const discordUser = JSON.parse(localStorage.getItem('discord_user') || '{}');
      return discordUser.id || null;
    } else if (isGoogleAuth) {
      const googleUser = JSON.parse(localStorage.getItem('google_user') || '{}');
      return googleUser.id || null;
    } else if (isVipAuth && vipUser) {
      return vipUser.id || 'vip_user';
    }
    return null;
  };

  // N'afficher que si l'utilisateur est connecté (Discord, Google ou VIP)
  const isAuthenticated =
    localStorage.getItem('discord_auth') === 'true' ||
    localStorage.getItem('google_auth') === 'true' ||
    (() => {
      const authStr = localStorage.getItem('auth');
      if (authStr) {
        try {
          const authObj = JSON.parse(authStr);
          return authObj.userProfile && authObj.userProfile.provider === 'access_code';
        } catch { }
      }
      return false;
    })();

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div
      className="text-white hover:text-gray-300 transition-colors duration-300 relative cursor-pointer"
      onClick={() => setIsOpen(!isOpen)}
    >
      <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }}>
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-4 min-w-4 flex items-center justify-center px-1">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </motion.div>

      <AnimatePresence>
        {isOpen && (
          <NotificationsPopup onClose={() => setIsOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}; 