import React from 'react';
import { Gauge, HelpCircle, Radio, ShieldAlert, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReusableModal from './ui/reusable-modal';

interface WatchPartySyncInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const WatchPartySyncInfoModal: React.FC<WatchPartySyncInfoModalProps> = ({
  isOpen,
  onClose
}) => {
  const { t } = useTranslation();

  const sections = [
    {
      icon: Zap,
      title: t('watchParty.syncHelpWhatChangesTitle'),
      items: [
        t('watchParty.syncHelpWhatChangesClassic'),
        t('watchParty.syncHelpWhatChangesPro')
      ]
    },
    {
      icon: Radio,
      title: t('watchParty.syncHelpWhenUseTitle'),
      items: [
        t('watchParty.syncHelpWhenUseClassic'),
        t('watchParty.syncHelpWhenUsePro')
      ]
    },
    {
      icon: Gauge,
      title: t('watchParty.syncHelpNumbersTitle'),
      items: [
        t('watchParty.syncHelpNumbersTarget'),
        t('watchParty.syncHelpNumbersSoft'),
        t('watchParty.syncHelpNumbersHard')
      ]
    },
    {
      icon: ShieldAlert,
      title: t('watchParty.syncHelpLimitsTitle'),
      items: [
        t('watchParty.syncHelpLimitsNetwork'),
        t('watchParty.syncHelpLimitsSource')
      ]
    }
  ];

  return (
    <ReusableModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('watchParty.syncModeHelpTitle')}
      className="max-w-3xl"
    >
      <div className="space-y-6 text-white">
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5">
          <div className="mb-2 flex items-center gap-2 text-red-200">
            <HelpCircle className="h-5 w-5" />
            <p className="text-sm font-semibold">{t('watchParty.syncModeHelpIntroTitle')}</p>
          </div>
          <p className="text-sm leading-6 text-red-100/85">
            {t('watchParty.syncModeHelpIntroBody')}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {sections.map(({ icon: Icon, title, items }) => (
            <div key={title} className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <div className="mb-3 flex items-center gap-2 text-white">
                <Icon className="h-5 w-5 text-red-400" />
                <h4 className="font-semibold">{title}</h4>
              </div>
              <div className="space-y-2 text-sm leading-6 text-white/75">
                {items.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ReusableModal>
  );
};

export default WatchPartySyncInfoModal;
