import { db } from '../config/firebase';
import { 
  collection, addDoc, getDocs, query, where, orderBy, 
  doc, updateDoc, deleteDoc, increment, arrayUnion, arrayRemove,
  serverTimestamp
} from '@firebase/firestore';
import { Comment, Reaction, COMMENT_LENGTH_LIMITS } from '../types/Comment';
import { logComment, logError } from './logService';

// Limites de caractères
export const MAX_COMMENT_LENGTH = COMMENT_LENGTH_LIMITS.COMMENT;
export const MAX_REPLY_LENGTH = COMMENT_LENGTH_LIMITS.REPLY;

// Get all comments for a specific content (movie or series)
export const getComments = async (contentId: string, contentType: 'movie' | 'series'): Promise<Comment[]> => {
  try {
    // Get only root comments (not replies)
    const commentsQuery = query(
      collection(db, 'comments'),
      where('contentId', '==', contentId),
      where('contentType', '==', contentType),
      where('parentId', '==', null),
      orderBy('createdAt', 'desc')
    );

    const snapshot = await getDocs(commentsQuery);
    const comments: Comment[] = [];

    for (const docSnapshot of snapshot.docs) {
      const data = docSnapshot.data();
      
      // Get replies for this comment
      const repliesQuery = query(
        collection(db, 'comments'),
        where('parentId', '==', docSnapshot.id),
        orderBy('createdAt', 'asc')
      );
      
      const repliesSnapshot = await getDocs(repliesQuery);
      const replies: Comment[] = repliesSnapshot.docs.map(replyDoc => ({
        id: replyDoc.id,
        ...replyDoc.data(),
        createdAt: replyDoc.data().createdAt.toDate(),
        likedBy: replyDoc.data().likedBy || [],
        dislikedBy: replyDoc.data().dislikedBy || [],
        dislikes: replyDoc.data().dislikes || 0,
        reactions: replyDoc.data().reactions || [],
      } as Comment));

      comments.push({
        id: docSnapshot.id,
        ...data,
        createdAt: data.createdAt.toDate(),
        likedBy: data.likedBy || [],
        dislikedBy: data.dislikedBy || [],
        dislikes: data.dislikes || 0,
        reactions: data.reactions || [],
        replies
      } as Comment);
    }

    return comments;
  } catch (error) {
    console.error('Error getting comments:', error);
    
    // Log l'erreur
    await logError('Erreur lors de la récupération des commentaires', error);
    
    throw error;
  }
};

// Add a new comment
export const addComment = async (
  contentId: string,
  contentType: 'movie' | 'series',
  userId: string,
  username: string,
  userAvatar: string,
  content: string,
  parentId?: string,
  isAdmin?: boolean
): Promise<string> => {
  try {
    // Appliquer la limite de caractères
    const maxLength = parentId ? MAX_REPLY_LENGTH : MAX_COMMENT_LENGTH;
    const trimmedContent = content.slice(0, maxLength);
    
    const commentData = {
      contentId,
      contentType,
      userId,
      username,
      userAvatar,
      content: trimmedContent,
      createdAt: serverTimestamp(),
      likes: 0,
      likedBy: [],
      dislikes: 0,
      dislikedBy: [],
      reactions: [],
      parentId: parentId || null,
      isAdmin: isAdmin || false
    };

    const docRef = await addDoc(collection(db, 'comments'), commentData);
    
    // Log l'ajout de commentaire
    await logComment(parentId ? 'Réponse ajoutée' : 'Commentaire ajouté', {
      commentId: docRef.id,
      contentId,
      contentType,
      isReply: !!parentId,
      parentId,
      isAdmin: isAdmin || false,
      comment: trimmedContent.substring(0, 100) + (trimmedContent.length > 100 ? '...' : '')
    }, userId, username);
    
    return docRef.id;
  } catch (error) {
    console.error('Error adding comment:', error);
    
    // Log l'erreur
    await logError('Erreur lors de l\'ajout d\'un commentaire', error, userId, username);
    
    throw error;
  }
};

// Delete a comment
export const deleteComment = async (commentId: string, userId?: string, isAdmin?: boolean): Promise<void> => {
  try {
    // Get comment data first for logging
    const commentQuery = query(collection(db, 'comments'), where('__name__', '==', commentId));
    const commentSnapshot = await getDocs(commentQuery);
    
    if (commentSnapshot.empty) {
      throw new Error('Comment not found');
    }
    
    const commentData = commentSnapshot.docs[0].data();
    const commentRef = doc(db, 'comments', commentId);
    
    // Delete the comment
    await deleteDoc(commentRef);
    
    // Log la suppression avec un message spécifique pour les admins
    const logMessage = isAdmin 
      ? '🛑 Commentaire supprimé par ADMINISTRATEUR' 
      : 'Commentaire supprimé par utilisateur';
    
    await logComment(logMessage, {
      commentId,
      contentId: commentData.contentId,
      contentType: commentData.contentType,
      deletedBy: userId || 'unknown',
      deletedByAdmin: !!isAdmin,
      comment: commentData.content.substring(0, 100) + (commentData.content.length > 100 ? '...' : '')
    }, userId || commentData.userId, commentData.username);
    
  } catch (error) {
    console.error('Error deleting comment:', error);
    
    // Log l'erreur
    await logError('Erreur lors de la suppression d\'un commentaire', error, userId);
    
    throw error;
  }
};

// Like a comment
export const likeComment = async (commentId: string, userId: string): Promise<void> => {
  try {
    const commentRef = doc(db, 'comments', commentId);
    const commentDoc = await getDocs(query(collection(db, 'comments'), where('__name__', '==', commentId)));
    
    if (commentDoc.empty) {
      throw new Error('Comment not found');
    }
    
    const commentData = commentDoc.docs[0].data();
    const likedBy = commentData.likedBy || [];
    const dislikedBy = commentData.dislikedBy || [];
    const isRemovingLike = likedBy.includes(userId);
    
    if (isRemovingLike) {
      // User already liked, so remove like
      await updateDoc(commentRef, {
        likes: increment(-1),
        likedBy: arrayRemove(userId)
      });
      
      // Log la suppression du like
      await logComment('Like retiré d\'un commentaire', {
        commentId,
        action: 'remove',
        commentPreview: commentData.content.substring(0, 100)
      }, userId, commentData.username);
    } else {
      // Add like
      await updateDoc(commentRef, {
        likes: increment(1),
        likedBy: arrayUnion(userId)
      });
      
      // Log l'ajout du like
      await logComment('Like ajouté à un commentaire', {
        commentId,
        action: 'add',
        commentPreview: commentData.content.substring(0, 100)
      }, userId, commentData.username);
      
      // If user previously disliked, remove the dislike
      if (dislikedBy.includes(userId)) {
        await updateDoc(commentRef, {
          dislikes: increment(-1),
          dislikedBy: arrayRemove(userId)
        });
        
        // Log la suppression du dislike
        await logComment('Dislike retiré d\'un commentaire', {
          commentId,
          action: 'remove',
          commentPreview: commentData.content.substring(0, 100)
        }, userId, commentData.username);
      }
    }
  } catch (error) {
    console.error('Error liking comment:', error);
    
    // Log l'erreur
    await logError('Erreur lors du like d\'un commentaire', error, userId);
    
    throw error;
  }
};

// Dislike a comment
export const dislikeComment = async (commentId: string, userId: string): Promise<void> => {
  try {
    const commentRef = doc(db, 'comments', commentId);
    const commentDoc = await getDocs(query(collection(db, 'comments'), where('__name__', '==', commentId)));
    
    if (commentDoc.empty) {
      throw new Error('Comment not found');
    }
    
    const commentData = commentDoc.docs[0].data();
    const likedBy = commentData.likedBy || [];
    const dislikedBy = commentData.dislikedBy || [];
    const isRemovingDislike = dislikedBy.includes(userId);
    
    if (isRemovingDislike) {
      // User already disliked, so remove dislike
      await updateDoc(commentRef, {
        dislikes: increment(-1),
        dislikedBy: arrayRemove(userId)
      });
      
      // Log la suppression du dislike
      await logComment('Dislike retiré d\'un commentaire', {
        commentId,
        action: 'remove',
        commentPreview: commentData.content.substring(0, 100)
      }, userId, commentData.username);
    } else {
      // Add dislike
      await updateDoc(commentRef, {
        dislikes: increment(1),
        dislikedBy: arrayUnion(userId)
      });
      
      // Log l'ajout du dislike
      await logComment('Dislike ajouté à un commentaire', {
        commentId,
        action: 'add',
        commentPreview: commentData.content.substring(0, 100)
      }, userId, commentData.username);
      
      // If user previously liked, remove the like
      if (likedBy.includes(userId)) {
        await updateDoc(commentRef, {
          likes: increment(-1),
          likedBy: arrayRemove(userId)
        });
        
        // Log la suppression du like
        await logComment('Like retiré d\'un commentaire', {
          commentId,
          action: 'remove',
          commentPreview: commentData.content.substring(0, 100)
        }, userId, commentData.username);
      }
    }
  } catch (error) {
    console.error('Error disliking comment:', error);
    
    // Log l'erreur
    await logError('Erreur lors du dislike d\'un commentaire', error, userId);
    
    throw error;
  }
};

// Add or remove emoji reaction
export const reactWithEmoji = async (commentId: string, emoji: string, userId: string): Promise<void> => {
  try {
    const commentRef = doc(db, 'comments', commentId);
    const commentDoc = await getDocs(query(collection(db, 'comments'), where('__name__', '==', commentId)));
    
    if (commentDoc.empty) {
      throw new Error('Comment not found');
    }
    
    const commentData = commentDoc.docs[0].data();
    const reactions = commentData.reactions || [];
    
    // Check if this emoji reaction already exists
    const existingReactionIndex = reactions.findIndex((r: Reaction) => r.emoji === emoji);
    
    if (existingReactionIndex !== -1) {
      const reaction = reactions[existingReactionIndex];
      
      if (reaction.users.includes(userId)) {
        // User already reacted with this emoji, so remove the reaction
        const updatedReactions = [...reactions];
        updatedReactions[existingReactionIndex] = {
          ...reaction,
          count: reaction.count - 1,
          users: reaction.users.filter((id: string) => id !== userId)
        };
        
        // If count is 0, remove this reaction entirely
        const filteredReactions = updatedReactions.filter((r: Reaction) => r.count > 0);
        
        await updateDoc(commentRef, {
          reactions: filteredReactions
        });
        
        // Log la suppression de la réaction
        await logComment(`Réaction emoji retirée: ${emoji}`, {
          emoji,
          commentId,
          action: 'remove',
          commentPreview: commentData.content.substring(0, 100)
        }, userId, commentData.username);
      } else {
        // User hasn't reacted with this emoji yet, so add their reaction
        const updatedReactions = [...reactions];
        updatedReactions[existingReactionIndex] = {
          ...reaction,
          count: reaction.count + 1,
          users: [...reaction.users, userId]
        };
        
        await updateDoc(commentRef, {
          reactions: updatedReactions
        });
        
        // Log l'ajout de la réaction
        await logComment(`Réaction emoji ajoutée: ${emoji}`, {
          emoji,
          commentId,
          action: 'add',
          commentPreview: commentData.content.substring(0, 100)
        }, userId, commentData.username);
      }
    } else {
      // This emoji reaction doesn't exist yet, create it
      const newReaction: Reaction = {
        emoji,
        count: 1,
        users: [userId]
      };
      
      await updateDoc(commentRef, {
        reactions: [...reactions, newReaction]
      });
      
      // Log l'ajout de la réaction
      await logComment(`Réaction emoji ajoutée: ${emoji}`, {
        emoji,
        commentId,
        action: 'add',
        commentPreview: commentData.content.substring(0, 100)
      }, userId, commentData.username);
    }
  } catch (error) {
    console.error('Error reacting to comment:', error);
    
    // Log l'erreur
    await logError('Erreur lors de l\'ajout d\'une réaction emoji', error, userId);
    
    throw error;
  }
}; 