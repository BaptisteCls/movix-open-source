import React, { useCallback, useEffect, useRef, useState } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { encodeId } from '../utils/idEncoder';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

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
  media_type: 'movie' | 'tv';
  genre_ids?: number[];
}

interface HeroSliderProps {
  items: Media[];
}

const HeroSlider: React.FC<HeroSliderProps> = ({ items }) => {
  const { t } = useTranslation();
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true });
  const autoSlideInterval = useRef<NodeJS.Timeout | null>(null);
  const [logoUrls, setLogoUrls] = useState<{ [key: number]: string | null }>({});
  const logoCache = useRef<{ [key: number]: string | null }>({});

  // Fetch logo URLs for all items with sessionStorage caching
  useEffect(() => {
    const fetchLogos = async () => {
      // Load existing cache from sessionStorage
      const storedCache = sessionStorage.getItem('movix_hero_logos');
      const storedTimestamp = sessionStorage.getItem('movix_hero_logos_timestamp');
      const oneDayMs = 24 * 60 * 60 * 1000;

      let sessionCache: { [key: number]: string | null } = {};
      if (storedCache && storedTimestamp && (Date.now() - parseInt(storedTimestamp)) < oneDayMs) {
        sessionCache = JSON.parse(storedCache);
        logoCache.current = { ...logoCache.current, ...sessionCache };
      }

      const urls: { [key: number]: string | null } = { ...logoCache.current };
      let hasNewLogos = false;

      for (const item of items) {
        // Skip if already cached in memory or sessionStorage
        if (logoCache.current[item.id] !== undefined) {
          urls[item.id] = logoCache.current[item.id];
          continue;
        }

        try {
          const url = `https://api.themoviedb.org/3/${item.media_type}/${item.id}/images?api_key=${TMDB_API_KEY}`;
          const res = await axios.get(url);
          const logos = res.data.logos || [];
          // Prefer French, then English, then any
          const logo = logos.find((l: any) => l.iso_639_1 === 'fr')
            || logos.find((l: any) => l.iso_639_1 === 'en')
            || logos[0];

          const logoUrl = logo && logo.file_path
            ? `https://image.tmdb.org/t/p/original${logo.file_path}`
            : null;

          urls[item.id] = logoUrl;
          logoCache.current[item.id] = logoUrl;
          hasNewLogos = true;
        } catch (error) {
          urls[item.id] = null;
          logoCache.current[item.id] = null;
          hasNewLogos = true;
        }
      }

      if (hasNewLogos) {
        setLogoUrls(urls);
        // Save updated cache to sessionStorage
        sessionStorage.setItem('movix_hero_logos', JSON.stringify(logoCache.current));
        sessionStorage.setItem('movix_hero_logos_timestamp', Date.now().toString());
      }
    };

    fetchLogos();
  }, [items]);

  // Auto-slide every 5s
  const autoSlide = useCallback(() => {
    if (emblaApi) {
      emblaApi.scrollNext();
    }
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    const startAutoSlide = () => {
      if (autoSlideInterval.current) clearInterval(autoSlideInterval.current);
      autoSlideInterval.current = setInterval(autoSlide, 5000);
    };
    startAutoSlide();
    emblaApi.on('pointerDown', () => {
      if (autoSlideInterval.current) clearInterval(autoSlideInterval.current);
    });
    emblaApi.on('pointerUp', startAutoSlide);
    emblaApi.on('select', startAutoSlide);
    return () => {
      if (autoSlideInterval.current) clearInterval(autoSlideInterval.current);
      emblaApi.off('pointerDown', () => { });
      emblaApi.off('pointerUp', () => { });
      emblaApi.off('select', () => { });
    };
  }, [emblaApi, autoSlide]);

  return (
    <div className="embla relative min-h-[700px] h-[75svh] w-full overflow-hidden select-none" style={{ userSelect: 'none', WebkitUserSelect: 'none', MozUserSelect: 'none', msUserSelect: 'none' }}>
      <style>
        {`
          .embla__slide {
            isolation: isolate;
            contain: layout style paint;
          }
          .embla__slide img {
            pointer-events: none;
          }
          .embla__slide .logo-container {
            isolation: isolate;
            contain: layout style paint;
            overflow: hidden;
            position: relative;
          }
          .embla__slide .logo-container img {
            max-width: 100% !important;
            width: auto !important;
            height: auto !important;
            object-fit: contain !important;
            object-position: left center !important;
          }
          @media (max-width: 768px) {
            .embla__slide .logo-container img {
              max-width: 85vw !important;
              max-height: 80px !important;
            }
          }
        `}
      </style>
      <div className="embla__viewport h-full w-full" ref={emblaRef}>
        <div className="embla__container flex h-full">
          {items.map((item) => {
            const logoUrl = logoUrls[item.id];
            return (
              <div className="embla__slide flex-shrink-0 w-full h-full relative" key={item.id} style={{ userSelect: 'none', WebkitUserSelect: 'none', MozUserSelect: 'none', msUserSelect: 'none' }}>
                <img
                  src={`https://image.tmdb.org/t/p/original${item.backdrop_path}`}
                  alt={item.title || item.name}
                  className="absolute inset-0 w-full h-full object-cover z-0"
                  style={{ objectPosition: 'center 0%' }}
                  draggable={false}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent z-10" />
                <div className="absolute inset-x-0 bottom-0 h-48 md:h-64 bg-gradient-to-b from-transparent to-black z-10 pointer-events-none" />
                <div className="absolute bottom-0 left-0 right-0 p-8 md:p-16 space-y-6 md:space-y-8 flex flex-col md:items-start md:justify-end md:text-left z-20 pb-32 md:pb-40">
                  <h1 className="text-4xl md:text-6xl font-bold text-white max-w-2xl flex items-center justify-center md:justify-start min-h-[80px] mx-auto md:mx-0 text-center md:text-left" style={{ minHeight: '80px' }}>
                    {logoUrl ? (
                      <div className="logo-container w-full flex items-center justify-center md:justify-start" style={{ maxWidth: '100vw' }}>
                        <img
                          src={logoUrl}
                          alt={item.title || item.name}
                          className="object-contain"
                          style={{
                            maxWidth: '90vw',
                            maxHeight: '110px',
                            minHeight: '56px',
                            height: 'auto',
                            display: 'block',
                            transform: 'scale(1)',
                            transformOrigin: 'center left',
                            objectFit: 'contain',
                            objectPosition: 'left center',
                          }}
                          draggable={false}
                        />
                      </div>
                    ) : (
                      <span className="break-words" style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}>
                        {item.title || item.name}
                      </span>
                    )}
                  </h1>
                  <p className="text-base md:text-lg max-w-2xl text-gray-300 line-clamp-3 md:line-clamp-none mx-auto md:mx-0 text-center md:text-left">
                    {item.overview && item.overview.length > 200 ? `${item.overview.slice(0, 200)}...` : item.overview}
                  </p>
                  <div className="flex items-center gap-4 justify-center md:justify-start mb-0">
                    <Link
                      to={`/${item.media_type}/${encodeId(item.id)}`}
                      className="inline-flex items-center gap-2 bg-red-600 text-white px-8 py-4 rounded-lg hover:bg-red-700 transition-colors"
                    >
                      <Play className="w-5 h-5" />
                      {t('home.hero.play')}
                    </Link>
                    <Link
                      to={`/${item.media_type}/${encodeId(item.id)}`}
                      className="inline-flex items-center gap-2 bg-gray-800/80 text-white px-8 py-4 rounded-lg hover:bg-gray-700/80 transition-colors"
                    >
                      <span>{t('home.hero.moreInfo')}</span>
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default HeroSlider;
