import React from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useProfile } from '../context/ProfileContext';

interface ProfileSwitcherProps {
  className?: string;
}

const ProfileSwitcher: React.FC<ProfileSwitcherProps> = ({ className = '' }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentProfile } = useProfile();

  if (!currentProfile) return null;

  const handleSwitchProfile = () => {
    navigate('/profile-selection');
  };

  return (
    <motion.button
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      onClick={handleSwitchProfile}
      className={`flex items-center space-x-3 p-2 rounded-lg hover:bg-gray-800 transition-colors ${className}`}
      title={t('profile.switchProfile')}
    >
      <div className="w-8 h-8 rounded-lg overflow-hidden ring-2 ring-gray-600">
        <img
          src={currentProfile.avatar}
          alt={currentProfile.name}
          className="w-full h-full object-cover"
        />
      </div>
      <div className="text-left">
        <div className="text-sm font-medium text-white">{currentProfile.name}</div>
        <div className="text-xs text-gray-400">{t('profile.switchProfile')}</div>
      </div>
    </motion.button>
  );
};

export default ProfileSwitcher;
