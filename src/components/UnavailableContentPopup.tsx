import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

interface UnavailableContentPopupProps {
  mediaType: 'film' | 'série';
  onClose: () => void;
}

const UnavailableContentPopup: React.FC<UnavailableContentPopupProps> = ({ mediaType, onClose }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-gray-800 rounded-lg p-6 max-w-md w-full relative"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white"
        >
          <X size={24} />
        </button>

        <h2 className="text-xl font-bold mb-4">{t('unavailableContent.title')}</h2>
        <p className="text-gray-300 mb-6">
          {t('unavailableContent.notYetAvailable', { mediaType })}
        </p>

        <div className="flex justify-end gap-4">
          <button
            onClick={() => navigate(-1)}
            className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors"
          >
            {t('unavailableContent.goBack')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default UnavailableContentPopup; 