import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Profile, ProfileContextType } from '../types/profile';
import axios from 'axios';
import { useLocation } from 'react-router-dom';
import i18n from '../i18n';
import { predefinedAvatars } from '../data/avatars';
import {
  getSyncableLocalStorageEntries,
  hasSyncableLocalStorageData,
  isSyncableStorageKey,
  shouldPreserveStorageKeyOnProfileLoad
} from '../utils/syncStorage';
import { checkVipStatus } from '../utils/vipUtils';

const API_URL = import.meta.env.VITE_MAIN_API;

const ProfileContext = createContext<ProfileContextType | undefined>(undefined);

interface ProfileProviderProps {
  children: ReactNode;
}

export const ProfileProvider: React.FC<ProfileProviderProps> = ({ children }) => {
  const [currentProfile, setCurrentProfile] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const location = useLocation();

  // Check if we're on a watch route - if so, disable profile data loading (but allow sync)
  const isWatchRoute = location.pathname.startsWith('/watch/');

  // Load profiles from server
  const loadProfiles = async () => {
    try {
      setIsLoading(true);
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;

      // For BIP39 users, ensure auth data is fully loaded
      const isBip39Auth = localStorage.getItem('bip39_auth') === 'true';
      if (isBip39Auth) {
        // Wait a bit more for BIP39 auth to be fully processed
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      const response = await axios.get(`${API_URL}/api/profiles`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data.success) {
        setProfiles(response.data.profiles);
        
        // If no profiles exist, try to migrate existing data
        if (response.data.profiles.length === 0) {
          // Keep loading state while creating profile
          setIsLoading(true);
          
          // Check if this is a new user (no existing data to migrate)
          const hasExistingData = await checkForExistingUserData();
          if (hasExistingData) {
            await migrateExistingData();
          } else {
            // For new users, create a default profile automatically
            await createDefaultProfileForNewUser();
          }
          return;
        }
        
        // If no current profile selected, select the default one
        const selectedProfileId = localStorage.getItem('selected_profile_id');
        if (selectedProfileId) {
          const selectedProfile = response.data.profiles.find((p: Profile) => p.id === selectedProfileId);
          if (selectedProfile) {
            setCurrentProfile(selectedProfile);
            // Load data for the selected profile (unless on watch route)
            if (!isWatchRoute) {
              await loadProfileData(selectedProfileId);
            } else {
              console.log('Skipping profile data loading for selected profile - on watch route');
            }
          }
        } else if (response.data.profiles.length > 0) {
          const defaultProfile = response.data.profiles.find((p: Profile) => p.isDefault) || response.data.profiles[0];
          setCurrentProfile(defaultProfile);
          localStorage.setItem('selected_profile_id', defaultProfile.id);
          // Load data for the default profile (unless on watch route)
          if (!isWatchRoute) {
            await loadProfileData(defaultProfile.id);
          } else {
            console.log('Skipping profile data loading for default profile - on watch route');
          }
        }
      }
    } catch (error) {
      console.error('Error loading profiles:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Check if user has existing data to migrate
  const checkForExistingUserData = async (): Promise<boolean> => {
    try {
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return false;

      return hasSyncableLocalStorageData();
    } catch (error) {
      console.error('Error checking for existing user data:', error);
      return false;
    }
  };

  // Create default profile for new users
  const createDefaultProfileForNewUser = async () => {
    try {
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;

      // Get user info for default profile name
      let defaultName = i18n.t('nav.profile');
      let defaultAvatar = predefinedAvatars[Math.floor(Math.random() * predefinedAvatars.length)];
      
      // Try to get username from auth data
      const authStr = localStorage.getItem('auth');
      if (authStr) {
        try {
          const authObj = JSON.parse(authStr);
          if (authObj.userProfile && authObj.userProfile.username) {
            defaultName = authObj.userProfile.username;
          }
          if (authObj.userProfile && authObj.userProfile.avatar) {
            defaultAvatar = authObj.userProfile.avatar;
          }
        } catch (e) {
          console.log('Could not parse auth data for default profile');
        }
      }

      console.log('Creating default profile for new user:', defaultName);

      const response = await axios.post(`${API_URL}/api/profiles`, {
        name: defaultName,
        avatar: defaultAvatar
      }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data.success) {
        const defaultProfile = response.data.profile;
        setProfiles([defaultProfile]);
        setCurrentProfile(defaultProfile);
        localStorage.setItem('selected_profile_id', defaultProfile.id);
        console.log('Default profile created for new user:', defaultProfile.name);
      }
    } catch (error) {
      console.error('Error creating default profile for new user:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Migrate existing user data to default profile
  const migrateExistingData = async () => {
    try {
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;

      // Collect all localStorage data for migration
      const userData = getSyncableLocalStorageEntries();

      const response = await axios.post(`${API_URL}/api/profiles/migrate`, {
        userData
      }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data.success) {
        const defaultProfile = response.data.profile;
        setProfiles([defaultProfile]);
        setCurrentProfile(defaultProfile);
        localStorage.setItem('selected_profile_id', defaultProfile.id);
        // Load the migrated data for the default profile (unless on watch route)
        if (!isWatchRoute) {
          await loadProfileData(defaultProfile.id);
        } else {
          console.log('Skipping profile data loading after migration - on watch route');
        }
        console.log('Data migrated to default profile:', defaultProfile.name);
      }
    } catch (error) {
      console.error('Error migrating data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Select a profile
  const selectProfile = async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (profile) {
      setCurrentProfile(profile);
      localStorage.setItem('selected_profile_id', profileId);
      
      // Load profile data from server and update localStorage (unless on watch route)
      if (!isWatchRoute) {
        await loadProfileData(profileId);
      } else {
        console.log('Skipping profile data loading on profile selection - on watch route');
      }
    }
  };

  // Load profile data from server and update localStorage
  const loadProfileData = async (profileId: string) => {
    try {
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) return;

      // Skip profile data loading on watch routes
      if (isWatchRoute) {
        console.log('Skipping profile data loading - on watch route');
        return;
      }

      // Signal that we're starting to load profile data
      if ((window as any).setProfileDataLoading) {
        (window as any).setProfileDataLoading(true);
      }

      const response = await axios.get(`${API_URL}/api/profiles/${profileId}/data`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data.success && response.data.data) {
        // Get all current localStorage keys
        const allKeys = Object.keys(localStorage);
        
        // Remove keys that are not in the keep list
        allKeys.forEach(key => {
          if (!shouldPreserveStorageKeyOnProfileLoad(key)) {
            localStorage.removeItem(key);
          }
        });

        // Load profile data into localStorage
        const profileData = response.data.data;
        Object.entries(profileData).forEach(([key, value]) => {
          if (typeof value === 'string' && isSyncableStorageKey(key)) {
            localStorage.setItem(key, value);
          }
        });

        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new CustomEvent('sync_storage_updated'));

        if (localStorage.getItem('access_code')) {
          checkVipStatus(true).catch(() => { /* ignore */ });
        } else {
          window.dispatchEvent(new CustomEvent('vipStatusChanged', { detail: { vip: false } }));
        }
        
        console.log('Profile data loaded for profile:', profileId);
      }
    } catch (error) {
      console.error('Error loading profile data:', error);
    } finally {
      // Signal that we're done loading profile data
      if ((window as any).setProfileDataLoading) {
        (window as any).setProfileDataLoading(false);
      }
    }
  };

  // Create a new profile
  const createProfile = async (name: string, avatar: string, ageRestriction?: number) => {
    try {
      setIsLoading(true);
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) throw new Error('No auth token');

      const response = await axios.post(`${API_URL}/api/profiles`, {
        name,
        avatar,
        ageRestriction: ageRestriction ?? 0
      }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data.success) {
        const newProfile = response.data.profile;
        setProfiles(prev => [...prev, newProfile]);
        
        // If this is the first profile, select it
        if (profiles.length === 0) {
          setCurrentProfile(newProfile);
          localStorage.setItem('selected_profile_id', newProfile.id);
        }
      }
    } catch (error) {
      console.error('Error creating profile:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Update a profile
  const updateProfile = async (profileId: string, updates: Partial<Profile>) => {
    try {
      setIsLoading(true);
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) throw new Error('No auth token');

      const response = await axios.put(`${API_URL}/api/profiles/${profileId}`, updates, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data.success) {
        const updatedProfile = response.data.profile;
        setProfiles(prev => prev.map(p => p.id === profileId ? updatedProfile : p));
        
        // Update current profile if it's the one being updated
        if (currentProfile?.id === profileId) {
          setCurrentProfile(updatedProfile);
        }
      }
    } catch (error) {
      console.error('Error updating profile:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Delete a profile
  const deleteProfile = async (profileId: string) => {
    try {
      setIsLoading(true);
      const authToken = localStorage.getItem('auth_token');
      if (!authToken) throw new Error('No auth token');

      const response = await axios.delete(`${API_URL}/api/profiles/${profileId}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (response.data.success) {
        // Check if server created a new default profile
        if (response.data.newDefaultProfile) {
          // Server created a new default profile, use it directly
          const newDefaultProfile = response.data.newDefaultProfile;
          setProfiles([newDefaultProfile]);
          setCurrentProfile(newDefaultProfile);
          localStorage.setItem('selected_profile_id', newDefaultProfile.id);
          console.log('New default profile created by server:', newDefaultProfile.name);
        } else {
          // Reload profiles from server to get updated default status
          const profilesResponse = await axios.get(`${API_URL}/api/profiles`, {
            headers: { Authorization: `Bearer ${authToken}` }
          });
          
          if (profilesResponse.data.success) {
            const updatedProfiles = profilesResponse.data.profiles;
            setProfiles(updatedProfiles);
            
            // If deleted profile was current, select the default one
            if (currentProfile?.id === profileId) {
              if (updatedProfiles.length > 0) {
                const newCurrent = updatedProfiles.find((p: Profile) => p.isDefault) || updatedProfiles[0];
                setCurrentProfile(newCurrent);
                localStorage.setItem('selected_profile_id', newCurrent.id);
                // Load data for the new current profile (unless on watch route)
                if (!isWatchRoute) {
                  await loadProfileData(newCurrent.id);
                } else {
                  console.log('Skipping profile data loading after profile deletion - on watch route');
                }
              } else {
                // No profiles left, create a new default profile automatically
                console.log('No profiles left, creating new default profile...');
                await createDefaultProfileForNewUser();
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Error deleting profile:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Load profiles on mount with delay for BIP39 users
  useEffect(() => {
    // Add a small delay to ensure auth data is fully loaded
    const timer = setTimeout(() => {
      loadProfiles();
    }, 100);

    return () => clearTimeout(timer);
  }, [isWatchRoute]);

  // Listen for auth changes to reload profiles
  useEffect(() => {
    const handleAuthChange = () => {
      // Reload profiles when auth changes (especially for BIP39)
      setTimeout(() => {
        loadProfiles();
      }, 500);
    };

    window.addEventListener('auth_changed', handleAuthChange);
    return () => window.removeEventListener('auth_changed', handleAuthChange);
  }, [isWatchRoute]);

  const value: ProfileContextType = {
    currentProfile,
    profiles,
    selectProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    isLoading
  };

  return (
    <ProfileContext.Provider value={value}>
      {children}
    </ProfileContext.Provider>
  );
};

export const useProfile = (): ProfileContextType => {
  const context = useContext(ProfileContext);
  if (context === undefined) {
    throw new Error('useProfile must be used within a ProfileProvider');
  }
  return context;
};
