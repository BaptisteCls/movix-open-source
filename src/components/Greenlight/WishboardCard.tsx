import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ArrowBigUp, Film, Tv, Calendar, Check, Clock, Search, X, AlertCircle, MessageSquare } from 'lucide-react';
import { Badge } from '../ui/badge';
import Counter from '../ui/counter';
import { WishboardNote } from './WishboardDetailsModal';


// Helper function to calculate places array based on value
const getPlacesForValue = (value: number): number[] => {
    if (value === 0) return [1];
    const digits = Math.floor(Math.log10(Math.max(1, value))) + 1;
    const places: number[] = [];
    for (let i = digits - 1; i >= 0; i--) {
        places.push(Math.pow(10, i));
    }
    return places;
};

interface WishboardCardProps {
    id: number;
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    seasonNumber?: number | null;
    status: 'pending' | 'not_found' | 'not_found_recent' | 'searching' | 'added' | 'rejected';
    voteCount: number;
    hasVoted: boolean;
    title: string;
    year: string;
    posterPath: string | null;
    notes?: WishboardNote[];
    onVote: (id: number) => void;
    onUnvote: (id: number) => void;
    onClick?: () => void;
}

const statusLabels: Record<string, string> = {
    pending: 'greenlight.underReview',
    not_found: 'greenlight.notFoundStatus',
    not_found_recent: 'greenlight.notFoundStatus',
    searching: 'greenlight.scouting',
    added: 'greenlight.greenlighted',
    rejected: 'greenlight.rejectedStatus',
};

const statusIcons: Record<string, React.ReactNode> = {
    pending: <Clock className="w-3 h-3" />,
    not_found: <X className="w-3 h-3" />,
    not_found_recent: <AlertCircle className="w-3 h-3" />,
    searching: <Search className="w-3 h-3" />,
    added: <Check className="w-3 h-3" />,
    rejected: <X className="w-3 h-3" />,
};

export const WishboardCard: React.FC<WishboardCardProps> = ({
    id,
    mediaType,
    seasonNumber,
    status,
    voteCount,
    hasVoted,
    title,
    year,
    posterPath,
    notes,
    onVote,
    onUnvote,
    onClick,
}) => {
    const { t } = useTranslation();
    const [isVoting, setIsVoting] = useState(false);
    const [localVoteCount, setLocalVoteCount] = useState(voteCount);
    const [localHasVoted, setLocalHasVoted] = useState(hasVoted);

    useEffect(() => {
        setLocalVoteCount(voteCount);
        setLocalHasVoted(hasVoted);
    }, [voteCount, hasVoted]);

    const handleVote = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (isVoting) return;

        setIsVoting(true);
        try {
            if (localHasVoted) {
                setLocalVoteCount(prev => prev - 1);
                setLocalHasVoted(false);
                await onUnvote(id);
            } else {
                setLocalVoteCount(prev => prev + 1);
                setLocalHasVoted(true);
                await onVote(id);
            }
        } catch {
            // Revert on error
            if (localHasVoted) {
                setLocalVoteCount(prev => prev + 1);
                setLocalHasVoted(true);
            } else {
                setLocalVoteCount(prev => prev - 1);
                setLocalHasVoted(false);
            }
        } finally {
            setIsVoting(false);
        }
    };

    const posterUrl = posterPath
        ? `https://image.tmdb.org/t/p/w342${posterPath}`
        : null;

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            whileHover={{ y: -4 }}
            transition={{ duration: 0.2 }}
            className="group relative flex cursor-pointer flex-col"
            onClick={onClick}
        >
            <div className="relative w-full rounded-lg overflow-hidden">
                {/* Placeholder background */}
                <div className="absolute inset-0 bg-gray-800 rounded-lg flex items-center justify-center">
                    {mediaType === 'movie' ? (
                        <Film className="w-10 h-10 opacity-20 text-white" />
                    ) : (
                        <Tv className="w-10 h-10 opacity-20 text-white" />
                    )}
                </div>

                {/* Poster */}
                <div className="relative aspect-[2/3] overflow-hidden rounded-lg">
                    {posterUrl && (
                        <motion.img
                            src={posterUrl}
                            alt={title}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.3 }}
                        />
                    )}

                    {/* Hover overlay */}
                    <motion.div
                        className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                    />

                    {/* Top badges */}
                    <div className="absolute left-2 top-2 z-30 flex flex-col items-start gap-2">
                        <Badge variant={mediaType}>
                            {mediaType === 'movie' ? (
                                <><Film className="w-3 h-3 mr-1" /> {t('admin.movie')}</>
                            ) : (
                                <><Tv className="w-3 h-3 mr-1" /> {t('admin.tvShow')}</>
                            )}
                        </Badge>

                        {seasonNumber && (
                            <Badge variant="default">
                                <Calendar className="w-3 h-3 mr-1" /> {t('greenlight.season')} {seasonNumber}
                            </Badge>
                        )}

                        <Badge variant={status}>
                            {statusIcons[status]}
                            <span className="ml-1">{t(statusLabels[status])}</span>
                        </Badge>
                    </div>

                    {/* Vote button */}
                    <div className="absolute bottom-2 left-2 right-2 z-30">
                        <motion.button
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={handleVote}
                            disabled={isVoting}
                            className={`
                flex items-center justify-center w-full font-medium 
                rounded-lg h-10 px-4 text-sm backdrop-blur-sm
                transition-all duration-200
                ${localHasVoted
                                    ? 'bg-green-600 text-white shadow-lg shadow-green-500/20'
                                    : 'bg-black/60 text-white hover:bg-black/80 backdrop-blur-md border border-white/10'
                                }
                ${isVoting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
                        >
                            <motion.div
                                animate={localHasVoted ? { scale: [1, 1.3, 1] } : {}}
                                transition={{ duration: 0.3 }}
                            >
                                <ArrowBigUp className={`w-5 h-5 mr-1 ${localHasVoted ? 'fill-white' : ''}`} />
                            </motion.div>
                            <div className="relative overflow-hidden flex items-center justify-center ml-1" style={{ minWidth: '1ch' }}>
                                <Counter
                                    value={localVoteCount}
                                    fontSize={14}
                                    padding={0}
                                    places={getPlacesForValue(Math.max(localVoteCount, 1))}
                                    gap={0}
                                    borderRadius={0}
                                    horizontalPadding={0}
                                    textColor="currentColor"
                                    fontWeight="600"
                                    gradientHeight={0}
                                />
                            </div>
                        </motion.button>
                    </div>
                </div>
            </div>

            {/* Info */}
            <div className="mt-2 flex flex-col gap-0.5">
                <p className="line-clamp-2 text-sm font-semibold leading-tight text-white group-hover:text-green-400 transition-colors">
                    {title}
                </p>
                <p className="text-xs text-white/50">{year}</p>
            </div>

            {/* Public Notes (Admin feedback) */}
            {notes && notes.length > 0 && (
                <div className="mt-2 bg-white/10 rounded-md p-2 text-xs text-white/80 border border-white/5">
                    <p className="font-semibold text-green-400 mb-1 flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" /> {t('greenlight.teamNote')}
                    </p>
                    <p className="line-clamp-2 italic">"{notes[0].note}"</p>
                </div>
            )}
        </motion.div>
    );
};

export default WishboardCard;
