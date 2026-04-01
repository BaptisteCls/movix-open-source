import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Star, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { encodeId } from '../utils/idEncoder';

interface SearchResult {
    id: number;
    title?: string;
    name?: string;
    media_type: 'movie' | 'tv';
    poster_path: string;
    backdrop_path?: string;
    release_date?: string;
    first_air_date?: string;
    vote_average: number;
    overview?: string;
}

const POSTER_FALLBACK = `data:image/svg+xml,${encodeURIComponent('<svg width="500" height="750" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="50%" y="50%" fill="#444" font-size="36" font-family="sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>')}`;

// ─── Grid Card ──────────────────────────────────────────────────────────────

interface GridCardProps {
    item: SearchResult;
    index: number;
    movieLabel: string;
    serieLabel: string;
}

export const SearchGridCard: React.FC<GridCardProps> = React.memo(({ item, index, movieLabel, serieLabel }) => {
    const [starred, setStarred] = useState(() => {
        const list = JSON.parse(localStorage.getItem(`watchlist_${item.media_type}`) || '[]');
        return list.some((m: any) => m.id === item.id);
    });

    const title = item.title || item.name || '';

    const toggle = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const key = `watchlist_${item.media_type}`;
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        const exists = list.some((m: any) => m.id === item.id);
        if (exists) {
            localStorage.setItem(key, JSON.stringify(list.filter((m: any) => m.id !== item.id)));
            setStarred(false);
            toast.success(`${title} retiré de la liste`, { duration: 2000 });
        } else {
            list.push({ id: item.id, type: item.media_type, title, poster_path: item.poster_path, addedAt: new Date().toISOString() });
            localStorage.setItem(key, JSON.stringify(list));
            setStarred(true);
            toast.success(`${title} ajouté à la liste`, { duration: 2000 });
        }
    }, [item, title]);

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: Math.min(index * 0.03, 0.5) }}
            whileHover={{ scale: 1.05 }}
            className="relative group rounded-xl overflow-hidden bg-white/5 border border-white/10 hover:border-white/20 transition-colors"
        >
            {/* Badge */}
            <span className="absolute top-2 left-2 z-10 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-wider text-white/80">
                {item.media_type === 'tv' ? serieLabel : movieLabel}
            </span>

            {/* Watchlist button */}
            <Tooltip>
                <TooltipTrigger asChild>
                    <motion.button
                        onClick={toggle}
                        whileTap={{ scale: 0.7 }}
                        className={`absolute top-2 right-2 z-20 p-2 rounded-full backdrop-blur-sm transition-all duration-200 md:opacity-0 md:group-hover:opacity-100 ${starred ? 'bg-yellow-500/20 border border-yellow-400/30' : 'bg-black/40 hover:bg-black/60'}`}
                    >
                        <motion.div
                            key={starred ? 'on' : 'off'}
                            initial={{ scale: 0.3, rotate: -45 }}
                            animate={{ scale: 1, rotate: 0 }}
                            transition={{ type: 'spring', stiffness: 500, damping: 15 }}
                        >
                            <Star
                                className={`w-4 h-4 transition-colors duration-150 ${starred ? 'text-yellow-400' : 'text-white'}`}
                                fill={starred ? 'currentColor' : 'none'}
                            />
                        </motion.div>
                    </motion.button>
                </TooltipTrigger>
                <TooltipContent>
                    {starred ? 'Retirer de ma liste' : 'Ajouter à ma liste'}
                </TooltipContent>
            </Tooltip>

            {/* Poster */}
            <img
                src={`https://image.tmdb.org/t/p/w500${item.poster_path}`}
                alt={item.title || item.name}
                className="w-full aspect-[2/3] object-cover"
                onError={(e) => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = POSTER_FALLBACK; }}
            />

            {/* Hover overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

            {/* Hover content */}
            <div className="absolute bottom-0 left-0 right-0 p-3 md:opacity-0 md:group-hover:opacity-100 md:translate-y-2 md:group-hover:translate-y-0 transition-all duration-300 pointer-events-none">
                <h3 className="text-sm font-bold text-white line-clamp-1 mb-1">
                    {item.title || item.name}
                </h3>
                <div className="flex items-center gap-2 mb-1">
                    <div className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-yellow-400" />
                        <span className="text-xs text-white/80">
                            {item.vote_average ? item.vote_average.toFixed(1) : 'N/A'}
                        </span>
                    </div>
                    <span className="text-xs text-white/60">
                        {new Date(item.release_date || item.first_air_date || '').getFullYear()}
                    </span>
                </div>
                <p className="text-xs text-white/50 line-clamp-3">
                    {item.overview}
                </p>
            </div>

            {/* Main clickable area */}
            <Link to={`/${item.media_type}/${encodeId(item.id)}`} className="absolute inset-0 z-10">
                <span className="sr-only">{item.title || item.name}</span>
            </Link>
        </motion.div>
    );
});

SearchGridCard.displayName = 'SearchGridCard';

// ─── List Card ──────────────────────────────────────────────────────────────

interface ListCardProps {
    item: SearchResult;
    index: number;
    movieLabel: string;
    serieLabel: string;
    watchlistLabel: string;
    removeLabel: string;
    noDescLabel: string;
}

export const SearchListCard: React.FC<ListCardProps> = React.memo(({ item, index, movieLabel, serieLabel, watchlistLabel, removeLabel, noDescLabel }) => {
    const [starred, setStarred] = useState(() => {
        const list = JSON.parse(localStorage.getItem(`watchlist_${item.media_type}`) || '[]');
        return list.some((m: any) => m.id === item.id);
    });

    const title = item.title || item.name || '';

    const toggle = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const key = `watchlist_${item.media_type}`;
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        const exists = list.some((m: any) => m.id === item.id);
        if (exists) {
            localStorage.setItem(key, JSON.stringify(list.filter((m: any) => m.id !== item.id)));
            setStarred(false);
            toast.success(`${title} retiré de la liste`, { duration: 2000 });
        } else {
            list.push({ id: item.id, type: item.media_type, title, poster_path: item.poster_path, addedAt: new Date().toISOString() });
            localStorage.setItem(key, JSON.stringify(list));
            setStarred(true);
            toast.success(`${title} ajouté à la liste`, { duration: 2000 });
        }
    }, [item, title]);

    return (
        <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.6) }}
        >
            <Link
                to={`/${item.media_type}/${encodeId(item.id)}`}
                className="flex gap-4 p-4 rounded-xl bg-white/5 border border-white/10 hover:border-white/20 hover:bg-white/[0.08] transition-all group"
            >
                <div className="relative flex-shrink-0">
                    <span className="absolute top-1 left-1 z-10 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-wider text-white/80">
                        {item.media_type === 'tv' ? serieLabel : movieLabel}
                    </span>
                    <img
                        className="w-20 h-28 sm:w-24 sm:h-36 rounded-lg object-cover"
                        src={item.poster_path ? `https://image.tmdb.org/t/p/w342${item.poster_path}` : POSTER_FALLBACK}
                        alt={item.title || item.name}
                        onError={(e) => { (e.target as HTMLImageElement).onerror = null; (e.target as HTMLImageElement).src = POSTER_FALLBACK; }}
                    />
                </div>
                <div className="flex-1 min-w-0 flex flex-col justify-between">
                    <div>
                        <h3 className="font-semibold text-white line-clamp-1 group-hover:text-red-400 transition-colors">
                            {item.title || item.name}
                        </h3>
                        <div className="flex items-center gap-3 text-sm text-white/50 mt-1">
                            <div className="flex items-center gap-1">
                                <Star className="w-4 h-4 text-yellow-400" fill="currentColor" />
                                <span>{item.vote_average?.toFixed(1) || 'N/A'}</span>
                            </div>
                            <div className="flex items-center gap-1">
                                <Calendar className="w-4 h-4 text-white/30" />
                                <span>{new Date(item.release_date || item.first_air_date || '').getFullYear() || 'N/A'}</span>
                            </div>
                        </div>
                        <p className="text-sm text-white/40 line-clamp-2 mt-2">
                            {item.overview || noDescLabel}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <motion.button
                                    onClick={toggle}
                                    whileTap={{ scale: 0.85 }}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all duration-200 relative z-10 ${starred ? 'bg-yellow-500/10 border border-yellow-400/20' : 'bg-white/5 hover:bg-white/10'}`}
                                >
                                    <motion.div
                                        key={starred ? 'on' : 'off'}
                                        initial={{ scale: 0.3, rotate: -45 }}
                                        animate={{ scale: 1, rotate: 0 }}
                                        transition={{ type: 'spring', stiffness: 500, damping: 15 }}
                                    >
                                        <Star
                                            className={`w-4 h-4 transition-colors duration-150 ${starred ? 'text-yellow-400' : 'text-white/60'}`}
                                            fill={starred ? 'currentColor' : 'none'}
                                        />
                                    </motion.div>
                                    <span className={`text-xs hidden md:inline transition-colors duration-150 ${starred ? 'text-yellow-400/80' : 'text-white/60'}`}>
                                        {starred ? removeLabel : watchlistLabel}
                                    </span>
                                </motion.button>
                            </TooltipTrigger>
                            <TooltipContent>
                                {starred ? 'Retirer de ma liste' : 'Ajouter à ma liste'}
                            </TooltipContent>
                        </Tooltip>
                    </div>
                </div>
            </Link>
        </motion.div>
    );
});

SearchListCard.displayName = 'SearchListCard';
