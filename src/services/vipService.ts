import { db } from '../config/firebase';
import { doc, getDoc, setDoc, updateDoc, Timestamp } from '@firebase/firestore';
import { sellAuthUtils } from '../config/sellAuth';
import i18n from '../i18n';

interface VIPKeyInfo {
  expiresAt: Date | undefined;
  createdAt: Date;
  userId: string;
  type: 'vip';
}

// Service pour gérer les clés VIP
export const vipService = {
  // Vérifier si une clé VIP est valide
  verifyVIPKey: async (code: string): Promise<{ valid: boolean; message?: string; expires?: Date }> => {
    try {
      // Vérifier dans Firebase
      const keyRef = doc(db, 'access_keys', code);
      const keyDoc = await getDoc(keyRef);
      
      if (!keyDoc.exists()) {
        return { valid: false, message: 'Clé non trouvée' };
      }
      
      const keyData = keyDoc.data() as VIPKeyInfo;
      
      // Vérifier si la clé a expiré
      if (keyData.expiresAt && keyData.expiresAt < new Date()) {
        return { valid: false, message: 'Clé expirée' };
      }
      
      return { 
        valid: true,
        expires: keyData.expiresAt
      };
    } catch (error) {
      console.error('Erreur lors de la vérification de la clé VIP:', error);
      return { valid: false, message: i18n.t('vip.errors.verifyKeyError') };
    }
  },
  
  // Activer la fonction VIP pour un utilisateur
  activateVIP: async (userId: string, keyCode: string): Promise<{ success: boolean; message?: string; expiresAt?: Date }> => {
    try {
      // Vérifier la clé
      const keyResult = await vipService.verifyVIPKey(keyCode);
      
      if (!keyResult.valid) {
        return { success: false, message: keyResult.message };
      }
      
      
      // Mettre à jour le profil utilisateur
      const userRef = doc(db, 'users', userId);
      const userDoc = await getDoc(userRef);
      
      if (userDoc.exists()) {
        await updateDoc(userRef, {
          vip: true,
          vipExpiresAt: keyResult.expires || null,
          vipActivatedAt: Timestamp.now()
        });
      } else {
        // Créer un nouveau profil utilisateur
        await setDoc(userRef, {
          id: userId,
          vip: true,
          vipExpiresAt: keyResult.expires || null,
          vipActivatedAt: Timestamp.now(),
          createdAt: Timestamp.now()
        });
      }
      
      return { 
        success: true, 
        expiresAt: keyResult.expires 
      };
    } catch (error) {
      console.error("Erreur lors de l'activation du VIP:", error);
      return { success: false, message: i18n.t('vip.errors.activateError') };
    }
  },
  
  // Créer une nouvelle clé VIP via SellAuth
  createVIPKey: async (userId: string, duration: number = 30): Promise<{ success: boolean; key?: string; message?: string }> => {
    try {
      const result = await sellAuthUtils.createDynamicKey(userId, duration);
      
      if (result.error) {
        return { success: false, message: result.error };
      }
      
      return { success: true, key: result.key };
    } catch (error) {
      console.error('Erreur lors de la création de la clé VIP:', error);
      return { success: false, message: i18n.t('vip.errors.createKeyError') };
    }
  },
  
  // Récupérer l'état VIP d'un utilisateur
  getUserVIPStatus: async (userId: string): Promise<{ isVip: boolean; expiresAt?: Date; features: string[] }> => {
    try {
      const userRef = doc(db, 'users', userId);
      const userDoc = await getDoc(userRef);
      
      if (!userDoc.exists()) {
        return { isVip: false, features: [] };
      }
      
      const userData = userDoc.data();
      
      // Vérifier si l'utilisateur est VIP
      if (!userData.vip) {
        return { isVip: false, features: [] };
      }
      
      // Vérifier si le VIP a expiré
      if (userData.vipExpiresAt && userData.vipExpiresAt.toDate() < new Date()) {
        // Mettre à jour le statut VIP
        await updateDoc(userRef, { vip: false });
        return { isVip: false, features: [] };
      }
      
      // Liste des fonctionnalités VIP
      const vipFeatures = [
        i18n.t('vip.featuresList.quality4k'),
        i18n.t('vip.featuresList.noAds'),
        i18n.t('vip.featuresList.prioritySupport'),
        i18n.t('vip.featuresList.multiLangSubs'),
        i18n.t('vip.featuresList.multiLangDubs'),
        i18n.t('vip.featuresList.customBadge')
      ];
      
      return { 
        isVip: true, 
        expiresAt: userData.vipExpiresAt ? userData.vipExpiresAt.toDate() : undefined,
        features: vipFeatures
      };
    } catch (error) {
      console.error("Erreur lors de la vérification du statut VIP:", error);
      return { isVip: false, features: [] };
    }
  }
};

export default vipService; 
