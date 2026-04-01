import { db } from '../config/firebase';
import { 
  doc, 
  updateDoc, 
  arrayUnion, 
  getDoc,
  query,
  collection,
  where,
  getDocs
} from '@firebase/firestore';
import { Notification } from '../types/Comment';
import { v4 as uuidv4 } from 'uuid';

/**
 * Ajoute une notification pour l'auteur d'un commentaire lorsqu'une réponse est ajoutée
 */
export const addReplyNotification = async (
  parentCommentId: string,
  replyId: string,
  replyContent: string,
  fromUserId: string,
  fromUsername: string
): Promise<boolean> => {
  try {
    // Récupérer les données du commentaire parent
    const commentRef = doc(db, 'comments', parentCommentId);
    const commentSnapshot = await getDoc(commentRef);
    
    if (!commentSnapshot.exists()) {
      console.error('Parent comment not found');
      return false;
    }
    
    const commentData = commentSnapshot.data();
    
    // Ne pas envoyer de notification si l'utilisateur répond à son propre commentaire
    if (commentData.userId === fromUserId) {
      return false;
    }
    
    // Créer la notification
    const notification: Notification = {
      id: uuidv4(),
      type: 'reply',
      commentId: parentCommentId,
      replyId: replyId,
      content: replyContent.substring(0, 100) + (replyContent.length > 100 ? '...' : ''),
      fromUserId,
      fromUsername,
      createdAt: new Date(),
      read: false
    };
    
    // Ajouter la notification au commentaire
    await updateDoc(commentRef, {
      notifications: arrayUnion(notification)
    });
    
    return true;
  } catch (error) {
    console.error('Error adding notification:', error);
    return false;
  }
};

/**
 * Récupère toutes les notifications non lues pour un utilisateur
 */
export const getUserNotifications = async (userId: string): Promise<Notification[]> => {
  try {
    // Rechercher tous les commentaires de l'utilisateur
    const userCommentsQuery = query(
      collection(db, 'comments'),
      where('userId', '==', userId)
    );
    
    const commentsSnapshot = await getDocs(userCommentsQuery);
    
    // Récupérer toutes les notifications de tous les commentaires
    const notifications: Notification[] = [];
    
    commentsSnapshot.forEach(commentDoc => {
      const commentData = commentDoc.data();
      const commentNotifications = commentData.notifications || [];
      
      if (commentNotifications.length > 0) {
        // Convertir les dates pour chaque notification
        const formattedNotifications = commentNotifications.map((notification: any) => ({
          ...notification,
          createdAt: notification.createdAt?.toDate() || new Date()
        }));
        
        notifications.push(...formattedNotifications);
      }
    });
    
    // Trier par date, les plus récentes en premier
    return notifications.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    
  } catch (error) {
    console.error('Error getting user notifications:', error);
    return [];
  }
};

/**
 * Marquer une notification comme lue
 */
export const markNotificationAsRead = async (
  commentId: string,
  notificationId: string
): Promise<boolean> => {
  try {
    // Récupérer le commentaire
    const commentRef = doc(db, 'comments', commentId);
    const commentSnapshot = await getDoc(commentRef);
    
    if (!commentSnapshot.exists()) {
      console.error('Comment not found');
      return false;
    }
    
    const commentData = commentSnapshot.data();
    const notifications = commentData.notifications || [];
    
    // Trouver et modifier la notification
    const updatedNotifications = notifications.map((notification: any) => {
      if (notification.id === notificationId) {
        return { ...notification, read: true };
      }
      return notification;
    });
    
    // Mettre à jour le commentaire avec les notifications modifiées
    await updateDoc(commentRef, {
      notifications: updatedNotifications
    });
    
    return true;
  } catch (error) {
    console.error('Error marking notification as read:', error);
    return false;
  }
};

/**
 * Marquer toutes les notifications comme lues
 */
export const markAllNotificationsAsRead = async (userId: string): Promise<boolean> => {
  try {
    // Rechercher tous les commentaires de l'utilisateur
    const userCommentsQuery = query(
      collection(db, 'comments'),
      where('userId', '==', userId)
    );
    
    const commentsSnapshot = await getDocs(userCommentsQuery);
    
    // Parcourir tous les commentaires et marquer toutes les notifications comme lues
    const updatePromises = commentsSnapshot.docs.map(async (commentDoc) => {
      const commentData = commentDoc.data();
      const notifications = commentData.notifications || [];
      
      if (notifications.length > 0) {
        const updatedNotifications = notifications.map((notification: any) => ({
          ...notification,
          read: true
        }));
        
        await updateDoc(doc(db, 'comments', commentDoc.id), {
          notifications: updatedNotifications
        });
      }
    });
    
    await Promise.all(updatePromises);
    
    return true;
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    return false;
  }
};

/**
 * Récupère les détails du contenu (film/série) associé à un commentaire
 */
export const getCommentDetails = async (commentId: string): Promise<{ contentId: string, contentType: 'movie' | 'series' } | null> => {
  try {
    // Récupérer le commentaire
    const commentRef = doc(db, 'comments', commentId);
    const commentSnapshot = await getDoc(commentRef);
    
    if (!commentSnapshot.exists()) {
      console.error('Comment not found');
      return null;
    }
    
    const commentData = commentSnapshot.data();
    
    return {
      contentId: commentData.contentId,
      contentType: commentData.contentType,
    };
  } catch (error) {
    console.error('Error getting comment details:', error);
    return null;
  }
};

/**
 * Récupère le nombre de notifications non lues pour un utilisateur
 */
export const getUnreadNotificationsCount = async (userId: string): Promise<number> => {
  try {
    const notifications = await getUserNotifications(userId);
    return notifications.filter(notification => !notification.read).length;
  } catch (error) {
    console.error('Error counting unread notifications:', error);
    return 0;
  }
};

/**
 * Supprime une notification spécifique d'un commentaire
 */
export const deleteNotification = async (
  commentId: string,
  notificationId: string
): Promise<boolean> => {
  try {
    // Récupérer le commentaire
    const commentRef = doc(db, 'comments', commentId);
    const commentSnapshot = await getDoc(commentRef);
    
    if (!commentSnapshot.exists()) {
      console.error('Comment not found');
      return false;
    }
    
    const commentData = commentSnapshot.data();
    const notifications = commentData.notifications || [];
    
    // Filtrer pour supprimer la notification
    const updatedNotifications = notifications.filter(
      (notification: any) => notification.id !== notificationId
    );
    
    // Mettre à jour le commentaire avec les notifications filtrées
    await updateDoc(commentRef, {
      notifications: updatedNotifications
    });
    
    return true;
  } catch (error) {
    console.error('Error deleting notification:', error);
    return false;
  }
}; 