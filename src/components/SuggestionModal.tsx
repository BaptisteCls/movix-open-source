import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Lightbulb, AlertCircle, Film, Tv, Code, Sparkles, Settings, HelpCircle, User } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';

interface SuggestionModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SuggestionOption {
  id: string;
  icon: React.ReactNode;
  labelKey: string;
  descriptionKey: string;
}

const suggestionOptions: SuggestionOption[] = [
  {
    id: 'movie',
    icon: <Film className="w-5 h-5" />,
    labelKey: 'suggestions.movieSuggestion',
    descriptionKey: 'suggestions.movieSuggestionDesc'
  },
  {
    id: 'tv',
    icon: <Tv className="w-5 h-5" />,
    labelKey: 'suggestions.tvSuggestion',
    descriptionKey: 'suggestions.tvSuggestionDesc'
  },
  {
    id: 'feature',
    icon: <Sparkles className="w-5 h-5" />,
    labelKey: 'suggestions.newFeature',
    descriptionKey: 'suggestions.newFeatureDesc'
  },
  {
    id: 'improvement',
    icon: <Settings className="w-5 h-5" />,
    labelKey: 'suggestions.improvement',
    descriptionKey: 'suggestions.improvementDesc'
  },
  {
    id: 'bug',
    icon: <Code className="w-5 h-5" />,
    labelKey: 'suggestions.bugFix',
    descriptionKey: 'suggestions.bugFixDesc'
  },
  {
    id: 'other',
    icon: <HelpCircle className="w-5 h-5" />,
    labelKey: 'suggestions.otherSuggestion',
    descriptionKey: 'suggestions.otherSuggestionDesc'
  }
];

const SuggestionModal: React.FC<SuggestionModalProps> = ({
  isOpen,
  onClose
}) => {
  const { t } = useTranslation();
  const [selectedOption, setSelectedOption] = useState<string>('');
  const [suggestionText, setSuggestionText] = useState<string>('');
  const [discordUsername, setDiscordUsername] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedOption) {
      setError(t('suggestions.selectType'));
      return;
    }

    if (!suggestionText.trim()) {
      setError(t('suggestions.detailRequired'));
      return;
    }

    if (!discordUsername.trim()) {
      setError(t('suggestions.discordRequired'));
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const webhookUrl = 'https://discord.com/api/webhooks/1385981235884720159/MDUSAKeUZ4BQyNaNmkyNJAyiY9dp7iSXj-DklYpH8mVcydGS2XfzPfnEXXw99BG5yLHB';
      
      const selectedSuggestion = suggestionOptions.find(opt => opt.id === selectedOption);

      const message = {
        content: "<@921903529864613898>",
        embeds: [{
          title: `💡 ${t('suggestions.title')}`,
          color: 0x3498DB,
          fields: [
            {
              name: t('suggestions.suggestionType'),
              value: selectedSuggestion?.labelKey ? t(selectedSuggestion.labelKey) : selectedOption,
              inline: true
            },
            {
              name: 'Pseudo Discord',
              value: discordUsername,
              inline: true
            },
            {
              name: 'Détails',
              value: suggestionText
            },
            {
              name: 'Page source',
              value: window.location.href,
              inline: true
            }
          ],
          timestamp: new Date().toISOString()
        }]
      };

      await axios.post(webhookUrl, message);
      toast.success(t('suggestions.thankYou'));
      onClose();
      setSelectedOption('');
      setSuggestionText('');
      setDiscordUsername('');
    } catch (err) {
      toast.error(t('suggestions.sendError'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="relative w-full max-w-lg bg-gray-900 rounded-xl shadow-xl p-6 max-h-[90vh] overflow-y-auto"
          >
            <button
              onClick={onClose}
              className="absolute right-4 top-4 text-gray-400 hover:text-white transition-colors"
            >
              <X className="w-6 h-6" />
            </button>

            <div className="flex items-center gap-3 mb-6">
              <Lightbulb className="w-6 h-6 text-yellow-400" />
              <h2 className="text-xl font-bold text-white">
                {t('suggestions.makeASuggestion')}
              </h2>
            </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    {t('suggestions.suggestionType')}
                  </label>
                  <div className="grid grid-cols-1 gap-3">
                    {suggestionOptions.map((option) => (
                      <motion.button
                        key={option.id}
                        type="button"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setSelectedOption(option.id)}
                        className={`flex items-start gap-3 p-3 rounded-lg text-left transition-colors ${
                          selectedOption === option.id
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                        }`}
                      >
                        <div className="mt-0.5">{option.icon}</div>
                        <div>
                          <div className="font-medium">{t(option.labelKey)}</div>
                          <div className="text-sm opacity-80">{t(option.descriptionKey)}</div>
                        </div>
                      </motion.button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('suggestions.discordUsername')}
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <User className="h-5 w-5 text-gray-400" />
                    </div>
                    <input
                      type="text"
                      value={discordUsername}
                      onChange={(e) => setDiscordUsername(e.target.value)}
                      placeholder={t('suggestions.discordPlaceholder')}
                      className={`w-full bg-gray-800 text-white rounded-lg pl-10 pr-3 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none ${
                        !discordUsername.trim() && error ? 'border-2 border-red-500' : ''
                      }`}
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    {t('suggestions.discordHelp')}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {t('suggestions.descriptionLabel')}
                  </label>
                  <textarea
                    value={suggestionText}
                    onChange={(e) => setSuggestionText(e.target.value)}
                    placeholder={t('suggestions.descriptionPlaceholder')}
                    className={`w-full bg-gray-800 text-white rounded-lg px-3 py-2 h-32 focus:ring-2 focus:ring-blue-500 focus:outline-none resize-none ${
                      !suggestionText.trim() && error
                        ? 'border-2 border-red-500'
                        : ''
                    }`}
                  />
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-500 bg-red-500/10 p-3 rounded-lg">
                    <AlertCircle className="w-5 h-5" />
                    <p className="text-sm">{error}</p>
                  </div>
                )}

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  disabled={isSubmitting}
                  className={`w-full py-3 rounded-lg font-medium transition-colors ${
                    isSubmitting
                      ? 'bg-gray-600 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {isSubmitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                      {t('suggestions.sending')}
                    </span>
                  ) : (
                    t('suggestions.submitSuggestion')
                  )}
                </motion.button>
              </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SuggestionModal; 