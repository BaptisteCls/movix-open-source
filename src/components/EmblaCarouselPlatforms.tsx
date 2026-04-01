import React, { useCallback, useEffect, useState } from 'react';
import useEmblaCarousel from 'embla-carousel-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

interface PlatformItem {
  id: number;
  src: string;
  alt: string;
  video?: string;
  route: string;
  label?: string;
}

interface EmblaCarouselPlatformsProps {
  title?: string | React.ReactNode;
  items: PlatformItem[];
}

const EmblaCarouselPlatforms: React.FC<EmblaCarouselPlatformsProps> = ({ title, items }) => {
  const { t } = useTranslation();
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'start',
    dragFree: true,
    containScroll: 'keepSnaps',
    slidesToScroll: 1,
    skipSnaps: false,
    duration: 25,
    loop: false
  });
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);

  const onSelect = useCallback(() => {
    if (!emblaApi) return;
    try {
      setCanScrollPrev(Boolean((emblaApi as any).canScrollPrev && emblaApi.canScrollPrev()));
      setCanScrollNext(Boolean((emblaApi as any).canScrollNext && emblaApi.canScrollNext()));
    } catch (_) {
      // noop
    }
  }, [emblaApi]);

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

  const getStep = useCallback(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    if (w >= 1536) return 4; // Larger items, fewer per step
    if (w >= 1280) return 3;
    if (w >= 1024) return 3;
    if (w >= 768) return 2;
    return 1;
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

  return (
    <div className="w-full relative">
      {title && (
        <div className="flex justify-between items-center mb-2 px-4 md:px-6 relative z-10">
          <h2 className="section-title">{title}</h2>
        </div>
      )}
      <div className="relative w-full">
        <div className="overflow-visible" ref={emblaRef}>
          <div className="flex gap-6 pr-8 md:pr-16 py-8 pl-4 md:pl-6">
            {items.map((platform) => (
              <div key={platform.id} className="flex-none">
                <Link to={platform.route} className="platform-link block w-[250px] h-[150px] group select-none">
                  <div
                    className="w-full h-full relative bg-white rounded-xl"
                    onMouseEnter={() => {
                      if (!platform.video?.endsWith('.gif')) {
                        const video = document.getElementById(`video-${platform.id}`) as HTMLVideoElement | null;
                        if (video) {
                          try { video.currentTime = 0; video.play(); } catch (_) {}
                        }
                      }
                    }}
                    onMouseLeave={() => {
                      if (!platform.video?.endsWith('.gif')) {
                        const video = document.getElementById(`video-${platform.id}`) as HTMLVideoElement | null;
                        if (video) {
                          try { video.pause(); video.currentTime = 0; } catch (_) {}
                        }
                      }
                    }}
                  >
                    <img
                      src={platform.src}
                      alt={platform.alt}
                      className="w-full h-full object-contain p-8 group-hover:opacity-0 transition-opacity duration-300"
                      draggable="false"
                      loading="lazy"
                      decoding="async"
                    />
                    {platform.label && (
                      <p className="absolute bottom-2 left-0 right-0 text-center text-white text-xs font-bold bg-black/60 py-1 px-2 mx-4 rounded-lg">
                        {platform.label}
                      </p>
                    )}
                    {platform.video && (
                      platform.video.endsWith('.gif') ? (
                        <img
                          id={`video-${platform.id}`}
                          src={platform.video}
                          alt={platform.alt}
                          className="absolute inset-0 w-full h-full object-cover opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-xl"
                        />
                      ) : (
                        <video
                          id={`video-${platform.id}`}
                          className="absolute inset-0 w-full h-full object-cover opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-xl"
                          loop
                          muted
                          playsInline
                          preload="auto"
                        >
                          <source src={platform.video} type="video/mp4" />
                        </video>
                      )
                    )}
                  </div>
                </Link>
              </div>
            ))}
            <div className="flex-none w-8 md:w-24" aria-hidden="true" />
          </div>
        </div>
        <button
          type="button"
          aria-label={t('common.previous')}
          onClick={handlePrev}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          className={`absolute left-0 inset-y-0 z-[10000] rounded-none bg-black/40 hover:bg-black/50 text-white transition-colors shadow-lg
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
          className={`absolute right-0 inset-y-0 z-[10000] rounded-none bg-black/40 hover:bg-black/50 text-white transition-colors shadow-lg
                     w-10 md:w-12 h-full flex items-center justify-center ${!canScrollNext ? 'opacity-60' : ''}`}
          style={{ pointerEvents: 'auto' }}
        >
          <ChevronRight className="w-5 h-5 md:w-6 md:h-6" />
        </button>
      </div>
    </div>
  );
};

export default React.memo(EmblaCarouselPlatforms);


