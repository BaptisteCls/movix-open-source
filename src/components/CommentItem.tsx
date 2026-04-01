import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Comment, COMMENT_LENGTH_LIMITS } from '../types/Comment';
import { ThumbsUp, ThumbsDown, Reply, Trash2, Send, Clock } from 'lucide-react';
import { likeComment, dislikeComment, deleteComment, addComment, reactWithEmoji } from '../services/commentService';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import EmojiPicker from './EmojiPicker';
import ReactionBar from './ReactionBar';
import { addReplyNotification } from '../services/notificationService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkEmoji from 'remark-emoji';
import MarkdownToolbar from './MarkdownToolbar';

// Définition de la limite de caractères pour les réponses
const MAX_REPLY_LENGTH = COMMENT_LENGTH_LIMITS.REPLY;

const markdownComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  strong: ({ children }: any) => <strong className="font-bold text-white">{children}</strong>,
  em: ({ children }: any) => <em className="italic">{children}</em>,
  code: ({ children, className }: any) => {
    const isBlock = className?.includes('language-');
    return isBlock ? (
      <pre className="bg-gray-900/50 rounded p-2 my-1 overflow-x-auto text-xs">
        <code className={className}>{children}</code>
      </pre>
    ) : (
      <code className="bg-gray-900/50 text-blue-300 px-1 py-0.5 rounded text-[0.85em]">{children}</code>
    );
  },
  pre: ({ children }: any) => <>{children}</>,
  a: ({ href, children }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline break-all">
      {children}
    </a>
  ),
  ul: ({ children }: any) => <ul className="list-disc list-inside ml-2 my-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal list-inside ml-2 my-1">{children}</ol>,
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-gray-500 pl-2 my-1 text-gray-400 italic">{children}</blockquote>
  ),
  del: ({ children }: any) => <del className="line-through text-gray-500">{children}</del>,
  // Bloquer les images et headings dans les commentaires
  img: () => null,
  h1: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h2: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h3: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h4: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h5: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
  h6: ({ children }: any) => <p className="font-bold text-white mb-1">{children}</p>,
};

const remarkPlugins = [remarkGfm, remarkEmoji];
const REPLY_COOLDOWN_TIME = 15; // Cooldown plus court pour les réponses (15 secondes)

interface CommentItemProps {
  comment: Comment;
  currentUserId: string | null;
  contentId: string;
  contentType: 'movie' | 'series';
  refreshComments: () => void;
  isAdmin?: boolean;
}

const CommentItem: React.FC<CommentItemProps> = ({ 
  comment, 
  currentUserId, 
  contentId, 
  contentType, 
  refreshComments,
  isAdmin = false
}) => {
  const { t } = useTranslation();
  const [isReplying, setIsReplying] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [likeAnimation, setLikeAnimation] = useState(false);
  const [dislikeAnimation, setDislikeAnimation] = useState(false);
  const [replyCooldown, setReplyCooldown] = useState(0);
  const [isLoadingReply, setIsLoadingReply] = useState(false);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Gérer le cooldown des réponses
  useEffect(() => {
    if (replyCooldown <= 0) return;
    
    const timer = setInterval(() => {
      setReplyCooldown(prev => Math.max(0, prev - 1));
    }, 1000);
    
    return () => clearInterval(timer);
  }, [replyCooldown]);

  // Vérification du cooldown au chargement
  useEffect(() => {
    const lastReplyTime = localStorage.getItem('lastReplyTime');
    if (lastReplyTime && !isAdmin) {
      const timeElapsed = Math.floor((Date.now() - parseInt(lastReplyTime)) / 1000);
      const remainingTime = REPLY_COOLDOWN_TIME - timeElapsed;
      if (remainingTime > 0) {
        setReplyCooldown(remainingTime);
      }
    }
  }, [isAdmin]);

  const startReplyCooldown = () => {
    // Les admins n'ont pas de cooldown
    if (isAdmin) return;
    
    setReplyCooldown(REPLY_COOLDOWN_TIME);
    localStorage.setItem('lastReplyTime', Date.now().toString());
  };

  const handleLike = async () => {
    if (!currentUserId) return;
    
    try {
      // Animation effect
      setLikeAnimation(true);
      setTimeout(() => setLikeAnimation(false), 500);
      
      await likeComment(comment.id, currentUserId);
      refreshComments();
    } catch (error) {
      console.error('Error liking comment:', error);
    }
  };

  const handleDislike = async () => {
    if (!currentUserId) return;
    
    try {
      // Animation effect
      setDislikeAnimation(true);
      setTimeout(() => setDislikeAnimation(false), 500);
      
      await dislikeComment(comment.id, currentUserId);
      refreshComments();
    } catch (error) {
      console.error('Error disliking comment:', error);
    }
  };

  const handleDelete = async () => {
    if (window.confirm(t('comments.deleteConfirm'))) {
      try {
        await deleteComment(comment.id, currentUserId || undefined, isAdmin);
        refreshComments();
      } catch (error) {
        console.error('Error deleting comment:', error);
      }
    }
  };

  const handleReply = async () => {
    if (!currentUserId || !replyContent.trim() || (replyCooldown > 0 && !isAdmin) || isLoadingReply) return;

    try {
      setIsLoadingReply(true);
      
      // Get user details from localStorage
      let username = t('comments.defaultUser');
      let userAvatar = 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp';
      
      const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
      const isGoogleAuth = localStorage.getItem('google_auth') === 'true';
      
      if (isDiscordAuth) {
        const userInfoStr = localStorage.getItem('discord_user');
        if (userInfoStr) {
          const userInfo = JSON.parse(userInfoStr);
          username = userInfo.username;
          userAvatar = userInfo.avatar;
        }
      } else if (isGoogleAuth) {
        const userInfoStr = localStorage.getItem('google_user');
        if (userInfoStr) {
          const userInfo = JSON.parse(userInfoStr);
          username = userInfo.name;
          userAvatar = userInfo.picture;
        }
      }

      // Ajouter le commentaire
      const replyId = await addComment(
        contentId,
        contentType,
        currentUserId,
        username,
        userAvatar,
        replyContent,
        comment.id,
        isAdmin // Transmettre le statut admin
      );

      // Démarrer le cooldown pour les réponses si pas admin
      startReplyCooldown();
      
      setReplyContent('');
      setIsReplying(false);
      
      // Mettre à jour les commentaires
      refreshComments();

      // Ajouter une notification
      await addReplyNotification(
        comment.id,
        replyId,
        replyContent,
        currentUserId,
        username
      );
    } catch (error) {
      console.error('Error adding reply:', error);
    } finally {
      setIsLoadingReply(false);
    }
  };

  const handleEmojiInsert = (emoji: string) => {
    setReplyContent(prev => {
      if (prev.length + emoji.length <= MAX_REPLY_LENGTH) {
        return prev + emoji;
      }
      return prev;
    });
  };

  const handleReaction = async (emoji: string) => {
    if (!currentUserId) return;
    
    try {
      await reactWithEmoji(comment.id, emoji, currentUserId);
      refreshComments();
    } catch (error) {
      console.error('Error reacting to comment:', error);
    }
  };

  const formatDate = (date: Date) => {
    try {
      // Format différent pour les petits écrans (détecté via CSS media query)
      const isMobile = window.innerWidth < 640;
      if (isMobile) {
        return format(date, 'dd/MM/yy HH:mm', { locale: fr });
      }
      return format(date, 'dd MMMM yyyy à HH:mm', { locale: fr });
    } catch (error) {
      return t('comments.unknownDate');
    }
  };

  const formatCooldownTime = (seconds: number) => {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
  };

  const isLikedByCurrentUser = currentUserId && comment.likedBy && comment.likedBy.includes(currentUserId);
  const isDislikedByCurrentUser = currentUserId && comment.dislikedBy && comment.dislikedBy.includes(currentUserId);
  // Un utilisateur peut supprimer son propre commentaire ou si c'est un admin
  const canDeleteComment = (currentUserId && currentUserId === comment.userId) || isAdmin;

  return (
    <div className="bg-gray-800 p-4 rounded-lg mb-3">
      <div className="flex items-start space-x-3">
        <img 
          src={comment.userAvatar || 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp'} 
          alt={comment.username}
          className="w-10 h-10 rounded-full object-cover shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between flex-wrap">
            <div className="flex items-center">
              <h3 className="font-medium text-white mr-2">{comment.username}</h3>
              {comment.isAdmin && (
                <span className="bg-red-600 text-white text-xs px-2 py-0.5 rounded-full mr-2 font-medium">
                  ADMIN
                </span>
              )}
            </div>
            <span className="text-xs text-gray-400">{formatDate(comment.createdAt)}</span>
          </div>
          <div className="mt-1 text-gray-300 break-words max-w-full overflow-hidden text-sm sm:text-base overflow-x-hidden prose-invert">
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
              {comment.content}
            </ReactMarkdown>
          </div>
          
          <ReactionBar 
            reactions={comment.reactions || []} 
            onReactionClick={handleReaction}
            currentUserId={currentUserId}
          />
          
          <div className="flex items-center mt-3 space-x-2 sm:space-x-4 flex-wrap">
            <button 
              onClick={handleLike}
              className={`flex items-center transition-all duration-300 ${
                isLikedByCurrentUser 
                  ? 'text-blue-500' 
                  : 'text-gray-400 hover:text-blue-500'
              } ${likeAnimation ? 'animate-like' : ''} text-xs sm:text-sm`}
            >
              <ThumbsUp 
                size={16} 
                className={`mr-1 transform transition-transform duration-300 ${likeAnimation ? 'scale-150' : ''} ${isLikedByCurrentUser ? 'fill-current' : ''}`} 
              />
              <span className={`${likeAnimation ? 'animate-bounce' : ''}`}>{comment.likes}</span>
            </button>
            
            <button 
              onClick={handleDislike}
              className={`flex items-center transition-all duration-300 ${
                isDislikedByCurrentUser 
                  ? 'text-red-500' 
                  : 'text-gray-400 hover:text-red-500'
              } ${dislikeAnimation ? 'animate-dislike' : ''} text-xs sm:text-sm`}
            >
              <ThumbsDown 
                size={16} 
                className={`mr-1 transform transition-transform duration-300 ${dislikeAnimation ? 'scale-150' : ''} ${isDislikedByCurrentUser ? 'fill-current' : ''}`} 
              />
              <span className={`${dislikeAnimation ? 'animate-bounce' : ''}`}>{comment.dislikes || 0}</span>
            </button>
            
            {currentUserId && (
              <button 
                onClick={() => setIsReplying(!isReplying)}
                disabled={replyCooldown > 0}
                className={`flex items-center text-gray-400 hover:text-blue-500 transition hover:scale-105 ${replyCooldown > 0 ? 'opacity-50 cursor-not-allowed' : ''} text-xs sm:text-sm`}
              >
                <Reply size={16} className="mr-1" />
                <span>{replyCooldown > 0 ? `(${formatCooldownTime(replyCooldown)})` : t('comments.reply')}</span>
              </button>
            )}
            
            {canDeleteComment && (
              <button 
                onClick={handleDelete}
                className="flex items-center text-gray-400 hover:text-red-500 transition hover:scale-105 text-xs sm:text-sm"
              >
                <Trash2 size={16} className="mr-1" />
                <span>{t('common.delete')}</span>
              </button>
            )}
          </div>
          
          {isReplying && (
            <div className="mt-3 ml-10">
              <div className="relative bg-gray-700 rounded-lg">
                <textarea
                  ref={replyTextareaRef}
                  value={replyContent}
                  onChange={(e) => setReplyContent(e.target.value)}
                  placeholder={replyCooldown > 0 && !isAdmin ? t('comments.replyCooldownMessage', { time: formatCooldownTime(replyCooldown) }) : t('comments.writeReply')}
                  disabled={replyCooldown > 0 && !isAdmin}
                  className={`w-full bg-gray-700 text-white p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none min-h-[80px] ${replyCooldown > 0 && !isAdmin ? 'opacity-70 cursor-not-allowed' : ''}`}
                  maxLength={MAX_REPLY_LENGTH}
                />
                <div className="absolute right-2 bottom-2 flex items-center space-x-2">
                  <EmojiPicker onEmojiSelect={handleEmojiInsert} />
                </div>
              </div>
              <MarkdownToolbar
                textareaRef={replyTextareaRef}
                value={replyContent}
                onChange={setReplyContent}
                maxLength={MAX_REPLY_LENGTH}
              />
              <div className="flex justify-between mt-2">
                {replyCooldown > 0 && !isAdmin && (
                  <div className="flex items-center text-yellow-500 text-sm">
                    <Clock size={14} className="mr-1" />
                    <span>{t('comments.waitLabel')} {formatCooldownTime(replyCooldown)}</span>
                  </div>
                )}
                <div className="flex items-center space-x-2 ml-auto">
                  <span className={`text-xs ${replyContent.length >= MAX_REPLY_LENGTH ? 'text-red-500' : 'text-gray-400'}`}>
                    {replyContent.length}/{MAX_REPLY_LENGTH}
                  </span>
                  <button
                    onClick={handleReply}
                    disabled={replyCooldown > 0 && !isAdmin || !replyContent.trim() || isLoadingReply}
                    className={`bg-blue-600 text-white px-3 py-1.5 rounded-lg flex items-center space-x-1 text-sm ${
                      (replyCooldown > 0 && !isAdmin) || !replyContent.trim() || isLoadingReply ? 'opacity-50 cursor-not-allowed' : 'hover:bg-blue-700'
                    }`}
                  >
                    <Send size={14} />
                    <span>{t('comments.reply')}</span>
                  </button>
                  <button
                    onClick={() => setIsReplying(false)}
                    className="bg-gray-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-gray-700"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            </div>
          )}
          
          {comment.replies && comment.replies.length > 0 && (
            <div className="mt-4">
              {!isExpanded && (
                <button 
                  onClick={() => setIsExpanded(true)}
                  className="text-blue-500 text-sm hover:underline"
                >
                  {t('comments.viewReplies', { count: comment.replies.length })}
                </button>
              )}
              
              {isExpanded && (
                <>
                  <button 
                    onClick={() => setIsExpanded(false)}
                    className="text-blue-500 text-sm mb-2 hover:underline"
                  >
                    {t('comments.hideReplies')}
                  </button>
                  <div className="pl-4 border-l-2 border-gray-700">
                    {comment.replies.map(reply => {
                      const isReplyLikedByCurrentUser = currentUserId && reply.likedBy && reply.likedBy.includes(currentUserId);
                      const isReplyDislikedByCurrentUser = currentUserId && reply.dislikedBy && reply.dislikedBy.includes(currentUserId);
                      
                      return (
                        <div key={reply.id} className="mt-3">
                          <div className="flex items-start space-x-3">
                            <img 
                              src={reply.userAvatar || 'https://as2.ftcdn.net/v2/jpg/05/89/93/27/1000_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.webp'} 
                              alt={reply.username}
                              className="w-8 h-8 rounded-full object-cover shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between flex-wrap">
                                <div className="flex items-center">
                                  <h3 className="font-medium text-white text-sm mr-2">{reply.username}</h3>
                                  {reply.isAdmin && (
                                    <span className="bg-red-600 text-white text-xs px-1.5 py-0.5 rounded-full mr-2 font-medium text-[10px]">
                                      ADMIN
                                    </span>
                                  )}
                                </div>
                                <span className="text-xs text-gray-400 inline-block">{formatDate(reply.createdAt)}</span>
                              </div>
                              <div className="mt-1 text-gray-300 break-words max-w-full overflow-hidden text-xs sm:text-sm overflow-x-hidden prose-invert">
                                <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                                  {reply.content}
                                </ReactMarkdown>
                              </div>
                              
                              <ReactionBar 
                                reactions={reply.reactions || []}
                                onReactionClick={async (emoji) => {
                                  if (!currentUserId) return;
                                  await reactWithEmoji(reply.id, emoji, currentUserId);
                                  refreshComments();
                                }}
                                currentUserId={currentUserId}
                              />
                              
                              <div className="flex items-center mt-2 space-x-2 sm:space-x-4 flex-wrap">
                                <button 
                                  onClick={async () => {
                                    if (!currentUserId) return;
                                    
                                    // Animation for replies
                                    const button = document.getElementById(`like-${reply.id}`);
                                    if (button) {
                                      button.classList.add('scale-150');
                                      setTimeout(() => button.classList.remove('scale-150'), 300);
                                    }
                                    
                                    await likeComment(reply.id, currentUserId);
                                    refreshComments();
                                  }}
                                  className={`flex items-center transition-all duration-300 ${
                                    isReplyLikedByCurrentUser 
                                      ? 'text-blue-500' 
                                      : 'text-gray-400 hover:text-blue-500'
                                  } transition text-xs`}
                                >
                                  <ThumbsUp 
                                    id={`like-${reply.id}`}
                                    size={14} 
                                    className={`mr-1 transform transition-transform duration-300 ${isReplyLikedByCurrentUser ? 'fill-current' : ''}`} 
                                  />
                                  <span>{reply.likes}</span>
                                </button>
                                
                                <button 
                                  onClick={async () => {
                                    if (!currentUserId) return;
                                    
                                    // Animation for replies
                                    const button = document.getElementById(`dislike-${reply.id}`);
                                    if (button) {
                                      button.classList.add('scale-150');
                                      setTimeout(() => button.classList.remove('scale-150'), 300);
                                    }
                                    
                                    await dislikeComment(reply.id, currentUserId);
                                    refreshComments();
                                  }}
                                  className={`flex items-center transition-all duration-300 ${
                                    isReplyDislikedByCurrentUser 
                                      ? 'text-red-500' 
                                      : 'text-gray-400 hover:text-red-500'
                                  } transition text-xs`}
                                >
                                  <ThumbsDown 
                                    id={`dislike-${reply.id}`}
                                    size={14} 
                                    className={`mr-1 transform transition-transform duration-300 ${isReplyDislikedByCurrentUser ? 'fill-current' : ''}`} 
                                  />
                                  <span>{reply.dislikes || 0}</span>
                                </button>
                                
                                {/* Bouton de suppression pour les réponses - visible si l'utilisateur est l'auteur de la réponse ou un admin */}
                                {(currentUserId && (currentUserId === reply.userId || isAdmin)) && (
                                  <button 
                                    onClick={async () => {
                                      if (window.confirm(t('comments.deleteReplyConfirm'))) {
                                        await deleteComment(reply.id, currentUserId || undefined, isAdmin);
                                        refreshComments();
                                      }
                                    }}
                                    className="flex items-center text-gray-400 hover:text-red-500 transition hover:scale-105 text-xs"
                                  >
                                    <Trash2 size={14} className="mr-1" />
                                    <span>{t('common.delete')}</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommentItem;