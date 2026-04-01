export interface Reaction {
  emoji: string;
  count: number;
  users: string[]; // IDs des utilisateurs qui ont réagi avec cet emoji
}

export interface Notification {
  id: string;
  type: 'reply' | 'like' | 'mention';
  commentId: string;
  replyId?: string;
  content: string;
  fromUserId: string;
  fromUsername: string;
  createdAt: Date;
  read: boolean;
}

// Limites de caractères pour les commentaires
export const COMMENT_LENGTH_LIMITS = {
  COMMENT: 500,
  REPLY: 300
};

export interface Comment {
  id: string;
  contentId: string;  // ID of the movie or series
  contentType: 'movie' | 'series';
  userId: string;
  username: string;
  userAvatar: string;
  content: string;
  createdAt: Date;
  likes: number;
  likedBy: string[]; // IDs des utilisateurs qui ont liké
  dislikes: number;
  dislikedBy: string[]; // IDs des utilisateurs qui ont disliké
  reactions: Reaction[]; // Reactions avec emojis
  replies?: Comment[];
  parentId?: string;  // For replies, refers to parent comment ID
  isAdmin?: boolean;  // Indique si le commentaire provient d'un admin
  notifications?: Notification[]; // Notifications liées au commentaire
} 