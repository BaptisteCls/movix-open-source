import { useState, useEffect, useCallback } from 'react';
import { AntiSpoilerSettings } from '../components/AntiSpoilerSettings';

const STORAGE_KEY = 'anti_spoiler';

const DEFAULT_SETTINGS: AntiSpoilerSettings = {
  seasonImages: false,
  episodeNames: false,
  episodeImages: false,
  episodeOverviews: false,
  nextEpisodeInfo: false,
  enabled: false,
};

export const useAntiSpoilerSettings = () => {
  const [settings, setSettings] = useState<AntiSpoilerSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load settings from localStorage on mount
  useEffect(() => {
    try {
      const savedSettings = localStorage.getItem(STORAGE_KEY);
      if (savedSettings) {
        const parsedSettings = JSON.parse(savedSettings);
        // Merge with default settings to ensure all properties exist
        const mergedSettings = { ...DEFAULT_SETTINGS, ...parsedSettings };
        setSettings(mergedSettings);
      }
    } catch (error) {
      console.error('Error loading anti-spoiler settings:', error);
      // If there's an error, use default settings
      setSettings(DEFAULT_SETTINGS);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  // Save settings to localStorage whenever they change
  const updateSettings = useCallback((newSettings: AntiSpoilerSettings) => {
    try {
      setSettings(newSettings);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
    } catch (error) {
      console.error('Error saving anti-spoiler settings:', error);
    }
  }, []);

  // Reset settings to default
  const resetSettings = useCallback(() => {
    try {
      setSettings(DEFAULT_SETTINGS);
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error('Error resetting anti-spoiler settings:', error);
    }
  }, []);

  // Toggle a specific setting
  const toggleSetting = useCallback((key: keyof AntiSpoilerSettings) => {
    const newSettings = { ...settings, [key]: !settings[key] };
    updateSettings(newSettings);
  }, [settings, updateSettings]);

  // Check if a specific content should be hidden
  const shouldHide = useCallback((contentType: keyof Omit<AntiSpoilerSettings, 'enabled'>) => {
    return settings.enabled && settings[contentType];
  }, [settings]);

  // Get masked content for spoiler protection
  const getMaskedContent = useCallback((
    originalContent: string,
    contentType: keyof Omit<AntiSpoilerSettings, 'enabled'>,
    maskText?: string,
    episodeNumber?: number
  ) => {
    if (!shouldHide(contentType)) return originalContent;
    
    // Use episode number for episode names
    if (contentType === 'episodeNames' && episodeNumber) {
      return `Épisode ${episodeNumber}`;
    }
    
    // Use "Résumé caché" for episode overviews
    if (contentType === 'episodeOverviews') {
      return 'Résumé caché';
    }
    
    // Default mask text
    return maskText || '••••••';
  }, [shouldHide]);

  // Check if any spoiler protection is active
  const hasActiveSpoilerProtection = useCallback(() => {
    if (!settings.enabled) return false;
    
    return Object.entries(settings).some(([key, value]) => 
      key !== 'enabled' && value === true
    );
  }, [settings]);

  return {
    settings,
    isLoaded,
    updateSettings,
    resetSettings,
    toggleSetting,
    shouldHide,
    getMaskedContent,
    hasActiveSpoilerProtection,
  };
};

export default useAntiSpoilerSettings;