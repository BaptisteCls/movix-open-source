import React from 'react';
import { useTranslation } from 'react-i18next';

const DMCA: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="w-full relative z-10 px-10">
        <div className="mt-32 pb-20 relative w-full max-w-[640px] mx-auto">
          <span className="sm:text-5xl text-4xl font-bold mb-6 text-white text-center block">
            DMCA
          </span>

          <p className="text-gray-300 font-medium mt-10 opacity-75">
            {t('dmca.intro')}
          </p>

          <p className="text-gray-300 font-medium mt-6 opacity-75">
            {t('dmca.noStorage')}
          </p>

          <p className="text-gray-300 font-medium mt-6 opacity-75">
            {t('dmca.aggregator')}
          </p>

          <p className="text-gray-300 font-medium mt-6 opacity-75">
            {t('dmca.dmcaNoticeIntro')}
            <ul className="list-disc mt-4 pl-4">
              <li className="list-disc">{t('dmca.dmcaReq1')}</li>
              <li className="list-disc">{t('dmca.dmcaReq2')}</li>
              <li className="list-disc">{t('dmca.dmcaReq3')}</li>
              <li className="list-disc">{t('dmca.dmcaReq4')}</li>
            </ul>
          </p>

          <p className="text-gray-300 font-medium mt-6">
            {t('dmca.thirdPartyWarning')}
          </p>

          <p className="text-gray-300 font-medium mt-6 opacity-75">
            {t('dmca.thanks')}
          </p>

          <a className="mt-8 block" href="mailto:movixstreaming@gmail.com">
            <button className="flex items-center justify-center font-medium whitespace-nowrap relative overflow-hidden transition-all h-10 text-sm px-4 rounded-md bg-white text-black hover:bg-white/80 focus-visible:outline-white cursor-pointer">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-mail size-4 mr-2 stroke-black">
                <rect width="20" height="16" x="2" y="4" rx="2"></rect>
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"></path>
              </svg>
              movixstreaming@gmail.com
            </button>
          </a>
        </div>
      </div>
    </div>
  );
};

export default DMCA;
