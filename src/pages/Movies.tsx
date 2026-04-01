import React, { useState, useEffect, useRef, useCallback } from 'react';
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

interface Movie {
  id: number;
  title: string;
  poster_path: string;
  backdrop_path: string;
  overview: string;
  vote_average: number;
  release_date: string;
  genre_ids?: number[];
}

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const MAIN_API = import.meta.env.VITE_MAIN_API;
const BACKUP_API = import.meta.env.VITE_BACKUP_API;
const ITEMS_PER_PAGE = 20;

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
  37: 'Western'
};

interface Category {
  id: string;
  title: string;
  items: Movie[];
}

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

// ContentRow adapté de Home.tsx pour Movie
interface MovieContentRowProps {
  title: string | React.ReactNode;
  items: Movie[];
  mediaType: string;
  onLoadMore: (direction: 'left' | 'right', mediaType?: string) => void;
}

const ContentRow = ({ title, items, mediaType, onLoadMore }: MovieContentRowProps) => {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const [showLeftButton, setShowLeftButton] = React.useState(false);
  const [showRightButton, setShowRightButton] = React.useState(true);
  const [isCardHovered, setIsCardHovered] = React.useState(false);

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

  React.useEffect(() => {
    const container = rowRef.current;
    if (!container) return;
    if (!isCardHovered) return;

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
  }, [isCardHovered]);

  return (
    <div className="mb-4 content-row-container">
      <div className="flex justify-between items-center mb-2 px-4 md:px-8 relative z-10">
        <h2 className="section-title">{title}</h2>
      </div>

      <div className="relative w-full group">
        {showLeftButton && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-0 bottom-0 bg-gradient-to-r from-black to-transparent px-2 z-30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center h-full"
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
          className={`poster-row flex overflow-x-auto scrollbar-hide scroll-smooth px-4 md:px-8 w-full ${isCardHovered ? 'no-scroll' : ''}`}
          style={{
            overflowY: 'visible',
            overflowX: isCardHovered ? 'hidden' : 'auto',
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          {items.map((item) => (
            <div
              key={item.id}
              className="poster-container flex-none w-32 md:w-48 relative"
              onMouseEnter={() => setIsCardHovered(true)}
              onMouseLeave={() => setIsCardHovered(false)}
            >
              <div
                className="poster-card"
              >
                {/* Default poster image */}
                <img
                  src={`https://image.tmdb.org/t/p/w500${item.poster_path}`}
                  alt={item.title}
                  className="w-full h-auto object-cover rounded-lg poster"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.onerror = null;
                    target.src = 'data:image/svg+xml;utf8,<svg width="500" height="750" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 750" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23ccc" font-size="50" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>';
                  }}
                />
                {/* Hover card with landscape layout */}
                <div className="hover-content">
                  {/* Top section: landscape image */}
                  <div className="w-full h-24 md:h-28 relative">
                    <img
                      src={`https://image.tmdb.org/t/p/w780${item.backdrop_path || item.poster_path}`}
                      alt={item.title}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.onerror = null;
                        target.src = 'data:image/svg+xml;utf8,<svg width="500" height="281" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 281" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23ccc" font-size="30" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>';
                      }}
                    />
                    {/* Play and Info buttons overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-black/20 flex items-center justify-center">
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          // Watchlist logic
                          const storageKey = 'watchlist_movie';
                          const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                          const exists = typeWatchlist.some((media: any) => media.id === item.id);
                          if (!exists) {
                            typeWatchlist.push({
                              id: item.id,
                              type: 'movie',
                              title: item.title,
                              poster_path: item.poster_path,
                              addedAt: new Date().toISOString()
                            });
                            localStorage.setItem(storageKey, JSON.stringify(typeWatchlist));
                            // Notification
                            const notification = document.createElement('div');
                            notification.className = 'fixed top-16 right-4 bg-green-500 text-white py-2 px-4 rounded shadow-lg z-50 animate-fadeIn';
                            notification.textContent = t('search.addedToWatchlist');
                            document.body.appendChild(notification);
                            // Forcer un refresh de l'état du bouton
                            const button = e.currentTarget;
                            button.querySelector('svg')!.classList.add('text-yellow-400');
                            button.querySelector('svg')!.setAttribute('fill', 'currentColor');
                            setTimeout(() => {
                              notification.classList.add('animate-fadeOut');
                              setTimeout(() => {
                                document.body.removeChild(notification);
                              }, 500);
                            }, 1500);
                          } else {
                            const updatedTypeWatchlist = typeWatchlist.filter((media: any) => media.id !== item.id);
                            localStorage.setItem(storageKey, JSON.stringify(updatedTypeWatchlist));
                            const button = e.currentTarget;
                            button.querySelector('svg')!.classList.remove('text-yellow-400');
                            button.querySelector('svg')!.setAttribute('fill', 'black');
                            const notification = document.createElement('div');
                            notification.className = 'fixed top-16 right-4 bg-red-500 text-white py-2 px-4 rounded shadow-lg z-50 animate-fadeIn';
                            notification.textContent = t('search.removedFromWatchlist');
                            document.body.appendChild(notification);
                            setTimeout(() => {
                              notification.classList.add('animate-fadeOut');
                              setTimeout(() => {
                                document.body.removeChild(notification);
                              }, 500);
                            }, 1500);
                          }
                        }}
                        className="bg-white rounded-full p-2 transform transition-transform hover:scale-110 mr-2 z-20 group/watchlist relative"
                      >
                        <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover/watchlist:opacity-100 transition-opacity whitespace-nowrap hidden md:block">
                          {(() => {
                            const storageKey = 'watchlist_movie';
                            const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                            const exists = typeWatchlist.some((media: any) => media.id === item.id);
                            return exists ? t('search.removeFromWatchlist') : t('search.addToWatchlist');
                          })()}
                        </div>
                        <Star
                          className={`w-4 h-4 ${(() => {
                            const storageKey = 'watchlist_movie';
                            const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                            const exists = typeWatchlist.some((media: any) => media.id === item.id);
                            return exists ? 'text-yellow-400' : 'text-black';
                          })()}`}
                          fill={(() => {
                            const storageKey = 'watchlist_movie';
                            const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                            const exists = typeWatchlist.some((media: any) => media.id === item.id);
                            return exists ? 'currentColor' : 'black';
                          })()}
                        />
                      </button>
                      <Link to={`/movie/${encodeId(item.id)}`} className="bg-black/60 border border-white/40 rounded-full p-2 transform transition-transform hover:scale-110 z-20 group/info relative">
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
                      {item.title}
                    </h3>
                    {/* Rating and release date just below title */}
                    <div className="flex items-center gap-2 mb-1">
                      <div className="flex items-center gap-1">
                        <Star className="w-3 h-3 text-yellow-400" />
                        <span className="text-xs text-gray-300">
                          {item.vote_average ? item.vote_average.toFixed(1) : 'N/A'}
                        </span>
                      </div>
                      {item.release_date && (
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-gray-400" />
                          <span className="text-xs text-gray-300">
                            {new Date(item.release_date).getFullYear()}
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
                <Link to={`/movie/${encodeId(item.id)}`} className="absolute inset-0 z-10">
                  <span className="sr-only">{item.title}</span>
                </Link>
              </div>
            </div>
          ))}
        </div>
        {showRightButton && (
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-0 bottom-0 bg-gradient-to-l from-black to-transparent px-2 z-30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center h-full"
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

const Movies: React.FC = () => {
  const { t } = useTranslation();
  const [movies, setMovies] = useState<Movie[]>([]);
  const [featuredMovies, setFeaturedMovies] = useState<Movie[]>([]);
  const [topMovies, setTopMovies] = useState<Movie[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [currentMovieIndex, setCurrentMovieIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const observer = useRef<IntersectionObserver>();
  const sliderIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [isTop10CardHovered, setIsTop10CardHovered] = React.useState(false);
  const top10RowRef = React.useRef<HTMLDivElement>(null);
  const [genreItems, setGenreItems] = useState<{ id: number; name: string; route: string; imageUrl?: string }[]>([
    { id: 28, name: 'Action', route: '/genre/movie/28' },
    { id: 12, name: 'Aventure', route: '/genre/movie/12' },
    { id: 16, name: 'Animation', route: '/genre/movie/16' },
    { id: 35, name: 'Comédie', route: '/genre/movie/35' },
    { id: 80, name: 'Crime', route: '/genre/movie/80' },
    { id: 99, name: 'Documentaire', route: '/genre/movie/99' },
    { id: 18, name: 'Drame', route: '/genre/movie/18' },
    { id: 10751, name: 'Famille', route: '/genre/movie/10751' },
    { id: 14, name: 'Fantastique', route: '/genre/movie/14' },
    { id: 36, name: 'Histoire', route: '/genre/movie/36' },
    { id: 27, name: 'Horreur', route: '/genre/movie/27' },
    { id: 10402, name: 'Musique', route: '/genre/movie/10402' },
    { id: 9648, name: 'Mystère', route: '/genre/movie/9648' },
    { id: 10749, name: 'Romance', route: '/genre/movie/10749' },
    { id: 878, name: 'Science-Fiction', route: '/genre/movie/878' },
    { id: 10770, name: 'Téléfilm', route: '/genre/movie/10770' },
    { id: 53, name: 'Thriller', route: '/genre/movie/53' },
    { id: 10752, name: 'Guerre', route: '/genre/movie/10752' },
    { id: 37, name: 'Western', route: '/genre/movie/37' },
  ]);

  // Track page visit for Movix Wrapped
  useWrappedTracker({
    mode: 'page',
    pageData: { pageName: 'movies' },
  });

  const lastMovieElementRef = useCallback((node: HTMLDivElement) => {
    if (loading) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore) {
        setCurrentPage(prevPage => prevPage + 1);
      }
    });
    if (node) observer.current.observe(node);
  }, [loading, hasMore]);

  const fetchMovies = async (pageNumber: number) => {
    try {
      setIsLoadingMore(pageNumber > 1);

      // Check for cached data first (only for first page)
      if (pageNumber === 1) {
        const cachedData = sessionStorage.getItem('movix_movies_data');
        const cacheTimestamp = sessionStorage.getItem('movix_movies_data_timestamp');

        // Use cache if it exists and is less than 15 minutes old
        if (cachedData && cacheTimestamp) {
          const isRecent = (Date.now() - parseInt(cacheTimestamp)) < 15 * 60 * 1000; // 15 minutes

          if (isRecent) {
            const parsedData = JSON.parse(cachedData);
            setFeaturedMovies(parsedData.featuredMovies || []);
            setTopMovies(parsedData.topMovies || []);
            setMovies(parsedData.movies || []);
            // Regenerate categories from cached movies
            if (parsedData.movies && parsedData.movies.length > 0) {
              organizeContentByCategories(parsedData.movies);
            }
            setLoading(false);
            return;
          }
        }
      }

      // Obtenir les films directement depuis TMDB avec filtre des sorties en salle
      const tmdbResponse = await axios.get(`https://api.themoviedb.org/3/discover/movie`, {
        params: {
          api_key: TMDB_API_KEY,
          language: getTmdbLanguage(),
          page: pageNumber,
          sort_by: 'popularity.desc',
          with_release_type: '2|3', // Filter for theatrical (3) and limited theatrical (2) releases
          include_adult: false
        }
      });

      // Get additional data for the first page to create meaningful categories
      let additionalData: Movie[] = [];
      if (pageNumber === 1) {
        // Requêtes pour films par genres
        const genreRequests = [
          // Get top rated movies (pages 1-2)
          ...Array.from({ length: 2 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/movie/top_rated`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                page: i + 1
              }
            })
          ),

          // Get action movies (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '28', // Action
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Get comedy movies (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '35', // Comedy
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Get drama movies (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '18', // Drama
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Genres supplémentaires

          // Films d'horreur (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '27', // Horreur
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Films de science-fiction (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '878', // Science-Fiction
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Films d'aventure (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '12', // Aventure
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Films d'animation (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '16', // Animation
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Films de thriller (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '53', // Thriller
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Films de crime (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '80', // Crime
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          ),

          // Films de famille (pages 1-3)
          ...Array.from({ length: 3 }, (_, i) =>
            axios.get(`https://api.themoviedb.org/3/discover/movie`, {
              params: {
                api_key: TMDB_API_KEY,
                language: getTmdbLanguage(),
                with_genres: '10751', // Famille
                sort_by: 'popularity.desc',
                page: i + 1
              }
            })
          )
        ];

        const responses = await Promise.all(genreRequests);
        additionalData = responses.flatMap(response => response.data.results);
      }

      // Filter out movies without poster_path or overview
      const validMovies = tmdbResponse.data.results.filter((movie: Movie) =>
        movie.poster_path && movie.overview && movie.overview.trim() !== '');

      // Filter additional data too
      const validAdditionalData = additionalData.filter((movie: Movie) =>
        movie.poster_path && movie.overview && movie.overview.trim() !== '');

      const allMovies = [...validMovies, ...validAdditionalData];

      if (pageNumber === 1 && validMovies.length > 0) {
        // Sélectionner plusieurs films pour le slider
        const heroMovies = validMovies
          .filter((movie: Movie) => movie.backdrop_path && movie.overview)
          .slice(0, 8);
        setFeaturedMovies(heroMovies);

        // Get trending movies for today
        try {
          const trendingResponse = await axios.get(`https://api.themoviedb.org/3/trending/movie/day`, {
            params: {
              api_key: TMDB_API_KEY,
              language: getTmdbLanguage()
            }
          });

          // Filtrer les films pour exclure les films chinois et ceux qui ne sont pas encore sortis
          const today = new Date();
          const trendingMovies = trendingResponse.data.results
            .filter((movie: Movie) => {
              // Vérifier si le film est sorti
              if (!movie.release_date) return false;
              const releaseDate = new Date(movie.release_date);
              // Compare dates by setting time to midnight for accurate same-day comparison
              const releaseDateOnly = new Date(releaseDate.setHours(0, 0, 0, 0));
              const todayOnly = new Date(today.setHours(0, 0, 0, 0));
              if (releaseDateOnly > todayOnly) return false;

              // Vérifier si le film a une affiche et une description
              if (!movie.poster_path || !movie.overview) return false;

              // Vérifier si le film n'est pas chinois (en excluant les films avec des caractères chinois dans le titre)
              const hasChineseChars = /[\u4e00-\u9fff]/.test(movie.title);
              if (hasChineseChars) return false;

              return true;
            })
            .slice(0, 10);

          setTopMovies(trendingMovies);
        } catch (error) {
          console.error('Error fetching trending movies:', error);
          // Fallback to sorting by vote average if trending fails
          const top10 = [...allMovies]
            .sort((a, b) => b.vote_average - a.vote_average)
            .filter((movie, index, self) =>
              index === self.findIndex((m) => m.id === movie.id)
            )
            .slice(0, 10);
          setTopMovies(top10);
        }

        // Organize content by categories
        organizeContentByCategories(allMovies);
      }

      setMovies(prev => {
        if (pageNumber === 1) {
          return allMovies;
        }
        const newMovies = validMovies.filter((newMovie: Movie) =>
          !prev.some(existingMovie => existingMovie.id === newMovie.id)
        );
        return [...prev, ...newMovies];
      });

      // Vérifier si c'est la dernière page
      const isLastPage = pageNumber >= tmdbResponse.data.total_pages;
      const hasValidMovies = validMovies.length > 0;
      setHasMore(hasValidMovies && !isLastPage);

      // Cache the data for the first page
      if (pageNumber === 1) {
        // We need to get the categories after organizeContentByCategories is called
        // Since setState is async, we'll save the raw data and let the cache reader handle organization
        const heroMovies = validMovies
          .filter((movie: Movie) => movie.backdrop_path && movie.overview)
          .slice(0, 8);

        // Get trending movies for cache
        let topMoviesCache: Movie[] = [];
        try {
          const today = new Date();
          topMoviesCache = allMovies
            .filter((movie: Movie) => {
              if (!movie.release_date) return false;
              const releaseDate = new Date(movie.release_date);
              const releaseDateOnly = new Date(releaseDate.setHours(0, 0, 0, 0));
              const todayOnly = new Date(new Date(today).setHours(0, 0, 0, 0));
              if (releaseDateOnly > todayOnly) return false;
              if (!movie.poster_path || !movie.overview) return false;
              const hasChineseChars = /[\u4e00-\u9fff]/.test(movie.title);
              if (hasChineseChars) return false;
              return true;
            })
            .slice(0, 10);
        } catch {
          topMoviesCache = [...allMovies]
            .sort((a, b) => b.vote_average - a.vote_average)
            .filter((movie, index, self) => index === self.findIndex((m) => m.id === movie.id))
            .slice(0, 10);
        }

        const cacheData = {
          featuredMovies: heroMovies,
          topMovies: topMoviesCache,
          movies: allMovies,
          categories: [] // Categories will be regenerated from movies
        };

        sessionStorage.setItem('movix_movies_data', JSON.stringify(cacheData));
        sessionStorage.setItem('movix_movies_data_timestamp', Date.now().toString());
      }
    } catch (error) {
      console.error('Error fetching movies:', error);
      setError(t('home.errorLoadingData'));
    } finally {
      setLoading(false);
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    fetchMovies(1);
  }, []);

  // Fetch representative TMDB images for each genre and cache for 1 day
  useEffect(() => {
    const cacheKey = 'movix_movie_genre_images';
    const cacheTsKey = 'movix_movie_genre_images_ts';
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
            const resp = await axios.get('https://api.themoviedb.org/3/discover/movie', {
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
    if (currentPage > 1) {
      fetchMovies(currentPage);
    }
  }, [currentPage]);

  // Auto-rotate featured movies
  useEffect(() => {
    if (featuredMovies.length > 1) {
      // Clear any existing interval when dependencies change
      if (sliderIntervalRef.current) {
        clearInterval(sliderIntervalRef.current);
      }

      // Set new interval
      sliderIntervalRef.current = setInterval(() => {
        setCurrentMovieIndex(prevIndex =>
          prevIndex === featuredMovies.length - 1 ? 0 : prevIndex + 1
        );
      }, 6000);

      // Cleanup on unmount
      return () => {
        if (sliderIntervalRef.current) {
          clearInterval(sliderIntervalRef.current);
        }
      };
    }
  }, [featuredMovies, currentMovieIndex]);

  // Function to handle manual navigation
  const handleManualNavigation = (index: number) => {
    // Reset timer when manually changing slide
    if (sliderIntervalRef.current) {
      clearInterval(sliderIntervalRef.current);
    }

    setCurrentMovieIndex(index);

    // Set new interval
    sliderIntervalRef.current = setInterval(() => {
      setCurrentMovieIndex(prevIndex =>
        prevIndex === featuredMovies.length - 1 ? 0 : prevIndex + 1
      );
    }, 6000);
  };

  const getWatchStatus = (movieId: number) => {
    const watchlistItems = JSON.parse(localStorage.getItem('watchlist_movie') || '[]');
    const favoriteItems = JSON.parse(localStorage.getItem('favorite_movie') || '[]');
    const watchedItems = JSON.parse(localStorage.getItem('watched_movie') || '[]');

    return {
      isInWatchlist: watchlistItems.some((item: any) => item.id === movieId),
      isFavorite: favoriteItems.some((item: any) => item.id === movieId),
      isWatched: watchedItems.some((item: any) => item.id === movieId)
    };
  };

  const updateWatchStatus = (movieId: number, type: string, value: boolean) => {
    const movie = movies.find(m => m.id === movieId);
    if (!movie) return;

    const itemToSave = {
      id: movieId,
      type: 'movie',
      title: movie.title,
      poster_path: movie.poster_path,
      addedAt: new Date().toISOString()
    };

    const key = `${type}_movie`;
    const existingItems = JSON.parse(localStorage.getItem(key) || '[]');

    if (value) {
      const updatedItems = [itemToSave, ...existingItems.filter((item: any) => item.id !== movieId)];
      localStorage.setItem(key, JSON.stringify(updatedItems));
    } else {
      const filteredItems = existingItems.filter((item: any) => item.id !== movieId);
      localStorage.setItem(key, JSON.stringify(filteredItems));
    }
  };

  // Organize content by genres
  const organizeContentByCategories = (items: Movie[]) => {
    // Filter out items without overview or poster
    const filteredItems = items.filter(item => item.overview && item.poster_path);

    // Create genre-based categories
    const genreMap: Record<number, Movie[]> = {};

    filteredItems.forEach(item => {
      if (item.genre_ids && item.genre_ids.length > 0) {
        item.genre_ids.forEach(genreId => {
          if (!genreMap[genreId]) {
            genreMap[genreId] = [];
          }
          // Only add if not already in the array - more robust duplicate checking
          if (!genreMap[genreId].some(movie => movie.id === item.id)) {
            genreMap[genreId].push(item);
          }
        });
      }
    });

    // Convert the genre map to categories array
    const newCategories: Category[] = Object.entries(genreMap)
      .map(([genreId, items]) => {
        // Remove any duplicates again just to be sure
        const uniqueItems = items.filter((movie, index, self) =>
          index === self.findIndex((m) => m.id === movie.id)
        );

        return {
          id: genreId,
          title: GENRES[Number(genreId)] || `Category ${genreId}`,
          items: uniqueItems.slice(0, 15) // Réduit de 40 à 15 pour de meilleures performances
        };
      })
      .filter(category => category.items.length >= 3)
      .sort((a, b) => b.items.length - a.items.length)
      .slice(0, 10); // Réduit de 20 à 10 catégories pour de meilleures performances

    // Additional dynamic categories based on release date
    // First, deduplicate the items array by movie ID
    const uniqueMovies = filteredItems.reduce((unique: Movie[], item) => {
      if (!unique.some(movie => movie.id === item.id)) {
        unique.push(item);
      }
      return unique;
    }, []);

    const recentMovies = uniqueMovies
      .filter(item => item.release_date)
      .sort((a, b) => {
        const dateA = a.release_date ? new Date(a.release_date).getTime() : 0;
        const dateB = b.release_date ? new Date(b.release_date).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 15); // Réduit de 40 à 15 pour de meilleures performances

    if (recentMovies.length >= 5) {
      newCategories.unshift({
        id: 'recent-movies',
        title: t('home.recentMovies'),
        items: recentMovies
      });
    }

    setCategories(newCategories);
  };

  useEffect(() => {
    // Simple title for Movies page
    document.title = `${t('movies.title')} - Movix`;
  }, []);

  React.useEffect(() => {
    const container = top10RowRef.current;
    if (!container) return;
    if (!isTop10CardHovered) return;

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
  }, [isTop10CardHovered]);



  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="bg-red-600/10 text-red-600 px-6 py-4 rounded-lg">
          {error}
        </div>
      </div>
    );
  }

  if (loading && movies.length === 0) {
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
        {featuredMovies.length > 0 && (
          <HeroSlider
            items={featuredMovies.map((m) => ({ ...m, media_type: 'movie' } as any))}
          />
        )}
      </div>

      {/* Content Sections */}
      <div className="pb-12 -mt-24 relative z-[20]">
        {/* Trouver par genre avec titre standardisé - MAINTENANT EN PREMIER */}
        <div className="w-full bg-black py-6 relative -mt-6">
          <EmblaCarouselGenres
            title={<span><span className="text-white mr-2">🧭</span><span>{t('genres.findByGenre')}</span></span>}
            items={genreItems}
          />
        </div>

        {/* Top 10 Section - Section prioritaire (index 0) */}
        {topMovies.length > 0 && (
          <LazySection index={0} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              title={<span><span className="text-red-600 mr-2">🔥</span><span>{t('home.trendingToday')}</span></span>}
              items={topMovies.map((item, idx) => ({
                ...item,
                media_type: 'movie',
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
                media_type: 'movie',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || ''
              }))}
              mediaType={category.id}
            />
          </LazySection>
        ))}

        <TelegramPromotion />

        {/* Movie Category Rows - replaced by unified EmblaCarousel above */}
      </div>
    </div>
  );
};

export default Movies;
