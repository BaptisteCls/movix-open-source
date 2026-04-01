import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';

const FloatingSuggestionButton: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [visible, setVisible] = useState(true);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    // Hide button on watch or watchparty pages
    const isWatchRoute = location.pathname.startsWith('/watch/');
    const isWatchPartyRoute = location.pathname.includes('/watchparty/room/');
    
    setVisible(!isWatchRoute && !isWatchPartyRoute);
  }, [location]);

  const handleClick = () => {
    if (collapsed) {
      // Si le bouton est replié, on le déplie d'abord
      setCollapsed(false);
    } else {
      // Sinon on navigue vers la page de suggestion
      navigate('/suggestion');
    }
  };

  const toggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation(); // Empêche le déclenchement du handleClick du bouton parent
    setCollapsed(!collapsed);
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          onClick={handleClick}
          className={`fixed right-6 bottom-20 md:right-8 md:bottom-8 z-50 bg-gradient-to-r from-red-600 to-purple-600 hover:from-red-700 hover:to-purple-700 text-white font-bold py-3 ${collapsed ? 'px-3' : 'px-5'} rounded-full shadow-lg flex items-center overflow-hidden`}
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
        >
          <span className="mr-2">🎬</span>
          <motion.div
            animate={{ width: collapsed ? 0 : 'auto', opacity: collapsed ? 0 : 1, marginRight: collapsed ? 0 : 8 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden whitespace-nowrap"
          >
            {t('suggestions.dontKnowWhatToWatch')}
          </motion.div>
          <motion.div
            onClick={toggleCollapse}
            className="flex items-center justify-center h-6 w-6 rounded-full bg-white/20 hover:bg-white/30 transition-colors cursor-pointer"
            animate={{ rotate: collapsed ? 180 : 0 }}
            transition={{ duration: 0.3 }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={collapsed ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"} />
            </svg>
          </motion.div>
        </motion.button>
      )}
    </AnimatePresence>
  );
};

export default FloatingSuggestionButton;
