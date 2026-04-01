import { db } from './firebase';
import { doc, setDoc, Timestamp } from '@firebase/firestore';

// Configuration SellAuth
interface SellAuthConfig {
  apiKey: string;
  apiUrl: string;
  productId: string;
  webhookSecret: string;
}

// Configuration du produit VIP
interface VIPProductConfig {
  defaultDuration: number; // Durée en jours
  mode: 'static' | 'dynamic';
  startDate?: Date;
  endDate?: Date;
}

export const sellAuthConfig: SellAuthConfig = {
  apiKey: process.env.SELLAUTH_API_KEY || 'VOTRE_API_KEY_SELLAUTH',
  apiUrl: 'https://api.sellauth.io',
  productId: process.env.SELLAUTH_PRODUCT_ID || '283895',
  webhookSecret: process.env.SELLAUTH_WEBHOOK_SECRET || 'VOTRE_SECRET_WEBHOOK_SELLAUTH'
};

export const vipProductConfig: VIPProductConfig = {
  defaultDuration: 30, // 30 jours par défaut
  mode: 'dynamic', // Mode dynamique
};

// Fonctions pour gérer les clés VIP
export const sellAuthUtils = {
  // Vérifier une clé via l'API SellAuth
  verifyKey: async (key: string) => {
    try {
      const response = await fetch(`${sellAuthConfig.apiUrl}/keys/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sellAuthConfig.apiKey}`
        },
        body: JSON.stringify({ key })
      });
      
      return await response.json();
    } catch (error) {
      console.error('Erreur lors de la vérification de la clé:', error);
      return { valid: false, error: 'Erreur de connexion au serveur' };
    }
  },
  
  // Créer une nouvelle clé dynamique
  createDynamicKey: async (userId: string, duration: number = vipProductConfig.defaultDuration) => {
    try {
      const response = await fetch(`${sellAuthConfig.apiUrl}/keys/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sellAuthConfig.apiKey}`
        },
        body: JSON.stringify({
          productId: sellAuthConfig.productId,
          userId,
          duration: duration * 24 * 60 * 60, // Convertir les jours en secondes
          mode: 'dynamic'
        })
      });
      
      const data = await response.json();
      
      if (data.key) {
        // Ajouter la clé à Firebase
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + duration);
        
        await setDoc(doc(db, 'access_keys', data.key), {
          userId,
          active: true,
          createdAt: Timestamp.now(),
          expiresAt: Timestamp.fromDate(expiresAt),
          type: 'vip'
        });
      }
      
      return data;
    } catch (error) {
      console.error('Erreur lors de la création de la clé:', error);
      return { error: 'Erreur de connexion au serveur' };
    }
  },
  
  // Gérer le webhook de SellAuth
  handleWebhook: async (payload: any, signature: string) => {
    // Vérifier la signature du webhook
    const isValid = verifySignature(payload, signature, sellAuthConfig.webhookSecret);
    
    if (!isValid) {
      throw new Error('Signature webhook invalide');
    }
    
    // Traiter l'événement
    if (payload.event === 'purchase.completed') {
      const { key, userId, productId } = payload.data;
      
      if (productId === sellAuthConfig.productId) {
        // Déterminer la durée d'expiration
        const duration = payload.data.duration || vipProductConfig.defaultDuration;
        
        // Calculer la date d'expiration
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + duration);
        
        // Enregistrer la clé dans Firebase
        await setDoc(doc(db, 'access_keys', key), {
          userId,
          active: true,
          createdAt: Timestamp.now(),
          expiresAt: Timestamp.fromDate(expiresAt),
          type: 'vip'
        });
        
        return { success: true, key };
      }
    }
    
    return { success: false, error: 'Événement non géré' };
  }
};

// Fonction pour vérifier la signature webhook
function verifySignature(payload: any, signature: string, secret: string): boolean {
  const crypto = require('crypto');
  
  const hmac = crypto.createHmac('sha256', secret);
  const computed = hmac.update(JSON.stringify(payload)).digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(computed)
  );
} 