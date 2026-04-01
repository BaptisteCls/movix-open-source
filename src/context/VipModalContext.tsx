import React, { createContext, useContext, useState } from 'react';
import VipModal from '../components/VipModal';

interface VipModalContextType {
  isVipModalOpen: boolean;
  openVipModal: () => void;
  closeVipModal: () => void;
}

const VipModalContext = createContext<VipModalContextType | undefined>(undefined);

export const useVipModal = () => {
  const context = useContext(VipModalContext);
  if (context === undefined) {
    throw new Error('useVipModal must be used within a VipModalProvider');
  }
  return context;
};

export const VipModalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isVipModalOpen, setIsVipModalOpen] = useState(false);

  const openVipModal = () => {
    setIsVipModalOpen(true);
  };

  const closeVipModal = () => {
    setIsVipModalOpen(false);
  };

  return (
    <VipModalContext.Provider 
      value={{ 
        isVipModalOpen, 
        openVipModal, 
        closeVipModal 
      }}
    >
      {children}
      <VipModal isOpen={isVipModalOpen} onClose={closeVipModal} />
    </VipModalContext.Provider>
  );
}; 