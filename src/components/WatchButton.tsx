import React from 'react';
import { Plus, Check, Star, List } from 'lucide-react';
import { motion } from 'framer-motion';

interface WatchButtonProps {
  type: 'watchlist' | 'favorite' | 'watched';
  isActive: boolean;
  onClick: () => void;
  label: string;
}

const WatchButton: React.FC<WatchButtonProps> = ({ type, isActive, onClick, label }) => {
  const getIcon = () => {
    switch (type) {
      case 'watchlist':
        return isActive ? <Check className="w-4 h-4" /> : <Plus className="w-4 h-4" />;
      case 'favorite':
        return <Star className="w-4 h-4" fill={isActive ? 'currentColor' : 'none'} />;
      case 'watched':
        return <List className="w-4 h-4" fill={isActive ? 'currentColor' : 'none'} />;
    }
  };

  return (
    <motion.button
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
        isActive 
          ? 'bg-red-600 text-white' 
          : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
      }`}
    >
      {getIcon()}
      {label}
    </motion.button>
  );
};

export default WatchButton; 