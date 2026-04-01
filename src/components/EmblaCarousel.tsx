import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import { Star, Calendar, Info, Trash, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { encodeId } from '../utils/idEncoder';

interface Media {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  backdrop_path: string;
  overview: string;
  vote_average: number;
  release_date?: string;
  first_air_date?: string;
  media_type: 'movie' | 'tv' | 'collection';
  genre_ids?: number[];
}

interface ContinueWatching {
  id: number;
  title?: string;
  name?: string;
  poster_path: string;
  media_type: 'movie' | 'tv';
  progress?: number;
  lastWatched: string;
  overview?: string;
  backdrop_path?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  currentEpisode?: {
    season: number;
    episode: number;
  };
}

interface EmblaCarouselProps {
  title: string | React.ReactNode;
  items: Media[] | ContinueWatching[];
  mediaType: string;
  isHistory?: boolean;
  onRemoveItem?: (itemId: number, mediaType: string) => void;
  onRemoveAll?: () => void;
  showRanking?: boolean;
  priorityZIndex?: boolean; // Pour les sections qui doivent être au-dessus des autres
  onViewAll?: () => void; // Callback pour le bouton "Voir tous"
}

// Composant d'image avec lazy loading amélioré
interface LazyImageProps {
  src: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  onError?: () => void;
  placeholder?: string;
  draggable?: boolean;
  priority?: boolean; // Pour les images prioritaires (visibles)
}

const LazyImage: React.FC<LazyImageProps> = ({
  src,
  alt,
  className = '',
  style,
  onError,
  placeholder = 'data:image/svg+xml;utf8,<svg width="500" height="750" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 750" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23ccc" font-size="50" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>',
  draggable = false,
  priority = false
}) => {
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [imageSrc, setImageSrc] = useState<string>(placeholder);
  const imgRef = useRef<HTMLImageElement>(null);
  const retryCountRef = useRef(0);
  const maxRetries = 2;

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    // Si l'image est prioritaire, la charger immédiatement
    if (priority && imageState === 'loading') {
      loadImage();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && imageState === 'loading') {
            loadImage();
          }
        });
      },
      { threshold: 0.1, rootMargin: '100px' } // Augmenté pour un meilleur préchargement
    );

    observer.observe(img);
    return () => observer.disconnect();
  }, [src, imageState, priority]);

  const loadImage = useCallback(() => {
    const img = new Image();

    img.onload = () => {
      setImageSrc(src);
      setImageState('loaded');
    };

    img.onerror = () => {
      if (retryCountRef.current < maxRetries) {
        retryCountRef.current++;
        // Retry après un délai
        setTimeout(() => loadImage(), 1000 * retryCountRef.current);
      } else {
        setImageState('error');
        setImageSrc(placeholder);
        onError?.();
      }
    };

    img.src = src;
  }, [src, placeholder, onError]);

  return (
    <div className={`relative ${className}`} style={{
      width: '100%',
      height: '100%',
      ...style
    }}>
      <img
        ref={imgRef}
        src={imageSrc}
        alt={alt}
        className={`w-full h-full object-cover transition-opacity duration-300 ${className.includes('rounded') ? className.match(/rounded-\w+/)?.[0] || '' : ''}`}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: imageState === 'loaded' ? 1 : 0.7,
          ...style
        }}
        draggable={draggable}
      />
      {imageState === 'loading' && (
        <div className="absolute inset-0 bg-gray-800 animate-pulse flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-gray-600 border-t-white rounded-full animate-spin"></div>
        </div>
      )}
    </div>
  );
};

// Memoized card component pour éviter les re-renders inutiles
const CarouselCard = React.memo<{
  item: Media | ContinueWatching;
  index: number;
  itemId: string;
  isHovered: boolean;
  detailPath: string;
  isVisible: boolean;
  inWatchlist: boolean;
  progressData: { percentage: number; position: number; duration: number };
  isHistory: boolean;
  isTouchDevice: boolean;
  showRanking: boolean;
  onHover: () => void;
  onHoverEnd: () => void;
  handleAuxOpen: (e: React.MouseEvent, path: string) => void;
  onRemoveItem?: (itemId: number, mediaType: string) => void;
  watchlistMovies: any[];
  watchlistTV: any[];
}>(({
  item,
  index,
  itemId,
  isHovered,
  detailPath,
  isVisible,
  inWatchlist,
  progressData,
  isHistory,
  isTouchDevice,
  showRanking,
  onHover,
  onHoverEnd,
  handleAuxOpen,
  onRemoveItem
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={`embla-slide flex-none relative ${isHovered ? 'z-[901]' : ''}`}
      style={{
        width: '128px',
        height: '192px',
        ...(typeof window !== 'undefined' && window.innerWidth >= 768 ? {
          width: '192px',
          height: '288px'
        } : {})
      }}
    >
      <div
        className="embla-card rounded-xl overflow-hidden relative"
        style={{
          width: '100%',
          height: '100%'
        }}
        onMouseEnter={onHover}
        onMouseLeave={onHoverEnd}
      >
        {/* Badges: Film/Série for all, Episode only for history items */}
        <div className="absolute top-1 left-1 z-40 flex flex-col gap-1">
          <span className="px-3 py-1.5 whitespace-nowrap font-medium flex gap-1 items-center bg-page-background text-xs text-pantone-100 rounded-md relative">
            {item.media_type === 'tv' ? t('common.series') : item.media_type === 'collection' ? t('common.saga') : t('common.movie')}
          </span>
          {isHistory && 'currentEpisode' in item && item.currentEpisode && item.media_type === 'tv' && (
            <span className="px-3 py-1.5 whitespace-nowrap font-medium flex gap-1 items-center bg-red-600 text-xs text-white rounded-md relative">
              S{item.currentEpisode.season}:E{item.currentEpisode.episode}
            </span>
          )}
        </div>
        {/* Default poster image */}
        <Link
          to={detailPath}
          onAuxClick={(e) => handleAuxOpen(e, detailPath)}
          className="block relative"
          style={{
            width: '100%',
            height: '100%'
          }}
          onClick={(e) => {
            // Ne pas naviguer si on clique sur le bouton de suppression
            const target = e.target as HTMLElement;
            if (target.closest('button[aria-label="Retirer de la liste"]')) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          <LazyImage
            src={`https://image.tmdb.org/t/p/w500${item.poster_path}`}
            alt={item.title || item.name || t('common.poster')}
            className="rounded-xl poster w-full h-full"
            style={{
              opacity: isHovered && !isTouchDevice ? 0 : 1,
              width: '100%',
              height: '100%'
            }}
            draggable={false}
            priority={isVisible}
          />
          <span className="sr-only">{item.title || item.name}</span>
        </Link>

        {/* Ranking number for top 10 */}
        {showRanking && (
          <div className="ranking-number">
            {index + 1}
          </div>
        )}

        {/* Remove button for history items */}
        {isHistory && onRemoveItem && (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemoveItem(item.id, item.media_type);
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            className="absolute top-1 right-1 bg-red-600/90 hover:bg-red-700 rounded-full p-1.5 text-white z-[60] 
                     transition-opacity duration-200"
            aria-label="Retirer de la liste"
            style={{ pointerEvents: 'auto' }}
          >
            <Trash className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Progress bar for history items (non-hover) */}
        {isHistory && progressData.percentage > 0 && !isHovered && (
          <div className="absolute left-0 right-0 bottom-0 h-1 bg-gray-800 overflow-hidden rounded-b-xl">
            <div
              className="h-full bg-red-600"
              style={{ width: `${progressData.percentage}%` }}
            />
          </div>
        )}

        {/* Hover card - only render when hovered */}
        {isHovered && !isTouchDevice && (
          <Link
            to={detailPath}
            onAuxClick={(e) => handleAuxOpen(e, detailPath)}
            className="hover-content select-none rounded-xl overflow-hidden absolute inset-0 z-50 bg-page-background block"
          >
            {/* Badges dans le contenu de survol */}
            <div className="absolute top-1 left-1 z-40 flex flex-col gap-1">
              <span className="px-3 py-1.5 whitespace-nowrap font-medium flex gap-1 items-center bg-page-background text-xs text-pantone-100 rounded-md relative">
                {item.media_type === 'tv' ? t('common.series') : item.media_type === 'collection' ? t('common.saga') : t('common.movie')}
              </span>
              {isHistory && 'currentEpisode' in item && item.currentEpisode && item.media_type === 'tv' && (
                <span className="px-3 py-1.5 whitespace-nowrap font-medium flex gap-1 items-center bg-red-600 text-xs text-white rounded-md relative">
                  S{item.currentEpisode.season}:E{item.currentEpisode.episode}
                </span>
              )}
            </div>

            {/* Top section: landscape image */}
            <div className="w-full h-24 md:h-28 relative">
              <LazyImage
                src={`https://image.tmdb.org/t/p/w780${(item as any).backdrop_path || item.poster_path}`}
                alt={item.title || item.name || t('common.backdrop')}
                className="rounded-t-xl w-full h-full"
                placeholder='data:image/svg+xml;utf8,<svg width="500" height="281" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 281" preserveAspectRatio="xMidYMid meet"><rect width="100%" height="100%" fill="%23333"/><text x="50%" y="50%" fill="%23ccc" font-size="30" font-family="Arial, sans-serif" text-anchor="middle" dy=".3em">MOVIX</text></svg>'
                draggable={false}
                priority={true}
              />

              {/* Play and Info buttons overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-black/20 flex items-center justify-center">
                {!isHistory && (item as any).media_type !== 'collection' && (
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const storageKey = item.media_type === 'movie' ? 'watchlist_movie' : 'watchlist_tv';
                      const typeWatchlist = JSON.parse(localStorage.getItem(storageKey) || '[]');
                      const exists = typeWatchlist.some((media: any) => media.id === item.id);

                      if (!exists) {
                        typeWatchlist.push({
                          id: item.id,
                          type: item.media_type,
                          title: item.title || item.name,
                          poster_path: item.poster_path,
                          addedAt: new Date().toISOString()
                        });
                        localStorage.setItem(storageKey, JSON.stringify(typeWatchlist));

                        const button = e.currentTarget;
                        button.querySelector('svg')!.classList.add('text-yellow-400');
                        button.querySelector('svg')!.setAttribute('fill', 'currentColor');
                      } else {
                        const updatedTypeWatchlist = typeWatchlist.filter((media: any) => media.id !== item.id);
                        localStorage.setItem(storageKey, JSON.stringify(updatedTypeWatchlist));

                        const button = e.currentTarget;
                        button.querySelector('svg')!.classList.remove('text-yellow-400');
                        button.querySelector('svg')!.setAttribute('fill', 'black');
                      }
                    }}
                    onPointerDownCapture={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onPointerUp={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onMouseUp={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDragStart={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    draggable={false}
                    className="bg-white rounded-full p-2 transform transition-transform hover:scale-110 mr-2 z-[60] group/watchlist relative"
                    style={{ pointerEvents: 'auto' }}
                    type="button"
                  >
                    <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover/watchlist:opacity-100 transition-opacity whitespace-nowrap hidden md:block">
                      {inWatchlist ? t('common.removeFromWatchlist') : t('common.addToWatchlist')}
                    </div>
                    <Star
                      className={`w-4 h-4 ${inWatchlist ? 'text-yellow-400' : 'text-black'}`}
                      fill={inWatchlist ? 'currentColor' : 'black'}
                    />
                  </button>
                )}
                <div
                  className="bg-black/60 border border-white/40 rounded-full p-2 transform transition-transform hover:scale-110 z-[60] group/info relative"
                >
                  <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-black text-white text-xs py-1 px-2 rounded opacity-0 group-hover/info:opacity-100 transition-opacity whitespace-nowrap hidden md:block">
                    {t('common.viewPoster')}
                  </div>
                  <Info className="w-4 h-4 text-white" />
                </div>
              </div>
            </div>

            {/* Progress bar for history items (hover) */}
            {isHistory && progressData.percentage > 0 && (
              <div className="w-full h-1 bg-gray-800 overflow-hidden">
                <div
                  className="h-full bg-red-600"
                  style={{ width: `${progressData.percentage}%` }}
                />
              </div>
            )}

            {/* Bottom section: information */}
            <div className="p-3 flex flex-col flex-grow">
              <div className="flex items-start justify-between">
                <h3 className="text-sm font-bold text-white mb-1 truncate">
                  {item.title || item.name}
                </h3>
              </div>

              {/* Info supplémentaire */}
              <div className="flex items-center gap-2 mb-1">
                {/* Note du film/série si disponible */}
                {(item as any).vote_average && (
                  <div className="flex items-center gap-1">
                    <Star className="w-3 h-3 text-yellow-400" />
                    <span className="text-xs text-gray-300">
                      {(item as any).vote_average.toFixed(1)}
                    </span>
                  </div>
                )}

                {/* Date de sortie */}
                {((item as any).release_date || (item as any).first_air_date) && (
                  <div className="flex items-center gap-1">
                    <Calendar className="w-3 h-3 text-gray-400" />
                    <span className="text-xs text-gray-300">
                      {new Date((item as any).release_date || (item as any).first_air_date || '').getFullYear()}
                    </span>
                  </div>
                )}
              </div>

              {/* Description/Overview */}
              <p className="text-xs text-gray-300 line-clamp-4">
                {item.overview}
              </p>
            </div>
          </Link>
        )}
      </div>
    </div>
  );
});

CarouselCard.displayName = 'CarouselCard';

const EmblaCarousel: React.FC<EmblaCarouselProps> = ({
  title,
  items,
  mediaType: _mediaType,
  isHistory = false,
  onRemoveItem,
  onRemoveAll,
  showRanking = false,
  priorityZIndex = false,
  onViewAll
}) => {
  const { t } = useTranslation();
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'start',
    dragFree: true,
    containScroll: 'keepSnaps',
    slidesToScroll: 1,
    skipSnaps: false,
    duration: 25,
    startIndex: 0,
    loop: false
  });
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const [visibleSlides, setVisibleSlides] = useState<number[]>([]);
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);

  // Cache watchlists once using useMemo to avoid repeated localStorage access
  const watchlistMovies = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('watchlist_movie') || '[]'); } catch { return []; }
  }, []);

  const watchlistTV = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('watchlist_tv') || '[]'); } catch { return []; }
  }, []);

  // Limite le nombre d'items pour éviter de surcharger le DOM (max 30 items par carousel)
  const limitedItems = useMemo(() => items.slice(0, 30), [items]);

  const onSelect = useCallback(() => {
    if (!emblaApi) return;

    // Utiliser requestAnimationFrame pour éviter les re-renders excessifs
    requestAnimationFrame(() => {
      // Mettre à jour les slides visibles pour optimiser le chargement des images
      const api = emblaApi as any;
      if (api.slidesInView) {
        const inView = api.slidesInView();
        // Ajouter quelques slides supplémentaires pour le préchargement
        const extended = [...inView];
        inView.forEach((index: number) => {
          if (index > 0 && !extended.includes(index - 1)) extended.push(index - 1);
          if (index < limitedItems.length - 1 && !extended.includes(index + 1)) extended.push(index + 1);
        });
        setVisibleSlides(extended);
      }
      // Mettre à jour l'état des flèches de navigation
      try {
        setCanScrollPrev(Boolean((emblaApi as any).canScrollPrev && emblaApi.canScrollPrev()));
        setCanScrollNext(Boolean((emblaApi as any).canScrollNext && emblaApi.canScrollNext()));
      } catch (_) {
        // no-op
      }
    });
  }, [emblaApi, items.length]);

  useEffect(() => {
    if (!emblaApi) return;
    onSelect();
    emblaApi.on('select', onSelect);
    emblaApi.on('reInit', onSelect);

    return () => {
      emblaApi.off('select', onSelect);
      emblaApi.off('reInit', onSelect);
    };
  }, [emblaApi, onSelect]);

  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(hover: none)');
      setIsTouchDevice(mq.matches);
      const listener = (e: MediaQueryListEvent) => setIsTouchDevice(e.matches);
      if (mq.addEventListener) mq.addEventListener('change', listener);
      else mq.addListener(listener);
      return () => {
        if (mq.removeEventListener) mq.removeEventListener('change', listener);
        else mq.removeListener(listener);
      };
    }
  }, []);

  const getStep = useCallback(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    if (w >= 1536) return 8; // 2K+
    if (w >= 1280) return 6; // xl
    if (w >= 1024) return 5; // lg
    if (w >= 768) return 4;  // md
    return 2;                // sm/xs
  }, []);

  const handlePrev = useCallback((e?: React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!emblaApi) return;
    try {
      const current = emblaApi.selectedScrollSnap();
      const target = Math.max(0, current - getStep());
      emblaApi.scrollTo(target);
    } catch (_) {
      emblaApi.scrollPrev();
    }
  }, [emblaApi, getStep]);

  const handleNext = useCallback((e?: React.MouseEvent) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!emblaApi) return;
    try {
      const current = emblaApi.selectedScrollSnap();
      const snaps = emblaApi.scrollSnapList().length;
      const target = Math.min(snaps - 1, current + getStep());
      emblaApi.scrollTo(target);
    } catch (_) {
      emblaApi.scrollNext();
    }
  }, [emblaApi, getStep]);

  // Open in new tab on middle-click
  const handleAuxOpen = useCallback((e: React.MouseEvent, path: string) => {
    // Middle mouse button is button === 1
    if ((e as React.MouseEvent).button === 1) {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.open(path, '_blank', 'noopener,noreferrer');
      } catch (_) {
        // Fallback without features string
        window.open(path, '_blank');
      }
    }
  }, []);

  // Function to get movie progress data - memoized
  const getMovieProgress = useCallback((movieId: number): { percentage: number, position?: number, duration?: number } => {
    try {
      const progressKey = `progress_${movieId}`;
      const savedData = localStorage.getItem(progressKey);

      if (savedData) {
        const progressData = JSON.parse(savedData);
        if (progressData.position && progressData.duration) {
          return {
            percentage: Math.min((progressData.position / progressData.duration) * 100, 100),
            position: progressData.position,
            duration: progressData.duration
          };
        }
      }
      return { percentage: 0 };
    } catch (error) {
      console.error('Error getting movie progress:', error);
      return { percentage: 0 };
    }
  }, []);

  // Function to get episode progress data - memoized
  const getEpisodeProgress = useCallback((showId: number, seasonNumber: number, episodeNumber: number): { percentage: number, position?: number, duration?: number } => {
    try {
      const progressKey = `progress_tv_${showId}_s${seasonNumber}_e${episodeNumber}`;
      const savedData = localStorage.getItem(progressKey);

      if (savedData) {
        const progressData = JSON.parse(savedData);
        if (progressData.position && progressData.duration) {
          return {
            percentage: Math.min((progressData.position / progressData.duration) * 100, 100),
            position: progressData.position,
            duration: progressData.duration
          };
        }
      }
      return { percentage: 0 };
    } catch (error) {
      console.error('Error getting episode progress:', error);
      return { percentage: 0 };
    }
  }, []);

  // Calculer les z-index en fonction de la priorité
  const baseZIndex = priorityZIndex ? 100 : 10;
  const hoverZIndex = priorityZIndex ? 200 : 50;
  const cardHoverZIndex = priorityZIndex ? 300 : 100;
  const containerZIndex = priorityZIndex ? 1000 : 900;

  return (
    <>
      <style>
        {`
          .embla-slide {
            position: relative;
            transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
            margin: 0;
            flex-shrink: 0;
            z-index: ${baseZIndex};
            overflow: visible;
            padding: 0;
            width: 128px !important; /* Taille fixe pour mobile */
            height: 192px !important; /* Ratio 2:3 pour les affiches */
          }
          
          @media (min-width: 768px) {
            .embla-slide {
              width: 192px !important; /* Taille fixe pour desktop */
              height: 288px !important; /* Ratio 2:3 pour les affiches */
            }
          }
          
          .embla-slide:hover {
            z-index: ${hoverZIndex};
            overflow: visible;
            transform: translateZ(0);
          }
          
          .embla-card {
            position: relative;
            transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
            transform-origin: 0% 0%;
            border-radius: 0.75rem;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
            overflow: visible;
            cursor: pointer;
            z-index: ${baseZIndex};
            width: 100% !important;
            height: 100% !important;
          }
          
          .embla-card:hover {
            transform: scale(1.5);
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
            z-index: ${cardHoverZIndex};
            overflow: visible;
            transform-style: preserve-3d;
            position: relative;
          }
          
          /* Décaler les cards suivantes quand l'animation de hover est active */
          .embla-slide:has(.embla-card:hover) ~ .embla-slide {
            transform: translateX(100px);
          }
          
          /* Solution de secours pour les navigateurs ne supportant pas :has */
          .embla-slide:hover ~ .embla-slide {
            transition-delay: 0.12s;
            transform: translateX(100px);
          }
          
          /* Désactiver les animations au survol sur les appareils tactiles */
          @media (hover: none), (pointer: coarse) {
            .embla-slide:hover {
              z-index: ${baseZIndex};
              transform: none;
            }
            .embla-slide:has(.embla-card:hover) ~ .embla-slide {
              transform: none;
            }
            .embla-slide:hover ~ .embla-slide {
              transform: none;
            }
            .embla-card:hover {
              transform: none;
              box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
              z-index: ${baseZIndex};
            }
          }
          
          /* Forcer les dimensions des images */
          .embla-card img {
            width: 100% !important;
            height: 100% !important;
            object-fit: cover !important;
          }
          
          .embla-card .poster {
            width: 100% !important;
            height: 100% !important;
          }
          
          /* Styles pour les numéros de classement du top 10 */
          .ranking-number {
            position: absolute !important;
            left: -2.5rem !important;
            top: -3.5rem !important;
            z-index: 9999 !important;
            font-size: 6rem !important;
            font-weight: 900 !important;
            color: transparent !important;
            -webkit-text-stroke: 3px #ff0000 !important;
            text-stroke: 3px #ff0000 !important;
            opacity: 0.9 !important;
            user-select: none !important;
            pointer-events: none !important;
            line-height: 1 !important;
            font-family: Arial, sans-serif !important;
          }
          
          @media (min-width: 768px) {
            .ranking-number {
              left: -3rem !important;
              top: -4rem !important;
              font-size: 8rem !important;
            }
          }
        `}
      </style>
      <div className="mb-4 content-row-container select-none -mx-3 md:-mx-4" style={{ zIndex: hoveredCardId ? containerZIndex : (priorityZIndex ? 100 : undefined), position: 'relative' }}>
        <div className="flex justify-between items-center mb-2 px-4 md:px-6 relative">
          <div className="flex items-center gap-3">
            <h2 className="section-title">{title}</h2>
            {onViewAll && (
              <button
                onClick={onViewAll}
                className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-gray-300 hover:text-white bg-gray-800/50 hover:bg-gray-700/70 rounded-full transition-all duration-200 border border-gray-700/50 hover:border-gray-600"
              >
                <span>{t('common.viewAll')}</span>
                <ChevronRight className="w-3 h-3" />
              </button>
            )}
          </div>
          {isHistory && onRemoveAll && items.length > 0 && (
            <button
              onClick={onRemoveAll}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-700/80 hover:bg-red-700 text-white text-xs font-medium rounded-full transition-colors"
              aria-label="Supprimer tout"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('common.deleteAll')}</span>
            </button>
          )}
        </div>

        <div className="relative w-full overflow-visible">
          <div className="overflow-visible" ref={emblaRef}>
            <div
              className={`flex gap-4 pr-4 md:pr-6 ${showRanking ? 'pl-16 md:pl-20' : 'pl-4 md:pl-6'}`}
              style={{ overflow: 'visible' }}
            >
              {limitedItems.map((item, index) => {
                const itemId = `carousel-${item.id}-${item.media_type}-${index}`;
                const isHovered = hoveredCardId === itemId;
                const detailPath = item.media_type === 'collection' ? `/collection/${item.id}` : `/${item.media_type}/${encodeId(item.id)}`;
                const isVisible = visibleSlides.includes(index);
                const inWatchlist = (() => {
                  if ((item as any).media_type === 'collection') return false;
                  const list = item.media_type === 'movie' ? watchlistMovies : watchlistTV;
                  return Array.isArray(list) && list.some((media: any) => media.id === item.id);
                })();

                // Calculate progress for history items
                const progressData = { percentage: 0, position: 0, duration: 0 };

                if (isHistory && 'currentEpisode' in item) {
                  const historyItem = item as ContinueWatching;
                  if (historyItem.media_type === 'tv' && historyItem.currentEpisode) {
                    const epProgress = getEpisodeProgress(historyItem.id, historyItem.currentEpisode.season, historyItem.currentEpisode.episode);
                    progressData.percentage = epProgress.percentage;
                    progressData.position = epProgress.position || 0;
                    progressData.duration = epProgress.duration || 0;
                  } else if (historyItem.media_type === 'movie') {
                    const movieProgress = getMovieProgress(historyItem.id);
                    progressData.percentage = movieProgress.percentage;
                    progressData.position = movieProgress.position || 0;
                    progressData.duration = movieProgress.duration || 0;
                  }
                }

                return (
                  <CarouselCard
                    key={itemId}
                    item={item}
                    index={index}
                    itemId={itemId}
                    isHovered={isHovered}
                    detailPath={detailPath}
                    isVisible={isVisible}
                    inWatchlist={inWatchlist}
                    progressData={progressData}
                    isHistory={isHistory}
                    isTouchDevice={isTouchDevice}
                    showRanking={showRanking}
                    onHover={() => { if (!isTouchDevice) setHoveredCardId(itemId); }}
                    onHoverEnd={() => setHoveredCardId(null)}
                    handleAuxOpen={handleAuxOpen}
                    onRemoveItem={onRemoveItem}
                    watchlistMovies={watchlistMovies}
                    watchlistTV={watchlistTV}
                  />
                );
              })}
              {/* Spacer to ensure last card hover is fully visible */}
              <div className="flex-none w-8 md:w-24" aria-hidden="true" />
            </div>
          </div>
          {/* Boutons de navigation - toujours visibles, y compris sur mobile */}
          <button
            type="button"
            aria-label={t('common.previous')}
            onClick={handlePrev}
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={`absolute left-0 inset-y-0 z-[950] rounded-none bg-black/40 hover:bg-black/50 text-white transition-colors shadow-lg
                     w-10 md:w-12 h-full flex items-center justify-center ${!canScrollPrev ? 'opacity-60' : ''}`}
            style={{ pointerEvents: 'auto' }}
          >
            <ChevronLeft className="w-5 h-5 md:w-6 md:h-6" />
          </button>
          <button
            type="button"
            aria-label={t('common.next')}
            onClick={handleNext}
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            className={`absolute right-0 inset-y-0 z-[950] rounded-none bg-black/40 hover:bg-black/50 text-white transition-colors shadow-lg
                     w-10 md:w-12 h-full flex items-center justify-center ${!canScrollNext ? 'opacity-60' : ''}`}
            style={{ pointerEvents: 'auto' }}
          >
            <ChevronRight className="w-5 h-5 md:w-6 md:h-6" />
          </button>
        </div>
      </div>
    </>
  );
};

export default React.memo(EmblaCarousel);