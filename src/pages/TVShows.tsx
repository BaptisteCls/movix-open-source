import React, { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { Star, Calendar, Info, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import HeroSlider from '../components/HeroSlider';
import EmblaCarousel from '../components/EmblaCarousel';
import GridSkeleton from '../components/skeletons/GridSkeleton';
import EmblaCarouselGenres from '../components/EmblaCarouselGenres';
import ContentRowSkeleton from '../components/skeletons/ContentRowSkeleton';
import LazySection from '../components/LazySection';
import { encodeId } from '../utils/idEncoder';

import TelegramPromotion from '../components/TelegramPromotion';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import { getTmdbLanguage } from '../i18n';

// Nombre de sections à charger immédiatement
const IMMEDIATE_LOAD_COUNT = 2;

// Genre IDs from TMDB
const GENRES: Record<number, string> = {
  28: 'Action',
  12: 'Aventure',
  16: 'Animation',
  35: 'Comédie',
  80: 'Crime',
  99: 'Documentaire',
  18: 'Drame',
  10751: 'Famille',
  14: 'Fantastique',
  36: 'Histoire',
  27: 'Horreur',
  10402: 'Musique',
  9648: 'Mystère',
  10749: 'Romance',
  878: 'Science-Fiction',
  10770: 'Téléfilm',
  53: 'Thriller',
  10752: 'Guerre',
  37: 'Western',
  // TV specific genres
  10759: 'Action & Aventure',
  10762: 'Enfants',
  10763: 'Actualités',
  10764: 'Téléréalité',
  10765: 'Science-Fiction & Fantastique',
  10766: 'Feuilleton',
  10767: 'Talk-show',
  10768: 'Guerre & Politique'
};

// CSS pour l'animation du hero slider
const heroSliderStyles = `
@keyframes fadeInOut {
  0% { opacity: 0; transform: scale(1.05) translateX(-10%); }
  10% { opacity: 1; transform: scale(1) translateX(-5%); }
  90% { opacity: 1; transform: scale(1) translateX(5%); }
  100% { opacity: 0; transform: scale(1.05) translateX(10%); }
}

@keyframes slideInFromRight {
  0% { transform: translateX(50px); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}

@keyframes slideInFromLeft {
  0% { transform: translateX(-50px); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}

.poster-row.no-scroll {
  overflow: hidden !important;
}

.slide-in-right {
  animation: slideInFromRight 0.7s ease-out forwards;
}

.slide-in-left {
  animation: slideInFromLeft 0.7s ease-out forwards;
}

.section-title {
  font-size: 1.5rem;
  font-weight: 700;
  position: relative;
  background: linear-gradient(90deg, #ffffff, #e2e2e2);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0px 2px 4px rgba(0, 0, 0, 0.3);
  letter-spacing: 0.5px;
  padding-bottom: 0.5rem;
  text-transform: uppercase;
  display: inline-block;
  animation: fadeInTitle 0.8s ease-out forwards;
  transition: all 0.3s ease;
}

.section-title:hover {
  background: linear-gradient(90deg, #ff3333, #ff9999);
  -webkit-background-clip: text;
  background-clip: text;
  transform: translateY(-2px);
  text-shadow: 0px 4px 8px rgba(255, 51, 51, 0.4);
}

@keyframes fadeInTitle {
  0% { opacity: 0; transform: translateY(10px); }
  100% { opacity: 1; transform: translateY(0); }
}

.section-title::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 40px;
  height: 3px;
  background: linear-gradient(90deg, #f11 0%, #f66 100%);
  border-radius: 3px;
  animation: expandWidth 0.6s ease-out forwards 0.3s;
  transform-origin: left;
  transition: all 0.3s ease;
}

.section-title:hover::after {
  width: 100%;
  background: linear-gradient(90deg, #ff3333, #ff9999);
}

@keyframes expandWidth {
  0% { width: 0; }
  100% { width: 40px; }
}

.content-row-container {
  padding: 5px 0px 40px 0px;
  margin-top: -30px;
  overflow: visible !important;
  position: relative;
  z-index: 1;
}

.poster-row {
  display: flex;
  gap: 10px;
  transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  padding: 5rem 0.5rem;
  margin: -5rem -0.5rem;
  overflow-x: auto !important;
  overflow-y: visible !important;
  scrollbar-width: none;
  -ms-overflow-style: none;
  position: relative;
  z-index: 5;
}

.poster-row::-webkit-scrollbar {
  display: none;
}

.poster-container {
  position: relative;
  transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  margin: 0;
  flex-shrink: 0;
  z-index: 10;
  overflow: visible;
  padding: 0;
}

.poster-container:hover {
  z-index: 50;
  overflow: visible;
  transform: translateZ(0);
}

.poster-container:hover ~ .poster-container {
  transform: translateX(0);
}

.poster-card {
  position: relative;
  transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  transform-origin: 0% 0%;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
  overflow: visible;
  cursor: pointer;
  z-index: 10;
  margin-bottom: 3rem;
  margin-top: 1rem;
}

.poster-card:hover {
  transform: scale(1.5);
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
  z-index: 100;
  overflow: visible;
  transform-style: preserve-3d;
  position: relative;
}

.poster-container:has(.poster-card:hover) ~ .poster-container {
  transform: translateX(100px);
}

.poster-container:hover ~ .poster-container {
  transition-delay: 0.12s;
  transform: translateX(100px);
}

.poster-card .hover-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #141414;
  opacity: 0;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  transition: opacity 0.3s ease;
  overflow: hidden;
}

.poster-card:hover .hover-content {
  opacity: 1;
}

.poster-card:hover img.poster {
  opacity: 0;
}

.card-buttons {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
  align-items: center;
}

.card-buttons a {
  transition: transform 0.2s ease;
}

.card-buttons a:hover {
  transform: scale(1.2);
}

.top-content-row {
  margin-top: 10px;
  margin-bottom: 10px;
  padding-left: 64px;
  padding-right: 64px;
  gap: 15px;
}
`;

interface TVShow {
  id: number;
  name: string;
  poster_path: string;
  backdrop_path: string;
  overview: string;
  vote_average: number;
  first_air_date: string;
  genre_ids?: number[];
  media_type: 'tv';
}

interface Category {
  id: string;
  title: string;
  items: TVShow[];
}

const MAIN_API = import.meta.env.VITE_MAIN_API;
const BACKUP_API = import.meta.env.VITE_BACKUP_API;
const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const ITEMS_PER_PAGE = 100;
const ITEMS_PER_BATCH = 20;

interface ContentRowProps {
  title: string;
  items: TVShow[];
  mediaType: string;
  onLoadMore: () => void;
}

const ContentRow: React.FC<ContentRowProps> = ({ title, items, mediaType, onLoadMore }) => {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const [showLeftButton, setShowLeftButton] = useState(false);
  const [showRightButton, setShowRightButton] = useState(true);
  const [hoveredCardIndex, setHoveredCardIndex] = useState<number | null>(null);

  const handleScroll = () => {
    if (rowRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = rowRef.current;
      setShowLeftButton(scrollLeft > 0);
      setShowRightButton(scrollLeft < scrollWidth - clientWidth - 10);
    }
  };

  const scroll = (direction: 'left' | 'right') => {
    if (rowRef.current) {
      const { clientWidth } = rowRef.current;
      const scrollAmount = direction === 'left' ? -clientWidth : clientWidth;
      rowRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    const container = rowRef.current;
    if (!container) return;
    if (hoveredCardIndex === null) return;

    // Prevent horizontal scroll but allow vertical scroll
    const preventScroll = (e: Event) => {
      if (e instanceof WheelEvent && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };
    // Prevent keyboard scroll
    const preventKey = (e: KeyboardEvent) => {
      const keys = ['ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End'];
      if (keys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };
    container.addEventListener('wheel', preventScroll, { passive: false });
    container.addEventListener('keydown', preventKey, { passive: false });
    return () => {
      container.removeEventListener('wheel', preventScroll);
      container.removeEventListener('keydown', preventKey);
    };
  }, [hoveredCardIndex]);

  return (
    <div className="mb-8">
      <div className="flex justify-between items-center mb-4 px-4 md:px-8 relative z-20">
        <h2 className="section-title">{title}</h2>
      </div>

      <div className="relative w-full group">
        {showLeftButton && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-black to-transparent px-5 z-30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center h-full"
            aria-label="Scroll left"
          >
            <div className="bg-black/40 rounded-full p-2.5">
              <ChevronLeft className="w-6 h-6 text-white" />
            </div>
          </button>
        )}

        <div
          ref={rowRef}
          onScroll={handleScroll}
          className={`poster-row flex overflow-x-auto scrollbar-hide scroll-smooth px-4 md:px-8 w-full ${hoveredCardIndex !== null ? 'no-scroll' : ''}`}
          style={{
            overflowY: 'visible',
            overflowX: hoveredCardIndex !== null ? 'hidden' : 'auto',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          {items.map((item, index) => (
            <div
              key={item.id}
              className="poster-container flex-none w-32 md:w-48 relative"
              onMouseEnter={() => setHoveredCardIndex(index)}
              onMouseLeave={() => setHoveredCardIndex(null)}
            >
              <div
                className="poster-card"
              >
                {/* Default poster image */}
                <img
                  src={`https://image.tmdb.org/t/p/w500${item.poster_path}`}
                  alt={item.name}
                  className="w-full h-auto object-cover rounded-lg poster"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.onerror = null;
                    target.src = 'data:image/svg+xml;utf8,<svg width=\'500\' height=\'750\' xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 500 750\' preserveAspectRatio=\'xMidYMid meet\'><rect width=\'100%\' height=\'100%\' fill=\'%23333\'/><text x=\'50%\' y=\'50%\' fill=\'%23ccc\' font-size=\'50\' font-family=\'Arial, sans-serif\' text-anchor=\'middle\' dy=\'.3em\'>MOVIX</text></svg>';
                  }}
                />
                {/* Hover card with landscape layout */}
                <div className="hover-content">
                  {/* Top section: landscape image */}
                  <div className="w-full h-24 md:h-28 relative">
                    <img
                      src={`https://image.tmdb.org/t/p/w780${item.backdrop_path || item.poster_path}`}
                      alt={item.name}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.onerror = null;
                        target.src = 'data:image/svg+xml;utf8,<svg width=\'500\' height=\'281\' xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 500 281\' preserveAspectRatio=\'xMidYMid meet\'><rect width=\'100%\' height=\'100%\' fill=\'%23333\'/><text x=\'50%\' y=\'50%\' fill=\'%23ccc\' font-size=\'30\' font-family=\'Arial, sans-serif\' text-anchor=\'middle\' dy=\'.3em\'>MOVIX</text></svg>';
                      }}
                    />
                    {/* Play and Info buttons overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-black/20 flex items-center justify-center">
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // Watchlist logic pour les séries
                          const storageKey = 'watchlist_tv';
                          const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                          const exists = typeWatchlist.some((media: any) => media.id === item.id);
                          if (!exists) {
                            typeWatchlist.push({
                              id: item.id,
                              type: 'tv',
                              title: item.name,
                              poster_path: item.poster_path,
                              addedAt: new Date().toISOString()
                            });
                            localStorage.setItem(storageKey, JSON.stringify(typeWatchlist));
                            toast.success('Ajouté à la liste', { duration: 2000 });
                            const button = e.currentTarget;
                            button.querySelector('svg')?.classList.add('text-yellow-400');
                            button.querySelector('svg')?.setAttribute('fill', 'currentColor');
                          } else {
                            const updatedTypeWatchlist = typeWatchlist.filter((media: any) => media.id !== item.id);
                            localStorage.setItem(storageKey, JSON.stringify(updatedTypeWatchlist));
                            toast.success('Retiré de la liste', { duration: 2000 });
                            const button = e.currentTarget;
                            button.querySelector('svg')?.classList.remove('text-yellow-400');
                            button.querySelector('svg')?.setAttribute('fill', 'black');
                          }
                        }}
                        className="bg-white rounded-full p-2 transform transition-transform hover:scale-110 mr-2 z-20 group/watchlist relative"
                      >
                        <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover/watchlist:opacity-100 transition-opacity whitespace-nowrap hidden md:block">
                          {(() => {
                            const storageKey = 'watchlist_tv';
                            const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                            const exists = typeWatchlist.some((media: any) => media.id === item.id);
                            return exists ? t('search.removeFromWatchlist') : t('search.addToWatchlist');
                          })()}
                        </div>
                        <Star
                          className={`w-4 h-4 ${(() => {
                            const storageKey = 'watchlist_tv';
                            const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                            const exists = typeWatchlist.some((media: any) => media.id === item.id);
                            return exists ? 'text-yellow-400' : 'text-black';
                          })()}`}
                          fill={(() => {
                            const storageKey = 'watchlist_tv';
                            const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                            const exists = typeWatchlist.some((media: any) => media.id === item.id);
                            return exists ? 'currentColor' : 'black';
                          })()}
                        />
                      </button>
                      <Link to={`/tv/${encodeId(item.id)}`} className="bg-black/60 border border-white/40 rounded-full p-2 transform transition-transform hover:scale-110 z-20 group/info relative">
                        <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover/info:opacity-100 transition-opacity whitespace-nowrap hidden md:block">
                          Voir l'affiche
                        </div>
                        <Info className="w-4 h-4 text-white" />
                      </Link>
                    </div>
                  </div>
                  {/* Bottom section: information */}
                  <div className="p-3 flex flex-col flex-grow">
                    <h3 className="text-sm font-bold text-white line-clamp-1 mb-1">
                      {item.name}
                    </h3>
                    {/* Rating and release date just below title */}
                    <div className="flex items-center gap-2 mb-1">
                      <div className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-yellow-400" />
                        <span className="text-xs text-gray-300">
                          {item.vote_average ? item.vote_average.toFixed(1) : 'N/A'}
                        </span>
                      </div>
                      {item.first_air_date && (
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-gray-400" />
                          <span className="text-xs text-gray-300">
                            {new Date(item.first_air_date).getFullYear()}
                          </span>
                        </div>
                      )}
                    </div>
                    {/* Description/Overview after rating and release date */}
                    <p className="text-xs text-gray-300 line-clamp-4">
                      {item.overview}
                    </p>
                  </div>
                </div>
                {/* Main clickable area */}
                <Link to={`/tv/${encodeId(item.id)}`} className="absolute inset-0 z-10">
                  <span className="sr-only">{item.name}</span>
                </Link>
              </div>
            </div>
          ))}
        </div>

        {showRightButton && (
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-0 bottom-0 bg-gradient-to-l from-black to-transparent px-5 z-30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center h-full"
            aria-label="Scroll right"
          >
            <div className="bg-black/40 rounded-full p-2.5">
              <ChevronRight className="w-6 h-6 text-white" />
            </div>
          </button>
        )}
      </div>
    </div>
  );
};

const TVShows: React.FC = () => {
  const { t } = useTranslation();
  const [tvShows, setTVShows] = useState<TVShow[]>([]);
  const [featuredShows, setFeaturedShows] = useState<TVShow[]>([]);
  const [currentShowIndex, setCurrentShowIndex] = useState(0);
  const [topContent, setTopContent] = useState<TVShow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sliderIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [isTop10CardHovered, setIsTop10CardHovered] = useState(false);
  const top10RowRef = useRef<HTMLDivElement>(null);
  const [hoveredCardIndex, setHoveredCardIndex] = useState<number | null>(null);
  const [genreItems, setGenreItems] = useState<{ id: number; name: string; route: string; imageUrl?: string }[]>([
    { id: 10759, name: 'Action & Aventure', route: '/genre/tv/10759' },
    { id: 16, name: 'Animation', route: '/genre/tv/16' },
    { id: 35, name: 'Comédie', route: '/genre/tv/35' },
    { id: 80, name: 'Crime', route: '/genre/tv/80' },
    { id: 99, name: 'Documentaire', route: '/genre/tv/99' },
    { id: 18, name: 'Drame', route: '/genre/tv/18' },
    { id: 10751, name: 'Famille', route: '/genre/tv/10751' },
    { id: 10762, name: 'Enfants', route: '/genre/tv/10762' },
    { id: 9648, name: 'Mystère', route: '/genre/tv/9648' },
    { id: 10763, name: 'Actualités', route: '/genre/tv/10763' },
    { id: 10764, name: 'Téléréalité', route: '/genre/tv/10764' },
    { id: 10765, name: 'SF & Fantastique', route: '/genre/tv/10765' },
    { id: 10766, name: 'Feuilleton', route: '/genre/tv/10766' },
    { id: 10767, name: 'Talk-show', route: '/genre/tv/10767' },
    { id: 10768, name: 'Guerre & Politique', route: '/genre/tv/10768' },
  ]);

  // Track page visit for Movix Wrapped
  useWrappedTracker({
    mode: 'page',
    pageData: { pageName: 'tv-shows' },
  });

  // Organize content by genres
  const organizeContentByCategories = (items: TVShow[]) => {
    // Filter out items without overview or poster
    const filteredItems = items.filter(item => item.overview && item.poster_path);

    // Create genre-based categories
    const genreMap: Record<number, TVShow[]> = {};

    filteredItems.forEach(item => {
      if (item.genre_ids && item.genre_ids.length > 0) {
        item.genre_ids.forEach(genreId => {
          if (!genreMap[genreId]) {
            genreMap[genreId] = [];
          }
          // Only add if not already in the array
          if (!genreMap[genreId].some(show => show.id === item.id)) {
            genreMap[genreId].push(item);
          }
        });
      }
    });

    // Convert the genre map to categories array
    const newCategories: Category[] = Object.entries(genreMap)
      .map(([genreId, items]) => ({
        id: genreId,
        title: GENRES[Number(genreId)] || `Category ${genreId}`,
        items: items.slice(0, 15) // Réduit de 100 à 15 pour de meilleures performances
      }))
      .filter(category => category.items.length >= 3) // Réduit le minimum requis à 3 items au lieu de 5
      .sort((a, b) => b.items.length - a.items.length) // Sort by number of items
      .slice(0, 10); // Réduit de 100 à 10 catégories pour de meilleures performances

    // Additional dynamic categories based on air date
    // First, deduplicate the items array by TV show ID
    const uniqueShows = filteredItems.reduce((unique: TVShow[], item) => {
      if (!unique.some(show => show.id === item.id)) {
        unique.push(item);
      }
      return unique;
    }, []);

    const recentShows = uniqueShows
      .filter(item => item.first_air_date)
      .sort((a, b) => {
        const dateA = a.first_air_date ? new Date(a.first_air_date).getTime() : 0;
        const dateB = b.first_air_date ? new Date(b.first_air_date).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15); // Réduit de 40 à 15 pour de meilleures performances

    if (recentShows.length >= 5) {
      newCategories.unshift({
        id: 'recent-shows',
        title: t('home.recentShows'),
        items: recentShows
      });
    }

    setCategories(newCategories);
  };

  const fetchTVShows = async () => {
    try {
      setLoading(true);

      // Check for cached data first
      const cachedData = sessionStorage.getItem('movix_tvshows_data');
      const cacheTimestamp = sessionStorage.getItem('movix_tvshows_data_timestamp');

      // Use cache if it exists and is less than 15 minutes old
      if (cachedData && cacheTimestamp) {
        const isRecent = (Date.now() - parseInt(cacheTimestamp)) < 15 * 60 * 1000; // 15 minutes

        if (isRecent) {
          const parsedData = JSON.parse(cachedData);
          setFeaturedShows(parsedData.featuredShows || []);
          setTopContent(parsedData.topContent || []);
          setTVShows(parsedData.tvShows || []);
          // Regenerate categories from cached TV shows
          if (parsedData.tvShows && parsedData.tvShows.length > 0) {
            organizeContentByCategories(parsedData.tvShows);
          }
          setLoading(false);
          return;
        }
      }

      // Obtenir les séries avec un focus sur celles avec production élevée / adaptations cinéma
      const tmdbResponse = await axios.get(`https://api.themoviedb.org/3/discover/tv`, {
        params: {
          api_key: TMDB_API_KEY,
          language: getTmdbLanguage(),
          page: 1,
          sort_by: 'popularity.desc',
          with_genres: '10759|18|10768', // Action & Adventure, Drama, War (genres souvent liés aux adaptations cinéma)
          vote_average_gte: 7.0, // Filtre pour les séries mieux notées (souvent à plus grand budget)
          'vote_count.gte': 100, // Avoir un nombre minimum de votes
          include_adult: false
        }
      });

      // Obtenir plus de variété pour les genres
      const genreRequests = [
        // Séries comédie (pages 1-3)
        ...Array.from({ length: 3 }, (_, i) =>
          axios.get(`https://api.themoviedb.org/3/discover/tv`, {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage(),
              page: i + 1,
              sort_by: 'popularity.desc',
              with_genres: '35', // Comédie
              include_adult: false
            }
          })
        ),
        // Séries science-fiction et fantastique (pages 1-3)
        ...Array.from({ length: 3 }, (_, i) =>
          axios.get(`https://api.themoviedb.org/3/discover/tv`, {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage(),
              page: i + 1,
              sort_by: 'popularity.desc',
              with_genres: '10765', // Science-Fiction & Fantastique
              include_adult: false
            }
          })
        ),
        // Séries crime (pages 1-3)
        ...Array.from({ length: 3 }, (_, i) =>
          axios.get(`https://api.themoviedb.org/3/discover/tv`, {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage(),
              page: i + 1,
              sort_by: 'popularity.desc',
              with_genres: '80', // Crime
              include_adult: false
            }
          })
        ),
        // Séries documentaires (pages 1-3)
        ...Array.from({ length: 3 }, (_, i) =>
          axios.get(`https://api.themoviedb.org/3/discover/tv`, {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage(),
              page: i + 1,
              sort_by: 'popularity.desc',
              with_genres: '99', // Documentaire
              include_adult: false
            }
          })
        ),
        // Séries dramatiques (pages 1-3)
        ...Array.from({ length: 3 }, (_, i) =>
          axios.get(`https://api.themoviedb.org/3/discover/tv`, {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage(),
              page: i + 1,
              sort_by: 'popularity.desc',
              with_genres: '18', // Drame
              include_adult: false
            }
          })
        ),
        // Séries mystère (pages 1-3)
        ...Array.from({ length: 3 }, (_, i) =>
          axios.get(`https://api.themoviedb.org/3/discover/tv`, {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage(),
              page: i + 1,
              sort_by: 'popularity.desc',
              with_genres: '9648', // Mystère
              include_adult: false
            }
          })
        ),
      ];

      const genreResponses = await Promise.all(genreRequests);

      // Filter out shows without poster_path or overview
      const validShows = tmdbResponse.data.results.filter((show: TVShow) =>
        show.poster_path && show.overview && show.overview.trim() !== '').map((show: TVShow) => ({
          ...show,
          media_type: 'tv'
        }));

      // Extraire et ajouter les séries supplémentaires
      const additionalShows = genreResponses.flatMap(response =>
        response.data.results
          .filter((show: TVShow) => show.poster_path && show.overview && show.overview.trim() !== '')
          .map((show: TVShow) => ({
            ...show,
            media_type: 'tv'
          }))
      );

      // Combiner toutes les séries en évitant les doublons
      const allShows = [...validShows];

      additionalShows.forEach(newShow => {
        if (!allShows.some(show => show.id === newShow.id)) {
          allShows.push(newShow);
        }
      });

      if (allShows.length > 0) {
        // Sélectionner plusieurs séries pour le slider
        const heroShows = allShows
          .filter((show: TVShow) => show.backdrop_path && show.overview)
          .slice(0, 8); // Augmenté: de 5 à 8 séries dans le slider
        setFeaturedShows(heroShows);

        // Get trending TV shows for today
        try {
          const trendingResponse = await axios.get(`https://api.themoviedb.org/3/trending/tv/day`, {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage()
            }
          });

          // Filtrer les séries pour exclure celles qui ne sont pas encore sorties et les séries chinoises
          const today = new Date();
          const trendingShows = trendingResponse.data.results
            .filter((show: TVShow) => {
              // Vérifier si la série est sortie
              if (!show.first_air_date) return false;
              const releaseDate = new Date(show.first_air_date);
              // Compare dates by setting time to midnight for accurate same-day comparison
              const releaseDateOnly = new Date(releaseDate.setHours(0, 0, 0, 0));
              const todayOnly = new Date(today.setHours(0, 0, 0, 0));
              if (releaseDateOnly > todayOnly) return false;

              // Vérifier si la série a une affiche et une description
              if (!show.poster_path || !show.overview) return false;

              // Vérifier si la série n'est pas chinoise (en excluant les séries avec des caractères chinois dans le titre)
              const hasChineseChars = /[\u4e00-\u9fff]/.test(show.name);
              if (hasChineseChars) return false;

              return true;
            })
            .slice(0, 10);

          // Ajouter le type de média pour chaque série
          const trendingWithMediaType = trendingShows.map((show: TVShow) => ({
            ...show,
            media_type: 'tv'
          }));

          setTopContent(trendingWithMediaType);
        } catch (error) {
          console.error('Error fetching trending TV shows:', error);
          // Fallback au tri par note moyenne si les séries tendances échouent
          const top10 = [...allShows]
            .sort((a, b) => b.vote_average - a.vote_average)
            .slice(0, 10);
          setTopContent(top10);
        }

        // Organize content by categories
        organizeContentByCategories(allShows);
      }

      setTVShows(allShows);

      // Cache the data
      const heroShows = allShows
        .filter((show: TVShow) => show.backdrop_path && show.overview)
        .slice(0, 8);

      // Get top content for cache
      let topContentCache: TVShow[] = [];
      try {
        const today = new Date();
        topContentCache = allShows
          .filter((show: TVShow) => {
            if (!show.first_air_date) return false;
            const releaseDate = new Date(show.first_air_date);
            const releaseDateOnly = new Date(releaseDate.setHours(0, 0, 0, 0));
            const todayOnly = new Date(new Date(today).setHours(0, 0, 0, 0));
            if (releaseDateOnly > todayOnly) return false;
            if (!show.poster_path || !show.overview) return false;
            const hasChineseChars = /[\u4e00-\u9fff]/.test(show.name);
            if (hasChineseChars) return false;
            return true;
          })
          .slice(0, 10);
      } catch {
        topContentCache = [...allShows]
          .sort((a, b) => b.vote_average - a.vote_average)
          .slice(0, 10);
      }

      const cacheData = {
        featuredShows: heroShows,
        topContent: topContentCache,
        tvShows: allShows,
        categories: [] // Categories will be regenerated from tvShows
      };

      sessionStorage.setItem('movix_tvshows_data', JSON.stringify(cacheData));
      sessionStorage.setItem('movix_tvshows_data_timestamp', Date.now().toString());
    } catch (error) {
      console.error('Error fetching TV shows:', error);
      setError(t('home.errorLoadingData'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTVShows();
  }, []);

  // Fetch representative TMDB images for each TV genre and cache for 24h
  useEffect(() => {
    const cacheKey = 'movix_tv_genre_images';
    const cacheTsKey = 'movix_tv_genre_images_ts';
    const cached = sessionStorage.getItem(cacheKey);
    const cachedTs = sessionStorage.getItem(cacheTsKey);
    const oneDayMs = 24 * 60 * 60 * 1000;
    const load = async () => {
      try {
        if (cached && cachedTs && (Date.now() - parseInt(cachedTs)) < oneDayMs) {
          const parsed = JSON.parse(cached);
          setGenreItems(parsed);
          return;
        }
        const updated = await Promise.all(genreItems.map(async (g) => {
          try {
            const resp = await axios.get('https://api.themoviedb.org/3/discover/tv', {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: g.id,
                sort_by: 'popularity.desc',
                include_adult: false,
                page: 1
              }
            });
            const first = Array.isArray(resp.data?.results) ? resp.data.results.find((m: any) => m.backdrop_path || m.poster_path) : null;
            const path = first?.backdrop_path || first?.poster_path || '';
            const imageUrl = path ? `https://image.tmdb.org/t/p/w780${path}` : undefined;
            return { ...g, imageUrl };
          } catch (_) {
            return g;
          }
        }));
        setGenreItems(updated);
        sessionStorage.setItem(cacheKey, JSON.stringify(updated));
        sessionStorage.setItem(cacheTsKey, Date.now().toString());
      } catch (_) {
        // ignore
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Simple title for TV Shows page
    document.title = `${t('tvShows.title')} - Movix`;
  }, []);

  // Auto-rotate featured shows
  useEffect(() => {
    if (featuredShows.length > 1) {
      // Clear any existing interval when dependencies change
      if (sliderIntervalRef.current) {
        clearInterval(sliderIntervalRef.current);
      }

      // Set new interval
      sliderIntervalRef.current = setInterval(() => {
        setCurrentShowIndex(prevIndex =>
          prevIndex === featuredShows.length - 1 ? 0 : prevIndex + 1
        );
      }, 6000);

      // Cleanup on unmount
      return () => {
        if (sliderIntervalRef.current) {
          clearInterval(sliderIntervalRef.current);
        }
      };
    }
  }, [featuredShows, currentShowIndex]);

  // Function to handle manual navigation
  const handleManualNavigation = (index: number) => {
    // Reset timer when manually changing slide
    if (sliderIntervalRef.current) {
      clearInterval(sliderIntervalRef.current);
    }

    setCurrentShowIndex(index);

    // Set new interval
    sliderIntervalRef.current = setInterval(() => {
      setCurrentShowIndex(prevIndex =>
        prevIndex === featuredShows.length - 1 ? 0 : prevIndex + 1
      );
    }, 6000);
  };

  useEffect(() => {
    const container = top10RowRef.current;
    if (!container) return;
    if (hoveredCardIndex === null) return;

    // Prevent horizontal scroll but allow vertical scroll
    const preventScroll = (e: Event) => {
      if (e instanceof WheelEvent && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };
    // Prevent keyboard scroll
    const preventKey = (e: KeyboardEvent) => {
      const keys = ['ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End'];
      if (keys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    };
    container.addEventListener('wheel', preventScroll, { passive: false });
    container.addEventListener('keydown', preventKey, { passive: false });
    return () => {
      container.removeEventListener('wheel', preventScroll);
      container.removeEventListener('keydown', preventKey);
    };
  }, [hoveredCardIndex]);



  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="bg-red-600/10 text-red-600 px-6 py-4 rounded-lg">
          {error}
        </div>
      </div>
    );
  }

  if (loading && tvShows.length === 0) {
    return (
      <div className="container mx-auto px-4 py-8">
        <GridSkeleton />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <style>{heroSliderStyles}</style>

      {/* Hero Section */}
      <div className="relative w-full">
        {featuredShows.length > 0 && (
          <HeroSlider
            items={featuredShows.map((s) => ({ ...s, media_type: 'tv' } as any))}
          />
        )}
      </div>

      {/* Section visuelle des genres */}
      <div className="w-full bg-black py-6 relative -mt-24 z-[20]">
        <EmblaCarouselGenres
          title={<span><span className="text-white mr-2">🧭</span><span>{t('genres.findByGenre')}</span></span>}
          items={genreItems}
        />
      </div>

      {/* Content Sections */}
      <div className="pb-12 -mt-4 relative z-[20]">
        {/* Top 10 Section - Section prioritaire (index 0) */}
        {topContent.length > 0 && (
          <LazySection index={0} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              title={<span><span className="text-red-600 mr-2">🔥</span><span>{t('home.trendingToday')}</span></span>}
              items={topContent.map((item, idx) => ({
                ...item,
                media_type: 'tv',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || ''
              }))}
              mediaType="top10"
              showRanking={true}
            />
          </LazySection>
        )}

        {/* Category Rows - Lazy loaded (index 1+) */}
        {categories.length > 0 && categories.map((category, catIndex) => (
          <LazySection key={`lazy-${category.id}`} index={1 + catIndex} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              key={category.id}
              title={category.title}
              items={category.items.map((item) => ({
                ...item,
                media_type: 'tv',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || ''
              }))}
              mediaType={category.id}
            />
          </LazySection>
        ))}

        <TelegramPromotion />
      </div>

      {/* Spacer div to maintain structure */}
      <div></div>
    </div>
  );
};

export default TVShows;
