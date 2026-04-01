import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { Share2, Facebook, Twitter, Link as LinkIcon, Check, X } from 'lucide-react';

interface ShareButtonsProps {
  title: string;
  description?: string;
  imageUrl?: string;
  url?: string;
}

const ShareButtons: React.FC<ShareButtonsProps> = ({ title, description = '', url = '' }) => {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  
  const baseShareUrl = url || window.location.href;
  const shareLanguage = i18n.language.toLowerCase().startsWith('en') ? 'en' : 'fr';

  const buildLocalizedShareUrl = () => {
    try {
      const parsedUrl = new URL(baseShareUrl, window.location.origin);
      parsedUrl.searchParams.set('lang', shareLanguage);
      return parsedUrl.toString();
    } catch {
      return baseShareUrl;
    }
  };

  const shareUrl = buildLocalizedShareUrl();
  const shareText = `${title}${description ? ` - ${description.replace(/\s+/g, ' ').trim()}` : ''}`;
  
  const shareOnFacebook = () => {
    const url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}&quote=${encodeURIComponent(title)}`;
    window.open(url, '_blank', 'width=600,height=400');
  };
  
  const shareOnTwitter = () => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`;
    window.open(url, '_blank', 'width=600,height=400');
  };
  
  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
    }, 300);
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy: ', err);
    }
  };
  
  return (
    <>
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg"
      >
        <Share2 className="w-4 h-4" />
        {t('common.share')}
      </motion.button>
      
      <AnimatePresence mode="wait">
        {isOpen && !isClosing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-[100000]"
            onClick={handleClose}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="bg-gray-800 rounded-2xl p-6 w-full max-w-md relative"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold text-white">{t('share.title')}</h3>
                <button 
                  onClick={handleClose}
                  className="text-gray-400 hover:text-white p-2 rounded-lg hover:bg-gray-700 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              
              <div className="flex flex-col space-y-4">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={shareOnFacebook}
                  className="flex items-center gap-4 p-4 hover:bg-gray-700 rounded-xl transition-colors"
                >
                  <Facebook className="text-[#1877F2]" size={24} />
                  <span className="text-white font-medium">Facebook</span>
                </motion.button>
                
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={shareOnTwitter}
                  className="flex items-center gap-4 p-4 hover:bg-gray-700 rounded-xl transition-colors"
                >
                  <Twitter className="text-[#1DA1F2]" size={24} />
                  <span className="text-white font-medium">Twitter</span>
                </motion.button>
                
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={copyToClipboard}
                  className="flex items-center gap-4 p-4 hover:bg-gray-700 rounded-xl transition-colors"
                >
                  {copySuccess ? (
                    <Check className="text-green-500" size={24} />
                  ) : (
                    <LinkIcon className="text-gray-300" size={24} />
                  )}
                  <span className="text-white font-medium">{copySuccess ? t('common.copied') : t('share.copyLink')}</span>
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default ShareButtons; 
