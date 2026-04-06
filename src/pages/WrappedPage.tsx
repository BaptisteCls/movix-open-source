import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { ChevronLeft, ChevronRight, Share2, X, Sparkles, Calendar, Trophy, BarChart3, Clock, Flame, Music, ShieldOff, Settings } from 'lucide-react';
import { fetchWrappedData, WrappedData, WrappedProgress, WrappedSlide, WrappedTopContent } from '../services/wrappedService';
import { SquareBackground } from '../components/ui/square-background';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import ShinyText from '../components/ui/shiny-text';
import axios from 'axios';
import { getTmdbLanguage } from '../i18n';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// ==========================================
// TMDB DATA INTERFACE
// ==========================================
interface TMDBData {
    id: number;
    title?: string;
    name?: string;
    poster_path: string | null;
    backdrop_path?: string | null;
    vote_average?: number;
    release_date?: string;
    first_air_date?: string;
    genres?: { id: number; name: string }[];
    trailerKey?: string | null;
}



// ==========================================
// DURATION FORMATTING HELPERS
// ==========================================
/** Shows "Xh" if >= 60 min, else "Xmin" */
function formatDurationShort(minutes: number): string {
    if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
    return `${minutes}min`;
}

/** Shows "X heures" if >= 60 min, else "X minutes" */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function formatDurationLabel(minutes: number): string {
    if (minutes >= 60) {
        const h = Math.round(minutes / 60);
        return `${h} heure${h > 1 ? 's' : ''}`;
    }
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

function formatCompactDuration(minutes: number, t: (key: string, options?: Record<string, unknown>) => string): string {
    const safeMinutes = Math.max(0, Math.round(minutes));

    if (safeMinutes >= 60) {
        const hours = Math.floor(safeMinutes / 60);
        const remainingMinutes = safeMinutes % 60;

        if (remainingMinutes === 0) {
            return `${hours}${t('wrapped.hoursShort')}`;
        }

        return `${hours}${t('wrapped.hoursShort')} ${remainingMinutes}${t('wrapped.minutesShort')}`;
    }

    return `${safeMinutes}${t('wrapped.minutesShort')}`;
}

// ==========================================
// ANIMATED COUNTER
// ==========================================
const AnimatedCounter: React.FC<{ value: number; suffix?: string; className?: string; duration?: number }> = ({ value, suffix = '', className = '', duration = 2 }) => {
    const [count, setCount] = useState(0);

    useEffect(() => {
        const step = value / (duration * 60);
        let current = 0;
        const timer = setInterval(() => {
            current += step;
            if (current >= value) {
                setCount(value);
                clearInterval(timer);
            } else {
                setCount(Math.floor(current));
            }
        }, 1000 / 60);
        return () => clearInterval(timer);
    }, [value, duration]);

    return <span className={className}>{count.toLocaleString(i18n.language)}{suffix}</span>;
};

// ==========================================
// CASCADING TIME COUNTER - Shows time in different units
// ==========================================
type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

const timeUnits: { unit: TimeUnit; labelKey: string; labelPluralKey: string; divider: number }[] = [
    { unit: 'seconds', labelKey: 'wrapped.timeUnitSecondSingular', labelPluralKey: 'wrapped.timeUnitSecondPlural', divider: 1 },
    { unit: 'minutes', labelKey: 'wrapped.timeUnitMinuteSingular', labelPluralKey: 'wrapped.timeUnitMinutePlural', divider: 60 },
    { unit: 'hours', labelKey: 'wrapped.timeUnitHourSingular', labelPluralKey: 'wrapped.timeUnitHourPlural', divider: 3600 },
    { unit: 'days', labelKey: 'wrapped.timeUnitDaySingular', labelPluralKey: 'wrapped.timeUnitDayPlural', divider: 86400 },
    { unit: 'weeks', labelKey: 'wrapped.timeUnitWeekSingular', labelPluralKey: 'wrapped.timeUnitWeekPlural', divider: 604800 },
    { unit: 'months', labelKey: 'wrapped.timeUnitMonthSingular', labelPluralKey: 'wrapped.timeUnitMonthPlural', divider: 2592000 },
];

const CascadingTimeCounter: React.FC<{ totalMinutes: number; className?: string }> = ({ totalMinutes, className = '' }) => {
    const totalSeconds = totalMinutes * 60;
    const [currentUnitIndex, setCurrentUnitIndex] = useState(0);
    const [displayValue, setDisplayValue] = useState(0);
    const [isAnimating, setIsAnimating] = useState(true);

    // Determine the final unit based on the total time
    const getFinalUnitIndex = () => {
        const days = totalSeconds / 86400;
        if (days >= 30) return 5; // months
        if (days >= 7) return 4; // weeks
        return 3; // days
    };

    const finalUnitIndex = getFinalUnitIndex();

    useEffect(() => {
        const currentUnit = timeUnits[currentUnitIndex];
        const targetValue = totalSeconds / currentUnit.divider;
        const duration = currentUnitIndex === 0 ? 1500 : 1000; // Slower for seconds
        const startTime = Date.now();

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Easing function for smooth animation
            const eased = 1 - Math.pow(1 - progress, 3);
            const currentValue = targetValue * eased;

            setDisplayValue(currentValue);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // Animation complete, move to next unit after a delay
                if (currentUnitIndex < finalUnitIndex) {
                    setTimeout(() => {
                        setCurrentUnitIndex(prev => prev + 1);
                    }, 800);
                } else {
                    setIsAnimating(false);
                }
            }
        };

        setIsAnimating(true);
        requestAnimationFrame(animate);
    }, [currentUnitIndex, totalSeconds, finalUnitIndex]);

    const currentUnit = timeUnits[currentUnitIndex];
    const formattedValue = currentUnitIndex >= 3
        ? displayValue.toFixed(1)
        : Math.floor(displayValue).toLocaleString(i18n.language);
    const label = displayValue === 1 ? i18n.t(currentUnit.labelKey) : i18n.t(currentUnit.labelPluralKey);

    return (
        <div className={`relative ${className}`}>
            <AnimatePresence mode="wait">
                <motion.div
                    key={currentUnitIndex}
                    initial={{ opacity: 0, y: 30, scale: 0.8 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -30, scale: 0.8 }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className="flex flex-col items-center"
                >
                    <motion.span 
                        className="text-5xl md:text-7xl font-black tabular-nums"
                        animate={isAnimating ? { scale: [1, 1.02, 1] } : {}}
                        transition={{ duration: 0.1, repeat: isAnimating ? Infinity : 0 }}
                    >
                        {formattedValue}
                    </motion.span>
                    <motion.span 
                        className="text-2xl md:text-3xl text-white/70 font-medium mt-2"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.2 }}
                    >
                        {label}
                    </motion.span>
                </motion.div>
            </AnimatePresence>
            
            {/* Progress dots */}
            <div className="flex justify-center gap-2 mt-6">
                {timeUnits.slice(0, finalUnitIndex + 1).map((_, idx) => (
                    <motion.div
                        key={idx}
                        className={`w-2 h-2 rounded-full transition-colors duration-300 ${
                            idx <= currentUnitIndex ? 'bg-purple-400' : 'bg-white/20'
                        }`}
                        animate={idx === currentUnitIndex ? { scale: [1, 1.3, 1] } : {}}
                        transition={{ duration: 0.5, repeat: idx === currentUnitIndex ? Infinity : 0 }}
                    />
                ))}
            </div>
        </div>
    );
};

// ==========================================
// SLIDE COMPONENTS - New Design
// ==========================================

const SlideIntro: React.FC<{ slide: WrappedSlide; stats: WrappedData['stats'] }> = ({ slide, stats }) => (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5 }}
            className="mb-6"
        >
            <div className="relative">
                <div className="absolute inset-0 blur-3xl bg-purple-500/30 rounded-full" />
                <span className="relative text-7xl md:text-8xl">🎬</span>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
        >
            <h1 className="text-3xl md:text-5xl font-black mb-3">
                <ShinyText text={slide.title} speed={2} color="#ffffff" shineColor="#a855f7" className="" />
            </h1>
        </motion.div>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-lg md:text-xl text-purple-300 mb-6 font-medium"
        >
            {slide.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="w-full max-w-xl"
        >
            <AnimatedBorderCard
                highlightColor="168 85 247"
                backgroundColor="0 0 0"
                className="p-6 md:p-8 backdrop-blur-xl"
            >
                <p className="text-base md:text-lg text-white/90 leading-relaxed mb-6">
                    {i18n.t('wrapped.spentOnMovix')}
                </p>
                
                {/* Cascading Time Counter */}
                <CascadingTimeCounter 
                    totalMinutes={stats.totalMinutes} 
                    className="mb-4"
                />
                
                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 8 }}
                    className="text-purple-400/80 text-sm mt-4"
                >
                    {i18n.t('wrapped.hopeYouHadSnacks')}
                </motion.p>
            </AnimatedBorderCard>
        </motion.div>
    </div>
);

const SlideTop1: React.FC<{ slide: WrappedSlide; topItem?: WrappedTopContent; tmdbData: Map<number, TMDBData> }> = ({ slide, topItem, tmdbData }) => {
    const tmdb = topItem?.tmdbId ? tmdbData.get(topItem.tmdbId) : null;
    const posterUrl = tmdb?.poster_path 
        ? `${TMDB_IMAGE_BASE}${tmdb.poster_path}` 
        : topItem?.poster_path 
            ? `${TMDB_IMAGE_BASE}${topItem.poster_path}`
            : null;
    
    return (
        <div className="flex flex-col items-center justify-center h-full text-center px-6 relative overflow-hidden">
            {/* Content */}
            <div className="relative z-10 flex flex-col items-center">
                <motion.div
                    initial={{ scale: 0, rotate: -180 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', duration: 0.8 }}
                    className="mb-6"
                >
                    <div className="relative">
                        <div className="absolute inset-0 blur-3xl bg-amber-500/40 rounded-full scale-150" />
                        {posterUrl ? (
                            <div className="relative w-32 h-44 md:w-40 md:h-56 rounded-2xl overflow-hidden shadow-2xl ring-4 ring-amber-400/50">
                                <img 
                                    src={posterUrl} 
                                    alt={topItem?.title || 'Top 1'}
                                    className="w-full h-full object-cover"
                                />
                                {/* Trophy badge */}
                                <div className="absolute -top-3 -right-3 w-12 h-12 rounded-full bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 flex items-center justify-center shadow-lg">
                                    <Trophy className="w-6 h-6 text-white" />
                                </div>
                            </div>
                        ) : (
                            <div className="relative w-32 h-32 md:w-40 md:h-40 rounded-full bg-gradient-to-br from-amber-400 via-orange-500 to-red-500 flex items-center justify-center shadow-2xl">
                                <Trophy className="w-16 h-16 md:w-20 md:h-20 text-white" />
                            </div>
                        )}
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                >
                    <h2 className="text-2xl md:text-4xl font-black mb-2">
                        <ShinyText text={tmdb?.title || tmdb?.name || slide.title} speed={2} color="#fbbf24" shineColor="#ffffff" className="" />
                    </h2>
                </motion.div>

                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="text-lg md:text-xl text-amber-300 mb-6 font-semibold"
                >
                    {slide.subtitle}
                </motion.p>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.7 }}
                >
                    <AnimatedBorderCard
                        highlightColor="251 191 36"
                        backgroundColor="0 0 0"
                        className="p-6 max-w-xl backdrop-blur-xl"
                    >
                        <p className="text-base md:text-lg text-white/90 leading-relaxed">
                            {slide.text}
                        </p>
                        {slide.subtext && (
                            <p className="mt-3 text-amber-400/80 italic text-sm">{slide.subtext}</p>
                        )}
                    </AnimatedBorderCard>
                </motion.div>
            </div>
        </div>
    );
};

const SlideTop5: React.FC<{ slide: WrappedSlide; topContent: WrappedData['topContent']; tmdbData: Map<number, TMDBData> }> = ({ slide, topContent, tmdbData }) => (
    <div 
        className="flex flex-col items-center h-full text-center px-4 relative z-10 w-full overflow-y-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent pt-24 pb-32"
        data-lenis-prevent
        onWheel={(e) => e.stopPropagation()}
    >
        {/* Header */}
        <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 flex-shrink-0"
        >
            <h2 className="text-3xl md:text-5xl font-black mb-2">
                <ShinyText text={slide.title} speed={2} color="#fbbf24" shineColor="#ffffff" className="" />
            </h2>
            <p className="text-lg text-amber-200/80 font-medium">{slide.subtitle}</p>
        </motion.div>

        {/* List */}
        <div className="w-full max-w-lg flex flex-col gap-3 flex-1 pb-4">
            {topContent.slice(0, 5).map((item, index) => {
                const tmdb = item.tmdbId ? tmdbData.get(item.tmdbId) : null;
                const posterUrl = tmdb?.poster_path  
                    ? `${TMDB_IMAGE_BASE}${tmdb.poster_path}` 
                    : item.poster_path 
                        ? `${TMDB_IMAGE_BASE}${item.poster_path}`
                        : null;
                
                const year = tmdb?.release_date ? new Date(tmdb.release_date).getFullYear() : 
                             tmdb?.first_air_date ? new Date(tmdb.first_air_date).getFullYear() : null;
                
                const genres = tmdb?.genres?.slice(0, 2).map(g => g.name).join(' • ');

                return (
                    <motion.div 
                        key={index}
                        initial={{ opacity: 0, x: -30 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.2 + index * 0.1 }}
                        className="w-full"
                    >
                        <AnimatedBorderCard
                            highlightColor={index === 0 ? "255 193 7" : index === 1 ? "148 163 184" : index === 2 ? "180 83 9" : "255 255 255"}
                            backgroundColor="0 0 0" 
                            className={`flex items-center gap-4 p-3 bg-white/5 backdrop-blur-md w-full border border-white/5 transition-transform hover:scale-[1.02] ${index === 0 ? 'bg-amber-500/10 border-amber-500/30' : ''}`}
                        >
                             {/* Rank & Poster Container */}
                             <div className="relative">
                                <div className={`absolute -top-2 -left-2 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shadow-lg z-10 ${
                                    index === 0 ? 'bg-gradient-to-br from-amber-300 to-orange-500 text-black border-2 border-amber-200' :
                                    index === 1 ? 'bg-gradient-to-br from-slate-200 to-slate-400 text-slate-800 border-2 border-slate-100' :
                                    index === 2 ? 'bg-gradient-to-br from-amber-600 to-amber-800 text-white border-2 border-amber-500' :
                                    'bg-white/10 text-white border border-white/20'
                                }`}>
                                    {index + 1}
                                </div>
                                <div className={`relative w-16 h-24 rounded-lg overflow-hidden flex-shrink-0 shadow-xl ${index === 0 ? 'w-20 h-28' : ''}`}>
                                    {posterUrl ? (
                                        <img 
                                            src={posterUrl} 
                                            alt={item.title}
                                            className="w-full h-full object-cover"
                                            loading="lazy"
                                        />
                                    ) : (
                                        <div className="w-full h-full bg-white/5 flex items-center justify-center text-lg">
                                            {item.type === 'anime' ? '⛩️' : item.type === 'movie' ? '🎬' : item.type === 'tv' ? '📺' : '📡'}
                                        </div>
                                    )}
                                </div>
                            </div>
                            
                            {/* Metadata */}
                            <div className="flex-1 text-left min-w-0 flex flex-col justify-center h-full">
                                {/* Title */}
                                <p className={`font-bold text-white leading-tight truncate pr-2 ${index === 0 ? 'text-lg text-amber-100' : 'text-base'}`}>
                                    {tmdb?.title || tmdb?.name || item.title}
                                </p>
                                
                                {/* Sub-info line 1: Type + Year */}
                                <div className="flex items-center gap-2 mt-1 text-xs text-white/50">
                                    <span className="uppercase tracking-wider font-medium text-[10px] bg-white/10 px-1.5 py-0.5 rounded">
                                        {item.type === 'movie' ? i18n.t('wrapped.filmType') : item.type === 'tv' ? i18n.t('wrapped.seriesType') : item.type === 'anime' ? i18n.t('wrapped.animeType') : i18n.t('wrapped.tvType')}
                                    </span>
                                    {year && <span>{year}</span>}
                                </div>

                                {/* Sub-info line 2: Genres or Rating */}
                                <div className="flex items-center gap-3 mt-1.5 h-4">
                                    {genres && (
                                        <p className="text-xs text-white/40 truncate max-w-[120px]">
                                            {genres}
                                        </p>
                                    )}
                                    {tmdb?.vote_average && (
                                        <div className="flex items-center gap-1 text-amber-400 text-xs font-medium ml-auto">
                                            <span>★</span>
                                            <span>{tmdb.vote_average.toFixed(1)}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Hours Watched Badge */}
                            <div className="flex flex-col items-end justify-center pl-2 border-l border-white/5 min-w-[60px]">
                                <span className={`text-xl font-black ${index === 0 ? 'text-amber-400' : 'text-teal-400'}`}>
                                    {item.durationLabel || formatDurationShort(item.minutes)}
                                </span>
                            </div>
                        </AnimatedBorderCard>
                    </motion.div>
                );
            })}
        </div>
        
        {slide.highlight && (
            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.8 }}
                className="mt-4 text-teal-400 font-medium text-sm"
            >
                {slide.highlight}
            </motion.p>
        )}
    </div>
);

const SlidePersona: React.FC<{ slide: WrappedSlide; persona: WrappedData['persona'] }> = ({ slide, persona }) => (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', duration: 1 }}
            className="mb-8"
        >
            <div className="relative">
                <div
                    className="absolute inset-0 blur-3xl rounded-full scale-150"
                    style={{ backgroundColor: `${persona.color}40` }}
                />
                <div
                    className="relative w-36 h-36 md:w-44 md:h-44 rounded-full flex items-center justify-center text-7xl md:text-8xl"
                    style={{
                        background: `linear-gradient(135deg, ${persona.color}40, ${persona.color}20)`,
                        border: `3px solid ${persona.color}80`,
                    }}
                >
                    {persona.emoji}
                </div>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
        >
            <h2 className="text-3xl md:text-5xl font-black mb-3">
                <ShinyText text={persona.title} speed={2} color={persona.color} shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="text-xl md:text-2xl mb-8 font-medium"
            style={{ color: persona.color }}
        >
            {persona.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
        >
            <AnimatedBorderCard
                highlightColor={persona.color.replace('#', '').match(/.{2}/g)?.map(hex => parseInt(hex, 16)).join(' ') || "255 152 0"}
                backgroundColor="0 0 0"
                className="p-8 max-w-xl backdrop-blur-xl"
            >
                <p className="text-lg md:text-xl text-white/90 leading-relaxed">
                    {slide.text}
                </p>
                <p className="mt-4 text-white/60 italic">{persona.description}</p>
            </AnimatedBorderCard>
        </motion.div>
    </div>
);

const SlidePeakMonth: React.FC<{ slide: WrappedSlide; peakMonth: WrappedData['peakMonth'] }> = ({ slide }) => (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', duration: 0.8 }}
            className="mb-8"
        >
            <div className="relative">
                <div className="absolute inset-0 blur-3xl bg-indigo-500/40 rounded-full scale-150" />
                <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-blue-500 via-indigo-500 to-violet-600 flex items-center justify-center shadow-2xl rotate-3">
                    <Calendar className="w-14 h-14 md:w-16 md:h-16 text-white" />
                </div>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
        >
            <h2 className="text-4xl md:text-6xl font-black mb-3">
                <ShinyText text={slide.title} speed={2} color="#818cf8" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-xl md:text-2xl text-indigo-300 mb-8 font-semibold"
        >
            {slide.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
        >
            <AnimatedBorderCard
                highlightColor="129 140 248"
                backgroundColor="0 0 0"
                className="p-8 max-w-xl backdrop-blur-xl"
            >
                <p className="text-lg md:text-xl text-white/90 leading-relaxed">
                    {slide.text}
                </p>
                {slide.subtext && (
                    <p className="mt-4 text-indigo-400/80 italic">{slide.subtext}</p>
                )}
            </AnimatedBorderCard>
        </motion.div>
    </div>
);

// ==========================================
// SLIDE: TOP GENRES
// ==========================================
const SlideTopGenres: React.FC<{ slide: WrappedSlide; topGenres?: WrappedData['topGenres'] }> = ({ slide, topGenres }) => (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <motion.div
            initial={{ scale: 0, rotate: 20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', duration: 0.8 }}
            className="mb-8"
        >
            <div className="relative">
                <div className="absolute inset-0 blur-3xl bg-rose-500/30 rounded-full scale-150" />
                <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-rose-500 via-pink-500 to-fuchsia-600 flex items-center justify-center shadow-2xl -rotate-3">
                    <Music className="w-14 h-14 md:w-16 md:h-16 text-white" />
                </div>
            </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
            <h2 className="text-3xl md:text-5xl font-black mb-3">
                <ShinyText text={slide.title} speed={2} color="#f43f5e" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="text-lg md:text-xl text-rose-300 mb-6 font-medium">
            {slide.subtitle}
        </motion.p>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="w-full max-w-md">
            {topGenres && topGenres.length > 0 && (
                <div className="space-y-3 mb-6">
                    {topGenres.slice(0, 5).map((genre, i) => (
                        <motion.div
                            key={genre.name}
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.6 + i * 0.1 }}
                            className="flex items-center gap-3"
                        >
                            <span className="text-sm text-white/60 w-8 text-right font-mono">{genre.percent}%</span>
                            <div className="flex-1 h-8 bg-white/5 rounded-lg overflow-hidden relative">
                                <motion.div
                                    initial={{ width: 0 }}
                                    animate={{ width: `${genre.percent}%` }}
                                    transition={{ duration: 1, delay: 0.7 + i * 0.1 }}
                                    className="h-full bg-gradient-to-r from-rose-500 to-pink-400 rounded-lg"
                                />
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white text-sm font-medium">{genre.name}</span>
                            </div>
                        </motion.div>
                    ))}
                </div>
            )}
        </motion.div>

        {/* Only show subtext if it mentions genres not already displayed in the bars (top 5) */}
        {slide.subtext && topGenres && topGenres.length > 5 && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }} className="text-rose-400/60 text-sm italic">
                {i18n.t('wrapped.andAlso')}{topGenres.slice(5).map(g => g.name).join(', ')}
            </motion.p>
        )}
    </div>
);

// ==========================================
// SLIDE: LISTENING CLOCK
// ==========================================
const SlideListeningClock: React.FC<{ slide: WrappedSlide; listeningClock?: WrappedData['listeningClock']; peakHour?: number }> = ({ slide, listeningClock, peakHour }) => {
    const maxMinutes = listeningClock ? Math.max(...listeningClock.map(h => h.minutes)) : 1;
    
    return (
        <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', duration: 0.8 }}
                className="mb-6"
            >
                <div className="relative">
                    <div className="absolute inset-0 blur-3xl bg-sky-500/30 rounded-full scale-150" />
                    <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-full bg-gradient-to-br from-sky-500 via-blue-500 to-indigo-600 flex items-center justify-center shadow-2xl">
                        <Clock className="w-14 h-14 md:w-16 md:h-16 text-white" />
                    </div>
                </div>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                <h2 className="text-3xl md:text-5xl font-black mb-2">
                    <ShinyText text={slide.title} speed={2} color="#38bdf8" shineColor="#ffffff" className="" />
                </h2>
            </motion.div>

            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="text-lg text-sky-300 mb-6 font-medium">
                {slide.subtitle}
            </motion.p>

            {/* Clock visualization - 24h bar chart */}
            {listeningClock && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="w-full max-w-md"
                >
                    <div className="flex items-end justify-center gap-[2px] h-32 mb-2">
                        {listeningClock.map((h, i) => {
                            const hasActivity = h.minutes > 0;
                            const heightPercent = hasActivity ? Math.max(8, (h.minutes / maxMinutes) * 100) : 0;
                            const isPeak = i === peakHour && hasActivity;
                            const isHigh = h.minutes > maxMinutes * 0.5;
                            const isMedium = h.minutes > maxMinutes * 0.2;
                            
                            return (
                                <motion.div
                                    key={i}
                                    initial={{ height: 0 }}
                                    animate={{ height: hasActivity ? `${heightPercent}%` : '2px' }}
                                    transition={{ duration: 0.6, delay: 0.6 + i * 0.03, type: 'spring', bounce: 0.2 }}
                                    className={`w-2.5 md:w-3 rounded-t-sm transition-colors ${
                                        isPeak 
                                            ? 'bg-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.6)]' 
                                            : isHigh 
                                                ? 'bg-sky-500/80' 
                                                : isMedium
                                                    ? 'bg-sky-500/50'
                                                    : hasActivity
                                                        ? 'bg-sky-500/30'
                                                        : 'bg-white/5'
                                    }`}
                                    title={`${i}h: ${Math.round(h.minutes)} min`}
                                />
                            );
                        })}
                    </div>
                    <div className="flex justify-between text-[10px] text-white/40 px-1 font-mono">
                        <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
                    </div>
                </motion.div>
            )}

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2 }} className="mt-4">
                <AnimatedBorderCard highlightColor="56 189 248" backgroundColor="0 0 0" className="p-4 max-w-md backdrop-blur-xl">
                    <p className="text-sm md:text-base text-white/80">{slide.text}</p>
                </AnimatedBorderCard>
            </motion.div>
        </div>
    );
};

// ==========================================
// SLIDE: STREAK
// ==========================================
const SlideStreak: React.FC<{ slide: WrappedSlide; stats: WrappedData['stats'] }> = ({ slide, stats }) => (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <motion.div
            initial={{ scale: 0, y: -50 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: 'spring', duration: 0.8, bounce: 0.4 }}
            className="mb-8"
        >
            <div className="relative">
                <div className="absolute inset-0 blur-3xl bg-orange-500/40 rounded-full scale-150" />
                <div className="relative w-28 h-28 md:w-36 md:h-36 rounded-3xl bg-gradient-to-br from-orange-400 via-red-500 to-rose-600 flex items-center justify-center shadow-2xl">
                    <Flame className="w-16 h-16 md:w-20 md:h-20 text-white" />
                </div>
            </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <h2 className="text-3xl md:text-5xl font-black mb-2">
                <ShinyText text={slide.title} speed={2} color="#f97316" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="text-lg md:text-xl text-orange-300 mb-6 font-medium">
            {slide.subtitle}
        </motion.p>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7 }}>
            <AnimatedBorderCard highlightColor="249 115 22" backgroundColor="0 0 0" className="p-6 max-w-xl backdrop-blur-xl">
                <p className="text-base md:text-lg text-white/90 leading-relaxed">{slide.text}</p>
                {slide.subtext && <p className="mt-3 text-orange-400/70 text-sm italic">{slide.subtext}</p>}
            </AnimatedBorderCard>
        </motion.div>

        {/* Mini stats row */}
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="flex gap-8 mt-6"
        >
            {stats.longestStreak && (
                <div className="text-center">
                    <p className="text-2xl font-black text-orange-400">{stats.longestStreak}</p>
                    <p className="text-[10px] text-white/40 uppercase">{i18n.t('wrapped.bestStreak')}</p>
                </div>
            )}
            {stats.totalActiveDays && (
                <div className="text-center">
                    <p className="text-2xl font-black text-white">{stats.totalActiveDays}</p>
                    <p className="text-[10px] text-white/40 uppercase">{i18n.t('wrapped.activeDays')}</p>
                </div>
            )}
            {stats.percentile && (
                <div className="text-center">
                    <p className="text-2xl font-black text-amber-400">Top {100 - stats.percentile}%</p>
                    <p className="text-[10px] text-white/40 uppercase">{i18n.t('wrapped.ofViewers')}</p>
                </div>
            )}
        </motion.div>
    </div>
);

const SlideFunFact: React.FC<{ slide: WrappedSlide }> = ({ slide }) => (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <motion.div
            initial={{ rotate: -20, scale: 0 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: 'spring', duration: 0.8 }}
            className="mb-8"
        >
            <div className="relative">
                <div className="absolute inset-0 blur-3xl bg-emerald-500/30 rounded-full scale-150" />
                <span className="relative text-8xl md:text-9xl">{slide.highlight || '💡'}</span>
            </div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
        >
            <h2 className="text-3xl md:text-5xl font-black mb-4">
                <ShinyText text={slide.title} speed={2} color="#34d399" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
        >
            <AnimatedBorderCard
                highlightColor="52 211 153"
                backgroundColor="0 0 0"
                className="p-8 max-w-xl backdrop-blur-xl"
            >
                <p className="text-lg md:text-xl text-white/90 leading-relaxed">
                    {slide.text}
                </p>
                {slide.subtext && (
                    <p className="mt-4 text-emerald-400/80 italic">{slide.subtext}</p>
                )}
            </AnimatedBorderCard>
        </motion.div>
    </div>
);

const SlideClosing: React.FC<{ slide: WrappedSlide; stats: WrappedData['stats'] }> = ({ slide, stats }) => (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
        <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', duration: 0.8 }}
            className="mb-6"
        >
            <motion.div
                animate={{ boxShadow: ['0 0 30px #e879f9', '0 0 60px #e879f9', '0 0 30px #e879f9'] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="relative w-28 h-28 md:w-36 md:h-36 rounded-full bg-gradient-to-br from-fuchsia-500 via-purple-500 to-violet-600 flex items-center justify-center"
            >
                <span className="text-5xl md:text-6xl">{slide.highlight || '💜'}</span>
            </motion.div>
        </motion.div>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
        >
            <h2 className="text-3xl md:text-5xl font-black mb-2">
                <ShinyText text={slide.title} speed={2} color="#e879f9" shineColor="#ffffff" className="" />
            </h2>
        </motion.div>

        <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="text-xl md:text-2xl text-fuchsia-300 mb-4 font-semibold"
        >
            {slide.subtitle}
        </motion.p>

        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
        >
            <AnimatedBorderCard
                highlightColor="232 121 249"
                backgroundColor="0 0 0"
                className="p-6 max-w-xl backdrop-blur-xl"
            >
                <p className="text-base md:text-lg text-white/90 leading-relaxed">
                    {slide.text}
                </p>
                {slide.subtext && (
                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1 }}
                        className="mt-4 text-lg text-fuchsia-400 font-medium"
                    >
                        {slide.subtext}
                    </motion.p>
                )}
            </AnimatedBorderCard>
        </motion.div>

        {/* Stats summary */}
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="flex gap-6 md:gap-8 mt-6"
        >
            {[
                { value: stats.totalHours > 0 ? stats.totalHours : stats.totalMinutes, label: stats.totalHours > 0 ? i18n.t('wrapped.statHours') : i18n.t('wrapped.statMinutes') },
                { value: stats.uniqueTitles, label: i18n.t('wrapped.statTitles') },
                { value: stats.totalSessions, label: i18n.t('wrapped.statSessions') }
            ].map((stat, i) => (
                <motion.div
                    key={stat.label}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 1.2 + i * 0.1 }}
                    className="text-center"
                >
                    <p className="text-2xl md:text-3xl font-black text-white">
                        <AnimatedCounter value={stat.value} duration={1.5} />
                    </p>
                    <p className="text-fuchsia-400 text-xs">{stat.label}</p>
                </motion.div>
            ))}
        </motion.div>

        {/* Swipe hint for detailed stats */}
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.8 }}
            className="mt-6 flex items-center gap-2 text-fuchsia-400/60"
        >
            <span className="text-sm">{i18n.t('wrapped.swipeForStats')}</span>
            <ChevronRight className="w-4 h-4 animate-pulse" />
        </motion.div>
    </div>
);

// ==========================================
// SLIDE DETAILED STATS (Slide 8)
// ==========================================
const SlideDetailedStats: React.FC<{ 
    slide: WrappedSlide; 
    data: WrappedData;
    tmdbData: Map<number, TMDBData>;
}> = ({ slide, data, tmdbData }) => (
    <div 
        className="flex flex-col items-center h-full text-center px-4 relative z-10 w-full overflow-y-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent pt-24 pb-32"
        data-lenis-prevent
        onWheel={(e) => e.stopPropagation()}
    >
        {/* Header */}
        <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 flex-shrink-0"
        >
            <div className="flex items-center justify-center gap-3 mb-2">
                <BarChart3 className="w-8 h-8 text-cyan-400" />
                <h2 className="text-2xl md:text-3xl font-black">
                    <ShinyText text={slide.title} speed={2} color="#22d3ee" shineColor="#ffffff" className="" />
                </h2>
            </div>
            <p className="text-cyan-300/70">{slide.subtitle}</p>
        </motion.div>

        {/* Time Stats Grid */}
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="w-full max-w-lg mb-4"
        >
            <div className="grid grid-cols-4 gap-2">
                {[
                    { value: data.stats.totalMinutes.toLocaleString(i18n.language), label: 'Min' },
                    { value: data.stats.totalHours > 0 ? data.stats.totalHours.toLocaleString(i18n.language) : data.stats.totalMinutes.toLocaleString(i18n.language), label: data.stats.totalHours > 0 ? i18n.t('wrapped.hours') : i18n.t('wrapped.minutes') },
                    { value: data.stats.totalDays.toFixed(1), label: i18n.t('wrapped.days') },
                    { value: (data.stats.totalDays / 7).toFixed(1), label: i18n.t('wrapped.weeks') },
                ].map((stat, i) => (
                    <motion.div 
                        key={stat.label}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.2 + i * 0.05 }}
                        className="bg-white/5 backdrop-blur-sm rounded-xl p-2"
                    >
                        <p className="text-lg md:text-xl font-black text-white">{stat.value}</p>
                        <p className="text-[10px] text-cyan-400">{stat.label}</p>
                    </motion.div>
                ))}
            </div>
        </motion.div>

        {/* Content Type Breakdown */}
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="w-full max-w-lg mb-4"
        >
            <h3 className="text-sm font-semibold text-cyan-400 mb-2 text-left">📊 {i18n.t('wrapped.byType')}</h3>
            <div className="space-y-2">
                {data.byType.map((item, i) => (
                    <motion.div 
                        key={item.type}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.3 + i * 0.05 }}
                        className="bg-white/5 backdrop-blur-sm rounded-lg p-2"
                    >
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-white text-sm font-medium flex items-center gap-1.5">
                                {item.type === 'movie' && '🎬'}
                                {item.type === 'tv' && '📺'}
                                {item.type === 'anime' && '⛩️'}
                                {item.type === 'live-tv' && '📡'}
                                {item.type === 'movie' ? i18n.t('wrapped.moviesLabel') :
                                 item.type === 'tv' ? i18n.t('wrapped.seriesPlural') :
                                 item.type === 'anime' ? 'Anime' : i18n.t('wrapped.liveTVLabel')}
                            </span>
                            <span className="text-white/50 text-xs">{item.count} • {Math.round(item.minutes / 60)}h</span>
                        </div>
                        <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${item.percent}%` }}
                                transition={{ duration: 1, delay: 0.4 + i * 0.1 }}
                                className="h-full bg-gradient-to-r from-cyan-500 to-teal-400"
                            />
                        </div>
                    </motion.div>
                ))}
            </div>
        </motion.div>

        {/* Top Content with TMDB Posters */}
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="w-full max-w-lg mb-4"
        >
            <h3 className="text-sm font-semibold text-cyan-400 mb-2 text-left">🏆 {i18n.t('wrapped.topContents')}</h3>
            <div className="space-y-2">
                {data.topContent.slice(0, 5).map((item, index) => {
                    const tmdb = item.tmdbId ? tmdbData.get(item.tmdbId) : null;
                    const posterUrl = tmdb?.poster_path 
                        ? `${TMDB_IMAGE_BASE}${tmdb.poster_path}` 
                        : item.poster_path 
                            ? `${TMDB_IMAGE_BASE}${item.poster_path}`
                            : null;
                    
                    return (
                        <motion.div 
                            key={index}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: 0.5 + index * 0.05 }}
                            className="flex items-center gap-3 bg-white/5 backdrop-blur-sm rounded-xl p-2"
                        >
                            {/* Poster */}
                            <div className="relative w-12 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-white/10">
                                {posterUrl ? (
                                    <img 
                                        src={posterUrl} 
                                        alt={item.title}
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                        }}
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-2xl">
                                        {item.type === 'movie' ? '🎬' : item.type === 'tv' ? '📺' : item.type === 'anime' ? '⛩️' : '📡'}
                                    </div>
                                )}
                                {/* Rank Badge */}
                                <div className={`absolute -top-1 -left-1 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                                    index === 0 ? 'bg-gradient-to-br from-amber-400 to-orange-500 text-white' :
                                    index === 1 ? 'bg-gradient-to-br from-slate-300 to-slate-400 text-slate-800' :
                                    index === 2 ? 'bg-gradient-to-br from-amber-600 to-amber-700 text-white' :
                                    'bg-white/20 text-white/60'
                                }`}>
                                    {index + 1}
                                </div>
                            </div>
                            
                            {/* Info */}
                            <div className="flex-1 min-w-0 text-left">
                                <p className="font-semibold text-white text-sm truncate">
                                    {tmdb?.title || tmdb?.name || item.title}
                                </p>
                                <div className="flex items-center gap-2 text-xs text-white/40">
                                    <span>
                                        {item.type === 'movie' ? i18n.t('wrapped.movieType') :
                                         item.type === 'tv' ? i18n.t('wrapped.seriesSingular') :
                                         item.type === 'anime' ? 'Anime' : i18n.t('wrapped.tvType')}
                                    </span>
                                    {tmdb?.vote_average && (
                                        <span className="flex items-center gap-0.5">
                                            ⭐ {tmdb.vote_average.toFixed(1)}
                                        </span>
                                    )}
                                </div>
                            </div>
                            
                            {/* Hours */}
                            <div className="text-right">
                                <p className="text-cyan-400 font-bold">{item.durationLabel || formatDurationShort(item.minutes)}</p>
                            </div>
                        </motion.div>
                    );
                })}
            </div>
        </motion.div>

        {/* Bottom Stats */}
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="w-full max-w-lg grid grid-cols-2 gap-2"
        >
            <div className="bg-white/5 backdrop-blur-sm rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-white">{data.stats.uniqueTitles}</p>
                <p className="text-xs text-cyan-400">{i18n.t('wrapped.uniqueTitlesLabel')}</p>
            </div>
            <div className="bg-white/5 backdrop-blur-sm rounded-xl p-3 text-center">
                <p className="text-2xl font-black text-white">{data.stats.totalSessions}</p>
                <p className="text-xs text-cyan-400">{i18n.t('wrapped.sessionsLabel')}</p>
            </div>
        </motion.div>

        {/* Peak Month */}
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            className="w-full max-w-lg mt-4"
        >
            <div className="bg-gradient-to-r from-cyan-500/20 to-teal-500/20 rounded-xl p-3 text-center">
                <p className="text-white/60 text-xs mb-1">{i18n.t('wrapped.mostActiveMonth')}</p>
                <p className="text-xl font-black text-white">{data.peakMonth.name}</p>
                <p className="text-cyan-400 text-sm">{Math.round(data.peakMonth.minutes / 60)} {i18n.t('wrapped.peakMonthHours')}</p>
            </div>
        </motion.div>
    </div>
);

// ==========================================
// SLIDE BACKGROUNDS
// ==========================================
const slideBackgrounds: Record<string, { color: string; gradient: string }> = {
    intro: { color: 'rgba(168, 85, 247, 0.15)', gradient: 'from-purple-500/20 via-transparent to-transparent' },
    top1: { color: 'rgba(251, 191, 36, 0.15)', gradient: 'from-amber-500/20 via-transparent to-transparent' },
    top5: { color: 'rgba(45, 212, 191, 0.15)', gradient: 'from-teal-500/20 via-transparent to-transparent' },
    persona: { color: 'rgba(255, 152, 0, 0.15)', gradient: 'from-orange-500/20 via-transparent to-transparent' },
    'peak-month': { color: 'rgba(129, 140, 248, 0.15)', gradient: 'from-indigo-500/20 via-transparent to-transparent' },
    'top-genres': { color: 'rgba(244, 63, 94, 0.15)', gradient: 'from-rose-500/20 via-transparent to-transparent' },
    'listening-clock': { color: 'rgba(56, 189, 248, 0.15)', gradient: 'from-sky-500/20 via-transparent to-transparent' },
    'streak': { color: 'rgba(249, 115, 22, 0.15)', gradient: 'from-orange-500/20 via-transparent to-transparent' },
    'fun-fact': { color: 'rgba(52, 211, 153, 0.15)', gradient: 'from-emerald-500/20 via-transparent to-transparent' },
    closing: { color: 'rgba(232, 121, 249, 0.15)', gradient: 'from-fuchsia-500/20 via-transparent to-transparent' },
    'detailed-stats': { color: 'rgba(34, 211, 238, 0.15)', gradient: 'from-cyan-500/20 via-transparent to-transparent' },
};

// ==========================================
// MAIN WRAPPED PAGE COMPONENT
// ==========================================
const WrappedPage: React.FC = () => {
    const navigate = useNavigate();
    const { year: yearParam } = useParams<{ year?: string }>();
    const { t } = useTranslation();
    const [wrappedData, setWrappedData] = useState<WrappedData | null>(null);
    const [loading, setLoading] = useState(true);
    const [currentSlide, setCurrentSlide] = useState(0);
    const [direction, setDirection] = useState(0);
    const [tmdbData, setTmdbData] = useState<Map<number, TMDBData>>(new Map());
    const [noData, setNoData] = useState(false);
    const [wrappedProgress, setWrappedProgress] = useState<WrappedProgress | null>(null);
    const bgMode = (localStorage.getItem('settings_bg_mode') as 'combined' | 'static' | 'animated') || 'combined';
    const dataCollectionEnabled = localStorage.getItem('privacy_data_collection') !== 'false';

    const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear();

    // Block access if data collection is disabled
    if (!dataCollectionEnabled) {
        return (
            <SquareBackground mode={bgMode} borderColor="rgba(168, 85, 247, 0.15)" className="fixed inset-0 z-50 bg-black flex items-center justify-center">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(168,85,247,0.2),transparent_50%)]" />
                <div className="flex flex-col items-center justify-center w-full h-full px-6 text-center relative z-10">
                    <button
                        onClick={() => navigate(-1)}
                        className="absolute top-4 left-4 p-3 rounded-full bg-white/5 hover:bg-white/10 backdrop-blur-lg transition-colors border border-white/10"
                    >
                        <X className="w-5 h-5 text-white" />
                    </button>

                    <motion.div
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: 'spring', duration: 0.8 }}
                        className="mb-8"
                    >
                        <div className="relative">
                            <div className="absolute inset-0 blur-3xl bg-red-500/20 rounded-full scale-150" />
                            <ShieldOff className="relative w-20 h-20 text-red-400" />
                        </div>
                    </motion.div>

                    <motion.h1
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                        className="text-2xl md:text-4xl font-black text-white mb-4"
                    >
                        {t('wrapped.dataCollectionDisabled')}
                    </motion.h1>

                    <motion.p
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.4 }}
                        className="text-base md:text-lg text-gray-400 max-w-md mb-8"
                    >
                        {t('wrapped.dataCollectionDisabledDesc')}
                    </motion.p>

                    <motion.button
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6 }}
                        onClick={() => navigate('/settings')}
                        className="flex items-center gap-2 px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-medium transition-colors"
                    >
                        <Settings className="w-4 h-4" />
                        {t('wrapped.goToSettings')}
                    </motion.button>
                </div>
            </SquareBackground>
        );
    }

    // Fetch TMDB data for top content
    const fetchTMDBData = useCallback(async (topContent: WrappedTopContent[]) => {
        const newTmdbData = new Map<number, TMDBData>();
        
        const fetchPromises = topContent.map(async (item, index) => {
            if (!item.tmdbId) return;
            
            try {
                const mediaType = item.type === 'tv' || item.type === 'anime' ? 'tv' : 'movie';
                const response = await axios.get(
                    `https://api.themoviedb.org/3/${mediaType}/${item.tmdbId}`,
                    { params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() } }
                );
                const data: TMDBData = response.data;

                // Fetch trailer only for the #1 item
                if (index === 0) {
                    try {
                        const videosRes = await axios.get(
                            `https://api.themoviedb.org/3/${mediaType}/${item.tmdbId}/videos`,
                            { params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() } }
                        );
                        let trailer = videosRes.data.results?.find(
                            (v: any) => v.site === 'YouTube' && v.type === 'Trailer'
                        );
                        // Fallback: try English trailers
                        if (!trailer) {
                            const videosResEN = await axios.get(
                                `https://api.themoviedb.org/3/${mediaType}/${item.tmdbId}/videos`,
                                { params: { api_key: TMDB_API_KEY, language: 'en-US' } }
                            );
                            trailer = videosResEN.data.results?.find(
                                (v: any) => v.site === 'YouTube' && v.type === 'Trailer'
                            );
                            // Last fallback: any YouTube video (teaser, clip, etc.)
                            if (!trailer) {
                                trailer = videosResEN.data.results?.find(
                                    (v: any) => v.site === 'YouTube'
                                );
                            }
                        }
                        data.trailerKey = trailer?.key || null;
                    } catch {
                        data.trailerKey = null;
                    }
                }

                newTmdbData.set(item.tmdbId, data);
            } catch (error) {
                console.error(`[Wrapped] Error fetching TMDB data for ${item.tmdbId}:`, error);
            }
        });

        await Promise.all(fetchPromises);
        setTmdbData(newTmdbData);
    }, []);

    useEffect(() => {
        const loadWrapped = async () => {
            setLoading(true);

            const response = await fetchWrappedData(year);

            if (response.success && response.wrapped) {
                // Hotfix: Ensure detailed-stats slide exists if backend doesn't send it yet
                const hasStats = response.wrapped.slides.some((s: WrappedSlide) => s.type === 'detailed-stats');
                if (!hasStats) {
                    const closingIndex = response.wrapped.slides.findIndex((s: WrappedSlide) => s.type === 'closing');
                    const statsSlide: WrappedSlide = {
                        type: "detailed-stats",
                        title: t('wrapped.yourStatistics'),
                        subtitle: t('wrapped.inDetail'),
                        text: t('wrapped.yearSummary'),
                        highlight: "📊",
                        subtext: ""
                    };
                    
                    if (closingIndex !== -1) {
                        response.wrapped.slides.splice(closingIndex, 0, statsSlide);
                    } else {
                        response.wrapped.slides.push(statsSlide);
                    }
                }

                setWrappedData(response.wrapped);
                setWrappedProgress(response.progress ?? null);
                setNoData(false);
                // Fetch TMDB data for posters
                fetchTMDBData(response.wrapped.topContent);
            } else {
                // No data available for this user/year
                setWrappedData(null);
                setWrappedProgress(response.progress ?? null);
                setNoData(true);
            }

            setLoading(false);
        };

        loadWrapped();
    }, [year, fetchTMDBData]);

    const goToSlide = useCallback((index: number) => {
        if (!wrappedData) return;
        const newIndex = Math.max(0, Math.min(index, wrappedData.slides.length - 1));
        setDirection(newIndex > currentSlide ? 1 : -1);
        setCurrentSlide(newIndex);
    }, [currentSlide, wrappedData]);

    const nextSlide = useCallback(() => {
        if (!wrappedData) return;
        if (currentSlide < wrappedData.slides.length - 1) {
            setDirection(1);
            setCurrentSlide(prev => prev + 1);
        }
    }, [currentSlide, wrappedData]);

    const prevSlide = useCallback(() => {
        if (currentSlide > 0) {
            setDirection(-1);
            setCurrentSlide(prev => prev - 1);
        }
    }, [currentSlide]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'ArrowRight' || e.key === ' ') {
                e.preventDefault();
                nextSlide();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                prevSlide();
            } else if (e.key === 'Escape') {
                navigate(-1);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [nextSlide, prevSlide, navigate]);

    const handleDragEnd = (_: any, info: PanInfo) => {
        const threshold = 50;
        if (info.offset.x < -threshold) nextSlide();
        else if (info.offset.x > threshold) prevSlide();
    };

    const renderSlideContent = (slide: WrappedSlide) => {
        if (!wrappedData) return null;

        switch (slide.type) {
            case 'intro': return <SlideIntro slide={slide} stats={wrappedData.stats} />;
            case 'top1': return <SlideTop1 slide={slide} topItem={wrappedData.topContent[0]} tmdbData={tmdbData} />;
            case 'top5': return <SlideTop5 slide={slide} topContent={wrappedData.topContent} tmdbData={tmdbData} />;
            case 'persona': return <SlidePersona slide={slide} persona={wrappedData.persona} />;
            case 'peak-month': return <SlidePeakMonth slide={slide} peakMonth={wrappedData.peakMonth} />;
            case 'top-genres': return <SlideTopGenres slide={slide} topGenres={wrappedData.topGenres} />;
            case 'listening-clock': return <SlideListeningClock slide={slide} listeningClock={wrappedData.listeningClock} peakHour={wrappedData.peakHour} />;
            case 'streak': return <SlideStreak slide={slide} stats={wrappedData.stats} />;
            case 'fun-fact': return <SlideFunFact slide={slide} />;
            case 'closing': return <SlideClosing slide={slide} stats={wrappedData.stats} />;
            case 'detailed-stats': return <SlideDetailedStats slide={slide} data={wrappedData} tmdbData={tmdbData} />;
            default: return null;
        }
    };

    const wrappedRequirementCards = wrappedProgress ? [
        {
            key: 'minutes',
            label: t('wrapped.requirementWatchTime'),
            current: formatCompactDuration(wrappedProgress.current.minutes, t),
            required: formatCompactDuration(wrappedProgress.requirements.minutes, t)
        },
        {
            key: 'uniqueTitles',
            label: t('wrapped.requirementTitles'),
            current: wrappedProgress.current.uniqueTitles.toLocaleString(i18n.language),
            required: wrappedProgress.requirements.uniqueTitles.toLocaleString(i18n.language)
        },
        {
            key: 'sessions',
            label: t('wrapped.requirementSessions'),
            current: wrappedProgress.current.sessions.toLocaleString(i18n.language),
            required: wrappedProgress.requirements.sessions.toLocaleString(i18n.language)
        },
        {
            key: 'activeDays',
            label: t('wrapped.requirementActiveDays'),
            current: wrappedProgress.current.activeDays.toLocaleString(i18n.language),
            required: wrappedProgress.requirements.activeDays.toLocaleString(i18n.language)
        }
    ] : [];

    const wrappedMissingItems = wrappedProgress ? [
        wrappedProgress.missing.minutes > 0
            ? t('wrapped.missingWatchTime', { value: formatCompactDuration(wrappedProgress.missing.minutes, t) })
            : null,
        wrappedProgress.missing.uniqueTitles > 0
            ? t('wrapped.missingTitles', { count: wrappedProgress.missing.uniqueTitles })
            : null,
        wrappedProgress.missing.sessions > 0
            ? t('wrapped.missingSessions', { count: wrappedProgress.missing.sessions })
            : null,
        wrappedProgress.missing.activeDays > 0
            ? t('wrapped.missingActiveDays', { count: wrappedProgress.missing.activeDays })
            : null
    ].filter(Boolean) as string[] : [];

    // Loading state
    if (loading) {
        return (
            <SquareBackground mode={bgMode} borderColor="rgba(168, 85, 247, 0.15)" className="fixed inset-0 z-50 bg-black flex items-center justify-center">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(168,85,247,0.2),transparent_50%)]" />
                <div className="flex flex-col items-center justify-center w-full h-full">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="text-center relative z-10"
                    >
                        <motion.div
                            animate={{ rotate: 360 }}
                            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                            className="w-20 h-20 mx-auto mb-6 rounded-full border-4 border-purple-500/30 border-t-purple-400"
                        />
                        <h2 className="text-2xl font-bold text-white mb-2">{t('wrapped.preparingWrapped')}</h2>
                        <p className="text-purple-400">{t('wrapped.analyzingYear')}</p>
                    </motion.div>
                </div>
            </SquareBackground>
        );
    }

    // No data state — show a cool message
    if (!wrappedData || noData) {
        return (
            <SquareBackground mode={bgMode} borderColor="rgba(168, 85, 247, 0.15)" className="fixed inset-0 z-50 bg-black flex items-center justify-center">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(168,85,247,0.2),transparent_50%)]" />
                <div className="flex flex-col items-center justify-center w-full h-full px-6 text-center relative z-10">
                    {/* Back button */}
                    <button
                        onClick={() => navigate(-1)}
                        className="absolute top-4 left-4 p-3 rounded-full bg-white/5 hover:bg-white/10 backdrop-blur-lg transition-colors border border-white/10"
                    >
                        <X className="w-5 h-5 text-white" />
                    </button>

                    <motion.div
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: 'spring', duration: 0.8 }}
                        className="mb-8"
                    >
                        <div className="relative">
                            <div className="absolute inset-0 blur-3xl bg-purple-500/20 rounded-full scale-150" />
                            <span className="relative text-8xl md:text-9xl">🍿</span>
                        </div>
                    </motion.div>

                    <motion.h1
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                        className="text-3xl md:text-5xl font-black mb-4"
                    >
                        <ShinyText text={`Wrapped ${year}`} speed={2} color="#a855f7" shineColor="#ffffff" className="" />
                    </motion.h1>

                    <motion.p
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.4 }}
                        className="text-xl md:text-2xl text-purple-300 font-semibold mb-3"
                    >
                        {t('wrapped.notEnoughDataYet')}
                    </motion.p>

                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.6 }}
                        className="max-w-2xl w-full"
                    >
                        <AnimatedBorderCard
                            highlightColor="168 85 247"
                            backgroundColor="0 0 0"
                            className="p-6 md:p-8 backdrop-blur-xl"
                        >
                            <p className="text-base md:text-lg text-white/80 leading-relaxed mb-4">
                                {t('wrapped.notEnoughDataForYear', { year })}
                            </p>
                            {wrappedProgress && (
                                <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-4 text-left">
                                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4">
                                        <div>
                                            <p className="text-sm font-semibold text-white">{t('wrapped.unlockRequirementsTitle')}</p>
                                            <p className="text-xs text-white/60">
                                                {t('wrapped.unlockRequirementsDesc', {
                                                    time: formatCompactDuration(wrappedProgress.requirements.minutes, t),
                                                    titles: wrappedProgress.requirements.uniqueTitles,
                                                    sessions: wrappedProgress.requirements.sessions,
                                                    days: wrappedProgress.requirements.activeDays
                                                })}
                                            </p>
                                        </div>
                                        <div className="inline-flex items-center rounded-full border border-purple-400/20 bg-purple-500/10 px-3 py-1 text-xs font-semibold text-purple-200">
                                            {t('wrapped.progressPercent', { percent: wrappedProgress.completionPercent })}
                                        </div>
                                    </div>

                                    <div className="grid gap-3 md:grid-cols-2 mb-4">
                                        {wrappedRequirementCards.map((item) => (
                                            <div key={item.key} className="rounded-xl border border-white/8 bg-black/20 p-3">
                                                <p className="text-[11px] uppercase tracking-[0.18em] text-white/40 mb-1">{item.label}</p>
                                                <p className="text-lg font-bold text-white">
                                                    {item.current}
                                                    <span className="ml-2 text-sm font-medium text-white/45">/ {item.required}</span>
                                                </p>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="rounded-xl border border-amber-400/15 bg-amber-500/5 p-3">
                                        <p className="text-sm font-medium text-amber-200 mb-2">
                                            {t('wrapped.missingSummaryTitle', { count: wrappedProgress.missingCriteriaCount })}
                                        </p>
                                        <p className="text-xs text-white/65 leading-relaxed mb-3">
                                            {t('wrapped.missingTimeInfo', {
                                                current: formatCompactDuration(wrappedProgress.current.minutes, t),
                                                required: formatCompactDuration(wrappedProgress.requirements.minutes, t),
                                                remaining: formatCompactDuration(wrappedProgress.missing.minutes, t)
                                            })}
                                        </p>
                                        <div className="flex flex-wrap gap-2">
                                            {wrappedMissingItems.map((item) => (
                                                <span
                                                    key={item}
                                                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/75"
                                                >
                                                    {item}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                            <p className="text-white/60 text-sm leading-relaxed mb-6">
                                {t('wrapped.keepWatching')}
                            </p>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => navigate('/')}
                                className="px-6 py-3 bg-gradient-to-r from-purple-500 to-fuchsia-500 rounded-full text-white font-bold text-sm hover:shadow-lg hover:shadow-purple-500/25 transition-shadow"
                            >
                                {t('wrapped.backToHome')}
                            </motion.button>
                        </AnimatedBorderCard>
                    </motion.div>

                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1 }}
                        className="mt-8 text-white/30 text-sm"
                    >
                        {t('wrapped.wrappedWaiting')}
                    </motion.p>
                </div>
            </SquareBackground>
        );
    }

    const currentSlideData = wrappedData.slides[currentSlide];
    const bg = slideBackgrounds[currentSlideData.type] || slideBackgrounds.intro;
    const isTop1Slide = currentSlideData.type === 'top1';

    // Get trailer key for the #1 content (used as full-page background on top1 slide)
    const top1Item = wrappedData.topContent[0];
    const top1Tmdb = top1Item?.tmdbId ? tmdbData.get(top1Item.tmdbId) : null;
    const trailerKey = top1Tmdb?.trailerKey;

    return (
        <div className="fixed inset-0 z-50 bg-black text-white">
            {/* Full-screen trailer background for top1 slide */}
            {trailerKey && (
                <div 
                    className="absolute inset-0 z-0 pointer-events-none overflow-hidden transition-opacity duration-700"
                    style={{ opacity: isTop1Slide ? 1 : 0 }}
                >
                    <iframe
                        src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&mute=1&controls=0&showinfo=0&rel=0&loop=1&playlist=${trailerKey}&modestbranding=1&playsinline=1&iv_load_policy=3&disablekb=1&fs=0&cc_load_policy=0&start=10&origin=${window.location.origin}`}
                        title="Trailer background"
                        allow="autoplay; encrypted-media"
                        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
                        style={{ border: 'none', width: '300vw', height: '300vh' }}
                        tabIndex={-1}
                    />
                    {/* Dark overlays */}
                    <div className="absolute inset-0 bg-black/50" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-black/50" />
                    <div className="absolute top-0 left-0 right-0 h-28 bg-gradient-to-b from-black to-transparent" />
                    <div className="absolute bottom-0 left-0 right-0 h-28 bg-gradient-to-t from-black to-transparent" />
                </div>
            )}

            {/* SquareBackground + gradients — hidden when trailer is playing on top1 */}
            <div 
                className="absolute inset-0 z-0 transition-opacity duration-700"
                style={{ opacity: isTop1Slide && trailerKey ? 0 : 1 }}
            >
                <SquareBackground
                    mode={bgMode}
                    borderColor={bg.color}
                    className="absolute inset-0"
                />
            {/* Dynamic gradient based on slide */}
            <AnimatePresence mode="wait">
                <motion.div
                    key={currentSlide}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5 }}
                    className={`absolute inset-0 bg-gradient-to-b ${bg.gradient}`}
                />
            </AnimatePresence>

            {/* Ambient glow */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] blur-[120px] opacity-30 pointer-events-none"
                style={{ background: `radial-gradient(circle, ${bg.color.replace('0.15', '0.4')}, transparent)` }}
            />
            </div>

            {/* Top bar */}
            <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between z-20">
                <button
                    onClick={() => navigate(-1)}
                    className="p-3 rounded-full bg-white/5 hover:bg-white/10 backdrop-blur-lg transition-colors border border-white/10"
                >
                    <X className="w-5 h-5 text-white" />
                </button>

                <div className="flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-amber-400" />
                    <ShinyText text={`Movix Wrapped ${year}`} speed={3} color="#fbbf24" shineColor="#ffffff" className="font-bold" />
                </div>

                <button
                    onClick={() => {
                        if (navigator.share) {
                            navigator.share({
                                title: t('wrapped.shareTitle', { year }),
                                text: t('wrapped.shareText', { hours: wrappedData.stats.totalHours }),
                                url: window.location.href,
                            });
                        }
                    }}
                    className="p-3 rounded-full bg-white/5 hover:bg-white/10 backdrop-blur-lg transition-colors border border-white/10"
                >
                    <Share2 className="w-5 h-5 text-white" />
                </button>
            </div>

            {/* Progress indicators */}
            <div className="absolute top-16 left-4 right-4 flex gap-1 z-20">
                {wrappedData.slides.map((_, index) => (
                    <button
                        key={index}
                        onClick={() => goToSlide(index)}
                        className="flex-1 h-1 rounded-full overflow-hidden bg-white/10 hover:bg-white/20 transition-colors"
                    >
                        <motion.div
                            initial={false}
                            animate={{ width: index <= currentSlide ? '100%' : '0%' }}
                            transition={{ duration: 0.3 }}
                            className="h-full bg-white"
                        />
                    </button>
                ))}
            </div>

            {/* Slide Content */}
            <div className="absolute inset-0" onClick={nextSlide}>
                <AnimatePresence mode="wait" custom={direction}>
                    <motion.div
                        key={currentSlide}
                        custom={direction}
                        initial={{ opacity: 0, x: direction * 100 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -direction * 100 }}
                        transition={{ duration: 0.3 }}
                        drag="x" // Enable drag for all slides
                        dragConstraints={{ left: 0, right: 0 }}
                        dragElastic={0.2}
                        onDragEnd={handleDragEnd}
                        className={`absolute inset-0 flex items-center justify-center ${
                            (currentSlideData.type === 'top5' || currentSlideData.type === 'detailed-stats') 
                            ? '' 
                            : 'pt-20 pb-28'
                        }`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {renderSlideContent(currentSlideData)}
                    </motion.div>
                </AnimatePresence>
            </div>

            {/* Navigation arrows */}
            <div className="absolute bottom-8 left-4 right-4 flex justify-between items-center z-20 pointer-events-none">
                <button
                    onClick={(e) => { e.stopPropagation(); prevSlide(); }}
                    disabled={currentSlide === 0}
                    className={`p-4 rounded-full bg-white/5 hover:bg-white/10 backdrop-blur-lg transition-all pointer-events-auto border border-white/10 ${
                        currentSlide === 0 ? 'opacity-30 cursor-not-allowed' : ''
                    }`}
                >
                    <ChevronLeft className="w-6 h-6 text-white" />
                </button>

                <div className="flex items-center gap-2 text-white/40 text-sm">
                    <span>{currentSlide + 1}</span>
                    <span>/</span>
                    <span>{wrappedData.slides.length}</span>
                </div>

                <button
                    onClick={(e) => { e.stopPropagation(); nextSlide(); }}
                    disabled={currentSlide === wrappedData.slides.length - 1}
                    className={`p-4 rounded-full bg-white/5 hover:bg-white/10 backdrop-blur-lg transition-all pointer-events-auto border border-white/10 ${
                        currentSlide === wrappedData.slides.length - 1 ? 'opacity-30 cursor-not-allowed' : ''
                    }`}
                >
                    <ChevronRight className="w-6 h-6 text-white" />
                </button>
            </div>

            {/* Tap hint */}
            <motion.div
                initial={{ opacity: 0.6 }}
                animate={{ opacity: 0 }}
                transition={{ delay: 3, duration: 1 }}
                className="absolute bottom-24 left-0 right-0 text-center text-white/30 text-sm pointer-events-none"
            >
                {t('wrapped.tapOrSwipe')}
            </motion.div>
        </div>
    );
};

export default WrappedPage;
