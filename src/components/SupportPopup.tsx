import React from 'react';
import { useSupportPopup } from '../context/SupportPopupContext';
import { useTranslation } from 'react-i18next';

const SupportPopup: React.FC = () => {
  const { t } = useTranslation();
  const { isPopupVisible, hidePopup } = useSupportPopup();

  if (!isPopupVisible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-80 backdrop-blur-sm transition-opacity animate-fadeIn">
      <div className="bg-[#121212] p-8 rounded-2xl shadow-[0_0_30px_rgba(0,0,0,0.7)] max-w-md w-full mx-4 transform transition-all animate-support-popup border border-[#333] relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-gradient-to-br from-blue-600/20 to-purple-600/20 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-gradient-to-tr from-red-600/20 to-amber-600/20 rounded-full blur-3xl"></div>
        <div className="relative z-10">
          <div className="flex justify-end">
            <button 
              onClick={hidePopup}
              className="text-gray-500 hover:text-white transition-colors rounded-full p-1 hover:bg-white/10"
              aria-label={t('common.close')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        
          <div className="flex items-center justify-center mb-6">
            <span className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center shadow-lg shadow-blue-500/20">
              <span className="text-3xl">🎬</span>
            </span>
          </div>
          
          <h2 className="text-2xl font-bold text-center mb-5 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">{t('support.likeOurSite')} ✨</h2>
          
          <div className="text-center mb-8 space-y-4">
            <p className="text-lg font-medium text-white/90">
              {t('support.wantToSupport')} 💙
            </p>
            <p className="text-gray-300 mb-3">
              {t('support.shareTikTok')} 📱 🔥
            </p>
            <div className="bg-gradient-to-r from-blue-900/40 to-purple-900/40 p-4 rounded-xl border border-blue-500/20">
              <p className="font-semibold text-transparent bg-clip-text bg-gradient-to-r from-amber-300 to-yellow-200">
                {t('support.tikTokReward')} 🎁 🔑 🚀
              </p>
            </div>
          </div>
        
          <div className="flex justify-center">
            <button
              onClick={hidePopup}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold py-3 px-8 rounded-full transition-all duration-300 shadow-lg shadow-blue-600/20 hover:shadow-blue-700/30 transform hover:-translate-y-1"
            >
              {t('common.understood')} 👍
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SupportPopup;
