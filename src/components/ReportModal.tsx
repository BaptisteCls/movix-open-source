import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'framer-motion';
import { X, AlertTriangle, AlertCircle, Play, Volume2, Subtitles, Video, Link2, HelpCircle, User } from 'lucide-react';
import axios from 'axios';
import { toast } from 'sonner';
import { getTmdbLanguage } from '../i18n';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

interface ReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  mediaType: 'movie' | 'tv';
  mediaTitle: string;
  mediaId: string;
  seasonNumber?: number;
  episodeNumber?: number;
  totalSeasons?: number;
}

interface Episode {
  episode_number: number;
  name: string;
}

interface Season {
  episodes: Episode[];
}

interface ReportOption {
  id: string;
  icon: React.ReactNode;
  labelKey: string;
  descriptionKey: string;
}

const reportOptions: ReportOption[] = [
  {
    id: 'player',
    icon: <Play className="w-5 h-5" />,
    labelKey: 'report.playerIssue',
    descriptionKey: 'report.playerIssueDesc'
  },
  {
    id: 'audio',
    icon: <Volume2 className="w-5 h-5" />,
    labelKey: 'report.audioIssue',
    descriptionKey: 'report.audioIssueDesc'
  },
  {
    id: 'subtitles',
    icon: <Subtitles className="w-5 h-5" />,
    labelKey: 'report.subtitleIssueLabel',
    descriptionKey: 'report.subtitleIssueDesc'
  },
  {
    id: 'quality',
    icon: <Video className="w-5 h-5" />,
    labelKey: 'report.qualityIssue',
    descriptionKey: 'report.qualityIssueDesc'
  },
  {
    id: 'link',
    icon: <Link2 className="w-5 h-5" />,
    labelKey: 'report.deadLink',
    descriptionKey: 'report.deadLinkDesc'
  },
  {
    id: 'other',
    icon: <HelpCircle className="w-5 h-5" />,
    labelKey: 'report.otherIssue',
    descriptionKey: 'report.otherIssueDesc'
  }
];

const ReportModal: React.FC<ReportModalProps> = ({
  isOpen,
  onClose,
  mediaType,
  mediaTitle,
  mediaId,
  seasonNumber,
  episodeNumber,
  totalSeasons
}) => {
  const { t } = useTranslation();
  const [selectedSeason, setSelectedSeason] = useState<number>(seasonNumber || 1);
  const [selectedEpisode, setSelectedEpisode] = useState<number>(episodeNumber || 1);
  const [selectedOption, setSelectedOption] = useState<string>('');
  const [reportReason, setReportReason] = useState<string>('');
  const [discordUsername, setDiscordUsername] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seasonData, setSeasonData] = useState<Season | null>(null);
  const [isLoadingEpisodes, setIsLoadingEpisodes] = useState(false);

  const fetchSeasonData = async (seasonNum: number) => {
    setIsLoadingEpisodes(true);
    try {
      const response = await axios.get(
        `https://api.themoviedb.org/3/tv/${mediaId}/season/${seasonNum}`,
        {
          params: {
            api_key: TMDB_API_KEY,
            language: getTmdbLanguage()
          }
        }
      );
      setSeasonData(response.data);
      // Si l'épisode sélectionné n'existe pas dans la nouvelle saison,
      // sélectionner le premier épisode
      if (!response.data.episodes.find((ep: Episode) => ep.episode_number === selectedEpisode)) {
        setSelectedEpisode(1);
      }
    } catch (error) {
      console.error('Erreur lors du chargement des épisodes:', error);
      setSeasonData(null);
    } finally {
      setIsLoadingEpisodes(false);
    }
  };

  useEffect(() => {
    if (mediaType === 'tv' && selectedSeason) {
      fetchSeasonData(selectedSeason);
    }
  }, [mediaType, selectedSeason, mediaId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!selectedOption) {
      setError(t('report.selectIssueType'));
      return;
    }

    if (selectedOption === 'other' && !reportReason.trim()) {
      setError(t('report.otherDetailRequired'));
      return;
    }

    if (!discordUsername.trim()) {
      setError(t('report.discordUsernameRequired'));
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const webhookUrl = 'https://discord.com/api/webhooks/1385981466038501537/XBxu1bIf-KOMy5f5W98UQ2Gr1lNsJppYPsHDBVVVzs9AfY-mjtYXHGb5OnnfI6ljW0_3';
      
      const contentUrl = `${window.location.origin}/${mediaType}/${mediaId}${
        mediaType === 'tv' && selectedSeason && selectedEpisode
          ? `?season=${selectedSeason}&episode=${selectedEpisode}`
          : ''
      }`;

      const selectedProblem = reportOptions.find(opt => opt.id === selectedOption);

      const message = {
        content: "<@921903529864613898>",
        embeds: [{
          title: `🚨 ${t('report.newReport')}`,
          color: 0xFF0000,
          fields: [
            {
              name: 'Type',
              value: mediaType === 'movie' ? t('report.film') : t('report.serie'),
              inline: true
            },
            {
              name: 'Titre',
              value: mediaTitle,
              inline: true
            },
            {
              name: 'ID TMDB',
              value: mediaId,
              inline: true
            },
            {
              name: 'Pseudo Discord',
              value: discordUsername,
              inline: true
            },
            ...(mediaType === 'tv' ? [
              {
                name: t('report.season'),
                value: selectedSeason.toString(),
                inline: true
              },
              {
                name: t('report.episode'),
                value: selectedEpisode.toString(),
                inline: true
              }
            ] : []),
            {
              name: t('report.issueType'),
              value: selectedProblem?.labelKey ? t(selectedProblem.labelKey) : selectedOption,
              inline: true
            },
            {
              name: t('report.link'),
              value: contentUrl
            },
            {
              name: t('report.details'),
              value: reportReason || t('report.noAdditionalDescription')
            }
          ],
          timestamp: new Date().toISOString(),
          url: contentUrl
        }]
      };

      await axios.post(webhookUrl, message);
      toast.success(t('report.thankYou'));
      onClose();
      setSelectedOption('');
      setReportReason('');
      setDiscordUsername('');
    } catch (err) {
      toast.error(t('report.sendError'));
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
              <AlertTriangle className="w-6 h-6 text-yellow-500" />
              <h2 className="text-xl font-bold text-white">
                {t('report.reportProblem')}
              </h2>
            </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                {mediaType === 'tv' && (
                  <div className="space-y-4">
                    <div className="p-4 bg-gray-800/50 rounded-lg">
                      <div className="mb-4">
                        <label className="block text-sm font-medium text-gray-300 mb-1">
                          {t('report.season')}
                        </label>
                        <select
                          value={selectedSeason}
                          onChange={(e) => setSelectedSeason(Number(e.target.value))}
                          className="w-full bg-gray-800 text-white rounded-lg px-3 py-2 focus:ring-2 focus:ring-red-500 focus:outline-none"
                        >
                          {[...Array(totalSeasons)].map((_, i) => (
                            <option key={i + 1} value={i + 1}>
                              {t('report.season')} {i + 1}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">
                          {t('report.episode')}
                        </label>
                        {isLoadingEpisodes ? (
                          <div className="flex items-center justify-center py-4">
                            <svg className="animate-spin h-5 w-5 text-red-500" viewBox="0 0 24 24">
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
                          </div>
                        ) : seasonData?.episodes ? (
                          <div className="grid grid-cols-4 gap-2">
                            {seasonData.episodes.map((episode) => (
                              <motion.button
                                key={episode.episode_number}
                                type="button"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => setSelectedEpisode(episode.episode_number)}
                                className={`p-2 rounded-lg text-center transition-colors ${
                                  selectedEpisode === episode.episode_number
                                    ? 'bg-red-600 text-white'
                                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'
                                }`}
                              >
                                <span className="block font-medium">{t('report.ep')} {episode.episode_number}</span>
                                <span className="text-xs opacity-75 line-clamp-1" title={episode.name}>
                                  {episode.name}
                                </span>
                              </motion.button>
                            ))}
                          </div>
                        ) : (
                          <div className="text-center py-4 text-gray-400">
                            {t('report.unableToLoadEpisodes')}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    {t('report.issueType')}
                  </label>
                  <div className="grid grid-cols-1 gap-3">
                    {reportOptions.map((option) => (
                      <motion.button
                        key={option.id}
                        type="button"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setSelectedOption(option.id)}
                        className={`flex items-start gap-3 p-3 rounded-lg text-left transition-colors ${
                          selectedOption === option.id
                            ? 'bg-red-600 text-white'
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
                    {t('report.discordUsername')}
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <User className="h-5 w-5 text-gray-400" />
                    </div>
                    <input
                      type="text"
                      value={discordUsername}
                      onChange={(e) => setDiscordUsername(e.target.value)}
                      placeholder={t('report.discordUsernamePlaceholder')}
                      className={`w-full bg-gray-800 text-white rounded-lg pl-10 pr-3 py-2 focus:ring-2 focus:ring-red-500 focus:outline-none ${
                        !discordUsername.trim() && error ? 'border-2 border-red-500' : ''
                      }`}
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    {t('report.discordUsernameHelp')}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    {selectedOption === 'other' ? t('report.descriptionRequired') : t('report.descriptionOptional')}
                  </label>
                  <textarea
                    value={reportReason}
                    onChange={(e) => setReportReason(e.target.value)}
                    placeholder={
                      selectedOption === 'other'
                        ? t('report.otherDescPlaceholder')
                        : t('report.descPlaceholder')
                    }
                    className={`w-full bg-gray-800 text-white rounded-lg px-3 py-2 h-24 focus:ring-2 focus:ring-red-500 focus:outline-none resize-none ${
                      selectedOption === 'other' && !reportReason.trim()
                        ? 'border-2 border-red-500'
                        : ''
                    }`}
                  />
                  {selectedOption === 'other' && !reportReason.trim() && (
                    <p className="mt-1 text-sm text-red-500">
                      {t('report.detailedDescRequired')}
                    </p>
                  )}
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
                      : 'bg-red-600 hover:bg-red-700'
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
                      {t('report.sending')}
                    </span>
                  ) : (
                    t('report.submit')
                  )}
                </motion.button>
              </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default ReportModal; 