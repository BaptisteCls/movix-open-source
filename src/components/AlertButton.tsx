import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Bell, BellRing } from 'lucide-react';
import { AlertService } from '../services/alertService';
import { AlertButtonProps } from '../types/alerts';
import AlertMenu from './AlertMenu';

const AlertButton: React.FC<AlertButtonProps> = ({
  showId,
  showName,
  season,
  episode,
  episodeName,
  airDate,
  className = ''
}) => {
  const { t } = useTranslation();
  const [hasAlert, setHasAlert] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  // Check if alert exists on component mount and when dependencies change
  useEffect(() => {
    setHasAlert(AlertService.hasAlert(showId, season, episode));
  }, [showId, season, episode]);

  const handleButtonClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent episode selection

    if (hasAlert) {
      // If alert exists, remove it
      const success = AlertService.removeAlert(AlertService.generateAlertId(showId, season, episode));
      if (success) {
        setHasAlert(false);
      }
    } else {
      // If no alert, show menu to create one
      setShowMenu(true);
    }
  };

  const handleConfirmAlert = (notifyBeforeDays: 0 | 1 | 2) => {
    const success = AlertService.addAlert(
      showId,
      showName,
      season,
      episode,
      episodeName,
      airDate,
      notifyBeforeDays
    );
    
    if (success) {
      setHasAlert(true);
    }
    
    setShowMenu(false);
  };

  const handleCloseMenu = () => {
    setShowMenu(false);
  };

  return (
    <>
      <motion.button
        onClick={handleButtonClick}
        className={`p-2 rounded transition-colors ${
          hasAlert 
            ? 'text-yellow-500 hover:text-yellow-400 hover:bg-yellow-500/10' 
            : 'text-gray-400 hover:text-yellow-500 hover:bg-gray-800'
        } ${className}`}
        title={hasAlert ? t('alerts.removeAlert') : t('alerts.createAlert')}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
      >
        {hasAlert ? (
          <BellRing className="w-4 h-4" />
        ) : (
          <Bell className="w-4 h-4" />
        )}
      </motion.button>

      <AlertMenu
        isOpen={showMenu}
        onClose={handleCloseMenu}
        onConfirm={handleConfirmAlert}
        showName={showName}
        season={season}
        episode={episode}
        episodeName={episodeName}
        airDate={airDate}
      />
    </>
  );
};

export default AlertButton;
