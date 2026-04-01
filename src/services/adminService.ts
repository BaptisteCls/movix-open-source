import { db } from '../config/firebase';
import { doc, getDoc } from '@firebase/firestore';
import { logAdmin, logError } from './logService';

// Local storage key for admin credentials
const ADMIN_CODE_KEY = 'admin_code';

// Helper to get Discord user information
const getDiscordUserInfo = () => {
  try {
    const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
    if (isDiscordAuth) {
      const discordUser = JSON.parse(localStorage.getItem('discord_user') || '{}');
      return {
        id: discordUser.id,
        username: discordUser.username,
        roles: discordUser.roles || [],
        isAdmin: discordUser.isAdmin || false
      };
    }
  } catch (error) {
    console.error('Error getting Discord user info:', error);
  }
  return null;
};

// Check if admin code exists directly as a document ID in the users collection
export const verifyAdminCode = async (code: string): Promise<boolean> => {
  try {
    console.log(`Tentative de vérification du code: ${code}`);
    
    // Get the document with the ID that matches the provided code
    const userDocRef = doc(db, 'users', code);
    const userSnapshot = await getDoc(userDocRef);
    
    console.log(`Document existe: ${userSnapshot.exists()}`);
    
    // If document exists and has role='admin'
    if (userSnapshot.exists()) {
      const userData = userSnapshot.data();
      console.log(`Données utilisateur:`, userData);
      
      // Check if the user is an admin
      if (userData.role === 'admin') {
        console.log('Utilisateur est admin, authentification réussie');
        
        // Récupérer les informations Discord si disponibles
        const discordInfo = getDiscordUserInfo();
        
        // Log l'événement de connexion avec informations Discord si disponibles
        const logDetails = {
          method: 'code',
          timestamp: new Date().toISOString(),
          discordInfo: discordInfo || 'Non connecté via Discord'
        };
        
        await logAdmin('Connexion administrateur réussie', 
          logDetails, 
          code, 
          userData.nom || 'Admin'
        );
        
        // Store the admin code in localStorage
        localStorage.setItem(ADMIN_CODE_KEY, code);
        return true;
      } else {
        console.log(`Rôle trouvé: ${userData.role}, mais ce n'est pas 'admin'`);
        
        // Récupérer les informations Discord si disponibles
        const discordInfo = getDiscordUserInfo();
        
        // Log la tentative échouée
        await logError('Tentative de connexion admin avec rôle invalide', {
          code,
          role: userData.role,
          expectedRole: 'admin',
          discordInfo: discordInfo || 'Non connecté via Discord'
        });
      }
    } else {
      console.log(`Aucun document trouvé avec l'ID: ${code}`);
      
      // Récupérer les informations Discord si disponibles
      const discordInfo = getDiscordUserInfo();
      
      // Log la tentative échouée
      await logError('Tentative de connexion admin avec code invalide', {
        code,
        discordInfo: discordInfo || 'Non connecté via Discord'
      });
    }
    
    return false;
  } catch (error) {
    console.error('Error verifying admin code:', error);
    
    // Récupérer les informations Discord si disponibles
    const discordInfo = getDiscordUserInfo();
    
    // Log l'erreur
    await logError('Erreur lors de la vérification du code admin', 
      { error, discordInfo: discordInfo || 'Non connecté via Discord' }, 
      code
    );
    
    return false;
  }
};

// Check if the user is already authenticated as admin
export const isAdminAuthenticated = async (): Promise<boolean> => {
  try {
    const storedCode = localStorage.getItem(ADMIN_CODE_KEY);
    console.log(`Code stocké: ${storedCode}`);
    
    // If no code stored, user is not admin
    if (!storedCode) {
      console.log('Aucun code admin stocké');
      return false;
    }

    const adminChecked = sessionStorage.getItem('admin_checked');
    
    if (adminChecked) {
      // Si la vérification a déjà été effectuée cette session, utiliser le résultat stocké
      return localStorage.getItem(ADMIN_CODE_KEY) !== null;
    } else {
      // Première vérification de la session, vérifier auprès de Firebase
      const isValid = await verifyAdminCode(storedCode);
      // Marquer que la vérification a été effectuée pour cette session
      sessionStorage.setItem('admin_checked', 'true');
      return isValid;
    }
  } catch (error) {
    console.error('Error checking admin authentication:', error);
    
    // Récupérer les informations Discord si disponibles
    const discordInfo = getDiscordUserInfo();
    
    // Log l'erreur
    await logError('Erreur lors de la vérification du statut admin', 
      { error, discordInfo: discordInfo || 'Non connecté via Discord' }
    );
    
    return false;
  }
};

// Remove admin authentication
export const logoutAdmin = async (): Promise<void> => {
  try {
    console.log('Déconnexion admin');
    const adminCode = localStorage.getItem(ADMIN_CODE_KEY);
    
    // Récupérer les informations Discord si disponibles
    const discordInfo = getDiscordUserInfo();
    
    if (adminCode) {
      // Récupérer les infos admin si possible
      try {
        const userDocRef = doc(db, 'users', adminCode);
        const userSnapshot = await getDoc(userDocRef);
        
        if (userSnapshot.exists()) {
          const userData = userSnapshot.data();
          
          // Log l'événement de déconnexion
          await logAdmin('Déconnexion administrateur', {
            timestamp: new Date().toISOString(),
            discordInfo: discordInfo || 'Non connecté via Discord'
          }, adminCode, userData.nom || 'Admin');
        }
      } catch (error) {
        console.error('Erreur lors de la récupération des infos admin pour le log de déconnexion:', error);
      }
    }
    
    // Supprimer du localStorage
    localStorage.removeItem(ADMIN_CODE_KEY);
  } catch (error) {
    console.error('Erreur lors de la déconnexion admin:', error);
    
    // Récupérer les informations Discord si disponibles
    const discordInfo = getDiscordUserInfo();
    
    // Log l'erreur
    await logError('Erreur lors de la déconnexion admin', 
      { error, discordInfo: discordInfo || 'Non connecté via Discord' }
    );
  }
}; 