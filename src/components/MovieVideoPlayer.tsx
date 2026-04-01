import React, { useEffect } from 'react';
import { useAdFreePopup } from '../context/AdFreePopupContext';
import AdFreePlayerAds from './AdFreePlayerAds';

interface MovieVideoPlayerProps {
  children: React.ReactNode;
  selectedSource: string;
  playerData: {
    isLecteur6?: boolean; 
    isVIP?: boolean;
    isAdFree?: boolean;
    isSuperVideoOrDropload?: boolean;
  };
  onSelectSource: (source: string) => void;
}

const MovieVideoPlayer: React.FC<MovieVideoPlayerProps> = ({ 
  children, 
  selectedSource,
  playerData,
  onSelectSource
}) => {
  const { 
    showAdFreePopup, 
    adType, 
    playerToShow, 
    showPopupForPlayer, 
    handlePopupClose, 
    handlePopupAccept 
  } = useAdFreePopup();

  const shouldShowPopupForPlayer = (): boolean => {
    // Check if this is a lecteur6.com player
    if (playerData.isLecteur6) {
      return true;
    }
    
    // Check if this is supervideo or dropload
    if (playerData.isSuperVideoOrDropload) {
      return true;
    }
    
    // Check if this is a VIP player
    if (playerData.isVIP) {
      return true;
    }
    
    // Check if this is an ad-free player
    if (playerData.isAdFree) {
      return true;
    }
    
    return false;
  };

  // Set up the player when popup is accepted
  useEffect(() => {
    if (playerToShow) {
      onSelectSource(playerToShow);
    }
  }, [playerToShow, onSelectSource]);

  // Handle clicks on the video player button
  const handlePlayerSelection = (source: string) => {
    if (shouldShowPopupForPlayer()) {
      showPopupForPlayer(source);
    } else {
      onSelectSource(source);
    }
  };

  return (
    <>
      {children}
      
      {showAdFreePopup && (
        <AdFreePlayerAds
          onClose={handlePopupClose}
          onAccept={handlePopupAccept}
          adType={adType}
        />
      )}
    </>
  );
};

export default MovieVideoPlayer; 