import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getComments, addComment } from '../services/commentService';
import { Comment, COMMENT_LENGTH_LIMITS } from '../types/Comment';
import CommentItem from './CommentItem';
import { Send, Clock } from 'lucide-react';
import EmojiPicker from './EmojiPicker';
import AdminLogin from './AdminLogin';
import { isUserVip } from '../utils/authUtils';

interface CommentSectionProps {
  contentId: string;
  contentType: 'movie' | 'series';
}

const MAX_COMMENT_LENGTH = COMMENT_LENGTH_LIMITS.COMMENT;
const COOLDOWN_TIME = 30; // Cooldown en secondes

const CommentSection: React.FC<CommentSectionProps> = ({ contentId, contentType }) => {
  const { t } = useTranslation();
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [isLoadingAddComment, setIsLoadingAddComment] = useState(false);

  // Fonction pour vérifier l'authentification - memoized pour éviter les recalculs inutiles
  const checkAuthStatus = useCallback(() => {
    const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
    const isGoogleAuth = localStorage.getItem('google_auth') === 'true';
    const isVipUser = isUserVip();
    const isBip39Auth = localStorage.getItem('bip39_auth') === 'true';

    // VIP via access_code
    let isVipAuth = false;
    let vipUser = null;
    // BIP39 authentication
    let isBip39User = false;
    let bip39User = null;

    const authStr = localStorage.getItem('auth');
    if (authStr) {
      try {
        const authObj = JSON.parse(authStr);
        if (authObj && authObj.userProfile) {
          if (authObj.userProfile.provider === 'access_code') {
            isVipAuth = true;
            vipUser = authObj.userProfile;
          } else if (authObj.userProfile.provider === 'bip39') {
            isBip39User = true;
            bip39User = authObj.userProfile;
          }
        }
      } catch (error) {
        console.error('Error parsing auth data:', error);
      }
    }

    setIsAuthenticated(isDiscordAuth || isGoogleAuth || isVipAuth || isVipUser || isBip39Auth || isBip39User);

    // Prioritize Discord, then Google, then BIP39, then VIP for user identity
    if (isDiscordAuth) {
      try {
        const userInfoStr = localStorage.getItem('discord_user');
        if (userInfoStr) {
          const userInfo = JSON.parse(userInfoStr);
          setCurrentUserId(userInfo?.id || 'discord_user');
        }
      } catch (error) {
        console.error('Error parsing Discord user data:', error);
      }
    } else if (isGoogleAuth) {
      try {
        const userInfoStr = localStorage.getItem('google_user');
        if (userInfoStr) {
          const userInfo = JSON.parse(userInfoStr);
          setCurrentUserId(userInfo?.id || 'google_user');
        }
      } catch (error) {
        console.error('Error parsing Google user data:', error);
      }
    } else if (isBip39Auth || (isBip39User && bip39User)) {
      setCurrentUserId(bip39User?.id || 'bip39_user');
    } else if (isVipAuth && vipUser) {
      setCurrentUserId(vipUser.id || 'vip_user');
    } else if (isVipUser) {
      // Fallback for VIP without specific auth
      const guestId = localStorage.getItem('guest_uuid') || 'anonymous_vip';
      setCurrentUserId(guestId);
    }
  }, []);

  // Chargement initial des commentaires
  useEffect(() => {
    const fetchInitialData = async () => {
      setLoading(true);
      try {
        const fetchedComments = await getComments(contentId, contentType);
        setComments(fetchedComments);
      } catch (error) {
        console.error('Error loading comments:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchInitialData();
    checkAuthStatus();
  }, [contentId, contentType, checkAuthStatus]);

  // Gérer le cooldown
  useEffect(() => {
    if (cooldownRemaining <= 0) return;
    
    const timer = setInterval(() => {
      setCooldownRemaining(prev => Math.max(0, prev - 1));
    }, 1000);
    
    return () => clearInterval(timer);
  }, [cooldownRemaining]);

  // Charge les commentaires de manière optimisée
  const refreshComments = useCallback(async () => {
    try {
      const fetchedComments = await getComments(contentId, contentType);
      setComments(fetchedComments);
    } catch (error) {
      console.error('Error refreshing comments:', error);
    }
  }, [contentId, contentType]);

  const startCooldown = () => {
    // Les admins n'ont pas de cooldown
    if (isAdmin) return;
    
    setCooldownRemaining(COOLDOWN_TIME);
    localStorage.setItem('lastCommentTime', Date.now().toString());
  };

  // Vérification du cooldown au chargement
  useEffect(() => {
    const lastCommentTime = localStorage.getItem('lastCommentTime');
    if (lastCommentTime && !isAdmin) {
      const timeElapsed = Math.floor((Date.now() - parseInt(lastCommentTime)) / 1000);
      const remainingTime = COOLDOWN_TIME - timeElapsed;
      if (remainingTime > 0) {
        setCooldownRemaining(remainingTime);
      }
    }
  }, [isAdmin]);

  const handleAdminStatusChange = (status: boolean) => {
    setIsAdmin(status);
    // Si l'utilisateur est devenu admin, on annule le cooldown
    if (status) {
      setCooldownRemaining(0);
    }
  };

  const handleAddComment = async () => {
    if (!isAuthenticated || !newComment.trim() || (cooldownRemaining > 0 && !isAdmin) || isLoadingAddComment) return;

    try {
      setIsLoadingAddComment(true);
      
      // Get user details from localStorage
      let username = t('comments.defaultUser');
      let userAvatar = 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
      let userId = currentUserId || 'anonymous_user';
      
      const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
      const isGoogleAuth = localStorage.getItem('google_auth') === 'true';
      const isVipUser = isUserVip();
      const isBip39Auth = localStorage.getItem('bip39_auth') === 'true';

      // VIP via access_code and BIP39 authentication
      let isVipAuth = false;
      let vipUser = null;
      let isBip39User = false;
      let bip39User = null;

      const authStr = localStorage.getItem('auth');
      if (authStr) {
        try {
          const authObj = JSON.parse(authStr);
          if (authObj && authObj.userProfile) {
            if (authObj.userProfile.provider === 'access_code') {
              isVipAuth = true;
              vipUser = authObj.userProfile;
            } else if (authObj.userProfile.provider === 'bip39') {
              isBip39User = true;
              bip39User = authObj.userProfile;
            }
          }
        } catch (error) {
          console.error('Error parsing auth data:', error);
        }
      }
      
      if (isDiscordAuth) {
        try {
          const userInfoStr = localStorage.getItem('discord_user');
          if (userInfoStr) {
            const userInfo = JSON.parse(userInfoStr);
            if (userInfo) {
              username = userInfo.username || 'Discord User';
              userAvatar = (typeof userInfo.avatar === 'string' && userInfo.avatar.trim() !== '') ? userInfo.avatar : userAvatar;
              userId = userInfo.id || userId;
            }
          }
        } catch (error) {
          console.error('Error parsing Discord user data:', error);
        }
      } else if (isGoogleAuth) {
        try {
          const userInfoStr = localStorage.getItem('google_user');
          if (userInfoStr) {
            const userInfo = JSON.parse(userInfoStr);
            if (userInfo) {
              username = userInfo.name || 'Google User';
              userAvatar = (typeof userInfo.picture === 'string' && userInfo.picture.trim() !== '') ? userInfo.picture : userAvatar;
              userId = userInfo.id || userId;
            }
          }
        } catch (error) {
          console.error('Error parsing Google user data:', error);
        }
      } else if (isBip39Auth || (isBip39User && bip39User)) {
        username = bip39User?.username || t('comments.defaultUserBip39');
        userAvatar = (typeof bip39User?.avatar === 'string' && bip39User.avatar.trim() !== '') ? bip39User.avatar : userAvatar;
        userId = bip39User?.id || 'bip39_user';
      } else if (isVipAuth && vipUser) {
        username = vipUser.username || 'VIP User';
        userAvatar = (typeof vipUser.avatar === 'string' && vipUser.avatar.trim() !== '') ? vipUser.avatar : userAvatar;
        userId = vipUser.id || 'vip_user';
      } else if (isVipUser) {
        username = 'VIP User';
        userId = localStorage.getItem('guest_uuid') || 'anonymous_vip';
      }

      // Ajouter le commentaire
      const commentId = await addComment(
        contentId,
        contentType,
        userId,
        username,
        userAvatar,
        newComment,
        undefined, // parentId
        isAdmin // Indiquer si l'utilisateur est admin
      );

      // Démarrer le cooldown si pas admin
      startCooldown();
      
      // Ajouter optimistiquement le commentaire au state sans recharger
      const newCommentObject: Comment = {
        id: commentId,
        contentId,
        contentType,
        userId,
        username,
        userAvatar,
        content: newComment,
        createdAt: new Date(),
        likes: 0,
        likedBy: [],
        dislikes: 0,
        dislikedBy: [],
        reactions: [],
        replies: [],
        isAdmin: isAdmin
      };
      
      setComments(prev => [newCommentObject, ...prev]);
      setNewComment('');
    } catch (error) {
      console.error('Error adding comment:', error);
      // Si erreur, on recharge tous les commentaires
      refreshComments();
    } finally {
      setIsLoadingAddComment(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
  };

  const handleEmojiInsert = (emoji: string) => {
    setNewComment(prev => {
      if (prev.length + emoji.length <= MAX_COMMENT_LENGTH) {
        return prev + emoji;
      }
      return prev;
    });
  };

  // Formatter le temps restant
  const formatCooldownTime = (seconds: number) => {
    if (seconds < 60) {
      return `${seconds} ${t('time.seconds', { count: seconds })}`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
  };

  return (
    <div className="bg-gray-900 p-4 rounded-lg mt-8">
      <div className="flex flex-wrap justify-between items-center mb-4">
        <h2 className="text-xl font-bold mb-2 sm:mb-0">{t('comments.title')}</h2>
        <AdminLogin onAdminStatusChange={handleAdminStatusChange} />
      </div>
      
      {isAuthenticated ? (
        <div className="mb-6 flex items-start space-x-3">
          <img 
            src={(() => {
              if (localStorage.getItem('discord_auth') === 'true') {
                const userInfo = JSON.parse(localStorage.getItem('discord_user') || '{}');
                return userInfo.avatar || 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
              } else if (localStorage.getItem('google_auth') === 'true') {
                const userInfo = JSON.parse(localStorage.getItem('google_user') || '{}');
                return userInfo.picture || 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
              } else {
                // VIP via access_code
                const authStr = localStorage.getItem('auth');
                if (authStr) {
                  try {
                    const authObj = JSON.parse(authStr);
                    if (authObj.userProfile && authObj.userProfile.provider === 'access_code') {
                      return authObj.userProfile.avatar || 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
                    }
                  } catch {}
                }
              }
              return 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
            })()} 
            alt={t('common.avatar')}
            className="w-10 h-10 rounded-full object-cover"
          />
          <div className="flex-1">
            <div className="relative flex bg-gray-800 rounded-lg">
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={cooldownRemaining > 0 && !isAdmin ? t('comments.cooldownMessage', { time: formatCooldownTime(cooldownRemaining) }) : t('comments.addComment')}
                disabled={cooldownRemaining > 0 && !isAdmin}
                className={`w-full bg-gray-800 text-white p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none min-h-[80px] ${cooldownRemaining > 0 && !isAdmin ? 'opacity-70 cursor-not-allowed' : ''}`}
                maxLength={MAX_COMMENT_LENGTH}
              />
              <div className="absolute right-2 bottom-2 flex items-center space-x-2">
                <EmojiPicker onEmojiSelect={handleEmojiInsert} />
              </div>
            </div>
            <div className="flex justify-between mt-2">
              {cooldownRemaining > 0 && !isAdmin && (
                <div className="flex items-center text-yellow-500 text-sm">
                  <Clock size={16} className="mr-1" />
                  <span>{t('comments.waitLabel')} {formatCooldownTime(cooldownRemaining)}</span>
                </div>
              )}
              
              <div className="flex items-center space-x-2 ml-auto">
                <span className={`text-xs ${newComment.length >= MAX_COMMENT_LENGTH ? 'text-red-500' : 'text-gray-400'}`}>
                  {newComment.length}/{MAX_COMMENT_LENGTH}
                </span>
                <button
                  onClick={handleAddComment}
                  disabled={cooldownRemaining > 0 && !isAdmin || !newComment.trim() || isLoadingAddComment}
                  className={`bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center space-x-1 ${
                    (cooldownRemaining > 0 && !isAdmin) || !newComment.trim() || isLoadingAddComment ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700'
                  }`}
                >
                  <Send size={16} />
                  <span>{t('comments.comment')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-6 p-4 bg-gray-800 rounded-lg text-center">
          <p className="text-gray-300">{t('comments.loginToComment')}</p>
        </div>
      )}
      
      {loading ? (
        <div className="flex justify-center items-center py-6">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
        </div>
      ) : comments.length > 0 ? (
        <div>
          {comments.map(comment => (
            <CommentItem
              key={comment.id}
              comment={comment}
              currentUserId={currentUserId}
              contentId={contentId}
              contentType={contentType}
              refreshComments={refreshComments}
              isAdmin={isAdmin}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-6 text-gray-400">
          <p>{t('comments.noComments')}</p>
        </div>
      )}
    </div>
  );
};

export default CommentSection; 
