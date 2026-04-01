import { GOOGLE_CONFIG } from '../config/google';
import { clearPendingAuthAction, setPendingAuthLink } from '../utils/accountAuth';

interface GoogleLoginOptions {
  mode?: 'login' | 'link';
  returnTo?: string;
}

export const googleAuth = {
  login: (options: GoogleLoginOptions = {}) => {
    if (options.mode === 'link') {
      setPendingAuthLink('google', options.returnTo);
    } else {
      clearPendingAuthAction();
    }

    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CONFIG.CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_CONFIG.REDIRECT_URI)}&response_type=token&scope=${encodeURIComponent(GOOGLE_CONFIG.SCOPES.join(' '))}`;
    window.location.href = googleAuthUrl;
  }
};
