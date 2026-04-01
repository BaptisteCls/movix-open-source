// Fonction pour obtenir l'URL de redirection de manière dynamique
const getRedirectUri = () => {
  // Utiliser le domaine actuel du site dans tous les cas
  // Tous les domaines sont maintenant configurés dans Google Cloud Console
  return `${window.location.origin}/auth/google`;
};

export const GOOGLE_CONFIG = {
  CLIENT_ID: '803260771655-6uk6p477ec6im3th4qe9mh8emakes0ja.apps.googleusercontent.com',
  
  get REDIRECT_URI() {
    return getRedirectUri();
  },
  SCOPES: ['email', 'profile']
}; 