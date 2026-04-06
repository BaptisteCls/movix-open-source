import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { verifyAdminCode, isAdminAuthenticated, logoutAdmin } from '../services/adminService';
import { Lock, Unlock, LogOut } from 'lucide-react';
import { checkDiscordMembership } from '../utils/discord';
import { DISCORD_CONFIG } from '../config/discord';

interface AdminLoginProps {
  onAdminStatusChange?: (isAdmin: boolean) => void;
}

const AdminLogin: React.FC<AdminLoginProps> = ({ onAdminStatusChange }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [adminCode, setAdminCode] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [error, setError] = useState('');

  // Check if user is already authenticated as admin
  useEffect(() => {
    // Ignorer la vérification si on est en train de se déconnecter
    if (isLoggingOut) return;
    
    const checkAdminStatus = async () => {
      console.log("Vérification du statut admin au chargement");
      
      // Check if authenticated via Discord
      const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
      if (isDiscordAuth) {
        try {
          const discordUser = JSON.parse(localStorage.getItem('discord_user') || '{}');
          
          // Si l'utilisateur est déjà identifié comme admin via Discord, conserver son statut
          if (discordUser.isAdmin) {
            console.log("User is already admin via Discord role (cached)");
            setIsAdmin(true);
            if (onAdminStatusChange) {
              onAdminStatusChange(true);
            }
            return;
          }
          
          // Check if we need to refresh the role info
          const lastCheck = parseInt(localStorage.getItem('discord_last_check') || '0');
          const now = Date.now();
          const needsRefresh = now - lastCheck > (DISCORD_CONFIG.CACHE_DURATION * 1000);
          
          if (needsRefresh) {
            console.log("Refreshing Discord roles...");
            const accessToken = localStorage.getItem('discord_token');
            if (accessToken) {
              const membershipData = await checkDiscordMembership(accessToken);
              
              // Ne pas modifier l'état si on est rate limited et qu'on n'a pas de données valides
              if (membershipData.isRateLimited && !membershipData.isAdmin) {
                console.log("Rate limited, preserving current admin status");
                return;
              }
              
              const isDiscordAdmin = membershipData.isAdmin;
              
              // Update the user info in localStorage
              const updatedUser = {
                ...discordUser,
                roles: membershipData.roles,
                isAdmin: isDiscordAdmin
              };
              localStorage.setItem('discord_user', JSON.stringify(updatedUser));
              localStorage.setItem('discord_last_check', now.toString());
              
              if (isDiscordAdmin) {
                console.log("User is admin via Discord role (fresh check)");
                setIsAdmin(true);
                if (onAdminStatusChange) {
                  onAdminStatusChange(true);
                }
                return;
              }
            }
          }
        } catch (error) {
          console.error("Error checking Discord admin status:", error);
          // En cas d'erreur, on conserve le statut admin actuel si l'utilisateur l'était déjà
          if (isAdmin) {
            console.log("Error during Discord check, preserving admin status");
            return;
          }
        }
      }
      
      // Fallback to traditional admin authentication
      const adminStatus = await isAdminAuthenticated();
      console.log(`Statut admin traditionnel: ${adminStatus}`);
      setIsAdmin(adminStatus);
      if (onAdminStatusChange) {
        onAdminStatusChange(adminStatus);
      }
    };
    
    checkAdminStatus();
  }, [onAdminStatusChange, isLoggingOut, isAdmin]);

  const handleAdminLogin = async () => {
    if (!adminCode.trim()) {
      setError(t('admin.enterAdminCode'));
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      console.log(`Tentative de connexion avec le code: ${adminCode}`);
      const isValid = await verifyAdminCode(adminCode);
      console.log(`Résultat de la vérification: ${isValid}`);
      
      if (isValid) {
        setIsAdmin(true);
        setIsOpen(false);
        setAdminCode('');
        if (onAdminStatusChange) {
          onAdminStatusChange(true);
        }
      } else {
        setError(t('admin.invalidAdminCode'));
      }
    } catch (err) {
      console.error('Erreur complète:', err);
      setError(t('admin.codeVerificationError'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    
    try {
      await logoutAdmin();
      // Attendre un court instant pour s'assurer que le localStorage est bien mis à jour
      setTimeout(() => {
        setIsAdmin(false);
        if (onAdminStatusChange) {
          onAdminStatusChange(false);
        }
        setIsLoggingOut(false);
      }, 100);
    } catch (error) {
      console.error('Erreur lors de la déconnexion:', error);
      setIsLoggingOut(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAdminLogin();
    }
  };

  // Vérifier si on doit afficher le bouton Admin basé sur les rôles Discord
  const shouldShowAdminButton = () => {
    // Si déjà authentifié comme admin, on affiche toujours le bouton
    if (isAdmin) return true;
    
    // Vérifier l'authentification Discord
    const isDiscordAuth = localStorage.getItem('discord_auth') === 'true';
    if (isDiscordAuth) {
      try {
        const discordUser = JSON.parse(localStorage.getItem('discord_user') || '{}');
        return discordUser.isAdmin || false;
      } catch {
        return false;
      }
    }
    
    // Si l'utilisateur n'est pas connecté via Discord, ne pas afficher le bouton
    return false;
  };

  // Si on ne doit pas afficher le bouton, retourner null
  if (!shouldShowAdminButton()) {
    return null;
  }

  return (
    <div className="relative">
      {isAdmin ? (
        <button 
          onClick={handleLogout}
          disabled={isLoggingOut}
          className="flex items-center space-x-1 bg-green-600 hover:bg-green-700 px-3 py-1 rounded-md text-white text-sm transition-colors duration-200 disabled:opacity-70"
        >
          {isLoggingOut ? (
            <>
              <div className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full mr-1"></div>
              <span>{t('admin.loggingOut')}</span>
            </>
          ) : (
            <>
              <Unlock size={14} />
                                <span>{t('admin.title')}</span>
              <LogOut size={14} />
            </>
          )}
        </button>
      ) : (
        <button 
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center space-x-1 bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded-md text-white text-sm transition-colors duration-200"
        >
          <Lock size={14} />
                            <span>{t('admin.title')}</span>
        </button>
      )}

      {isOpen && !isAdmin && (
        <div className="absolute top-10 right-0 mt-2 bg-gray-800 border border-gray-700 rounded-md shadow-lg p-4 w-64 z-50">
          <h3 className="text-white font-medium mb-2">{t('admin.adminLogin')}</h3>
          <div className="space-y-3">
            <div>
              <input
                type="password"
                value={adminCode}
                onChange={(e) => setAdminCode(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder={t('admin.adminCode')}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
            </div>
            {error && <p className="text-red-500 text-xs">{error}</p>}
            <button
              onClick={handleAdminLogin}
              disabled={isLoading || !adminCode.trim()}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:opacity-70 px-3 py-2 rounded-md text-white transition-colors duration-200 flex items-center justify-center"
            >
              {isLoading ? (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
              ) : (
                {t('admin.verify')}
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminLogin; 
