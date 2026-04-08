import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import HeroSlider from '../components/HeroSlider';
import EmblaCarousel from '../components/EmblaCarousel';
import GridSkeleton from '../components/skeletons/GridSkeleton';
import EmblaCarouselGenres from '../components/EmblaCarouselGenres';
import LazySection from '../components/LazySection';
import TelegramPromotion from '../components/TelegramPromotion';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import { getTmdbLanguage } from '../i18n';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const IMMEDIATE_LOAD_COUNT = 3;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DATA_CACHE_TTL_MS = 15 * 60 * 1000;
const ANIME_KEYWORD_QUERY = 'anime';
const ANIME_KEYWORD_CACHE_KEY = 'movix_anime_keyword_id';

interface AnimeShow {
  id: number;
  name: string;
  overview: string;
  poster_path: string;
  backdrop_path: string;
  vote_average: number;
  vote_count?: number;
  popularity?: number;
  first_air_date: string;
  genre_ids?: number[];
  media_type?: 'tv';
}

interface Category {
  id: string;
  title: string;
  items: AnimeShow[];
  score?: number;
}

const ANIME_GENRE_CONFIG = [
  { id: 16, labelKey: 'genres.id_16', route: '/genre/anime/16', discoverGenres: '16' },
  { id: 10759, labelKey: 'genres.id_10759', route: '/genre/anime/10759', discoverGenres: '16,10759' },
  { id: 10765, labelKey: 'genres.id_10765', route: '/genre/anime/10765', discoverGenres: '16,10765' },
  { id: 35, labelKey: 'genres.id_35', route: '/genre/anime/35', discoverGenres: '16,35' },
  { id: 18, labelKey: 'genres.id_18', route: '/genre/anime/18', discoverGenres: '16,18' },
  { id: 9648, labelKey: 'genres.id_9648', route: '/genre/anime/9648', discoverGenres: '16,9648' },
  { id: 10751, labelKey: 'genres.id_10751', route: '/genre/anime/10751', discoverGenres: '16,10751' },
  { id: 10762, labelKey: 'genres.id_10762', route: '/genre/anime/10762', discoverGenres: '16,10762' },
] as const;

const CATEGORY_PRIORITY = [10759, 10765, 35, 18, 9648, 10751, 10762];

const pageStyles = `
@keyframes fadeInTitle {
  0% { opacity: 0; transform: translateY(10px); }
  100% { opacity: 1; transform: translateY(0); }
}

@keyframes expandWidth {
  0% { width: 0; }
  100% { width: 40px; }
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

.content-row-container {
  padding: 5px 0px 40px 0px;
  margin-top: -30px;
  overflow: visible !important;
  position: relative;
  z-index: 1;
}
`;

const uniqueById = (items: AnimeShow[]) =>
  items.filter((item, index, self) => index === self.findIndex((candidate) => candidate.id === item.id));

const isValidAnimeShow = (show: AnimeShow) =>
  Boolean(show?.id && show?.name && show?.poster_path && show?.overview?.trim());

const getAnimeReleaseTimestamp = (show: AnimeShow) => {
  if (!show.first_air_date) {
    return 0;
  }

  const timestamp = new Date(show.first_air_date).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const getAnimeSortScore = (show: AnimeShow) => {
  const popularityScore = Math.log10((show.popularity ?? 0) + 1) * 18;
  const voteCountScore = Math.log10((show.vote_count ?? 0) + 1) * 22;
  const ratingScore = (show.vote_average ?? 0) * 12;
  const recencyScore = (() => {
    const releaseTimestamp = getAnimeReleaseTimestamp(show);
    if (!releaseTimestamp) {
      return 0;
    }

    const ageInDays = Math.max(0, (Date.now() - releaseTimestamp) / (1000 * 60 * 60 * 24));
    return Math.max(0, 15 - Math.min(ageInDays / 180, 15));
  })();

  return popularityScore + voteCountScore + ratingScore + recencyScore;
};

const compareAnimeTitles = (left: AnimeShow, right: AnimeShow) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });

const compareAnimeByQuality = (left: AnimeShow, right: AnimeShow) => {
  const scoreDiff = getAnimeSortScore(right) - getAnimeSortScore(left);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const ratingDiff = (right.vote_average ?? 0) - (left.vote_average ?? 0);
  if (ratingDiff !== 0) {
    return ratingDiff;
  }

  const voteCountDiff = (right.vote_count ?? 0) - (left.vote_count ?? 0);
  if (voteCountDiff !== 0) {
    return voteCountDiff;
  }

  const popularityDiff = (right.popularity ?? 0) - (left.popularity ?? 0);
  if (popularityDiff !== 0) {
    return popularityDiff;
  }

  const dateDiff = getAnimeReleaseTimestamp(right) - getAnimeReleaseTimestamp(left);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  return compareAnimeTitles(left, right);
};

const compareAnimeByPopularity = (left: AnimeShow, right: AnimeShow) => {
  const popularityDiff = (right.popularity ?? 0) - (left.popularity ?? 0);
  if (popularityDiff !== 0) {
    return popularityDiff;
  }

  const voteCountDiff = (right.vote_count ?? 0) - (left.vote_count ?? 0);
  if (voteCountDiff !== 0) {
    return voteCountDiff;
  }

  const ratingDiff = (right.vote_average ?? 0) - (left.vote_average ?? 0);
  if (ratingDiff !== 0) {
    return ratingDiff;
  }

  const dateDiff = getAnimeReleaseTimestamp(right) - getAnimeReleaseTimestamp(left);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  return compareAnimeTitles(left, right);
};

const compareAnimeByRecent = (left: AnimeShow, right: AnimeShow) => {
  const dateDiff = getAnimeReleaseTimestamp(right) - getAnimeReleaseTimestamp(left);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  const scoreDiff = getAnimeSortScore(right) - getAnimeSortScore(left);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  return compareAnimeTitles(left, right);
};

const compareAnimeByRating = (left: AnimeShow, right: AnimeShow) => {
  const ratingDiff = (right.vote_average ?? 0) - (left.vote_average ?? 0);
  if (ratingDiff !== 0) {
    return ratingDiff;
  }

  const voteCountDiff = (right.vote_count ?? 0) - (left.vote_count ?? 0);
  if (voteCountDiff !== 0) {
    return voteCountDiff;
  }

  const popularityDiff = (right.popularity ?? 0) - (left.popularity ?? 0);
  if (popularityDiff !== 0) {
    return popularityDiff;
  }

  const dateDiff = getAnimeReleaseTimestamp(right) - getAnimeReleaseTimestamp(left);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  return compareAnimeTitles(left, right);
};

const buildAnimeDiscoverParams = (
  language: string,
  keywordId: number | null,
  overrides: Record<string, string | number | boolean> = {},
) => ({
  api_key: TMDB_API_KEY,
  language,
  include_adult: false,
  with_genres: '16',
  with_origin_country: 'JP',
  sort_by: 'popularity.desc',
  'vote_count.gte': 25,
  ...(keywordId ? { with_keywords: String(keywordId) } : {}),
  ...overrides,
});

const normalizeKeywordLabel = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const resolveAnimeKeywordId = async (): Promise<number | null> => {
  try {
    const cachedKeywordId = sessionStorage.getItem(ANIME_KEYWORD_CACHE_KEY);
    if (cachedKeywordId) {
      const parsedKeywordId = Number(cachedKeywordId);
      if (!Number.isNaN(parsedKeywordId)) {
        return parsedKeywordId;
      }
    }

    const response = await axios.get('https://api.themoviedb.org/3/search/keyword', {
      params: {
        api_key: TMDB_API_KEY,
        query: ANIME_KEYWORD_QUERY,
      },
    });

    const keyword = Array.isArray(response.data?.results)
      ? response.data.results.find((item: { name?: string }) =>
          normalizeKeywordLabel(item.name || '') === ANIME_KEYWORD_QUERY,
        ) ?? response.data.results.find((item: { name?: string }) =>
          normalizeKeywordLabel(item.name || '').includes(ANIME_KEYWORD_QUERY),
        )
      : null;

    if (keyword?.id) {
      sessionStorage.setItem(ANIME_KEYWORD_CACHE_KEY, String(keyword.id));
      return keyword.id;
    }
  } catch (error) {
    console.warn('Unable to resolve anime keyword id:', error);
  }

  return null;
};

const Anime: React.FC = () => {
  const { t, i18n } = useTranslation();
  const tmdbLanguage = getTmdbLanguage();
  const [animeShows, setAnimeShows] = useState<AnimeShow[]>([]);
  const [featuredShows, setFeaturedShows] = useState<AnimeShow[]>([]);
  const [topContent, setTopContent] = useState<AnimeShow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [genreImages, setGenreImages] = useState<Record<number, string | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dataCacheKey = `movix_anime_data_${tmdbLanguage}`;
  const dataCacheTsKey = `${dataCacheKey}_timestamp`;
  const genreImageCacheKey = `movix_anime_genre_images_${tmdbLanguage}`;
  const genreImageCacheTsKey = `${genreImageCacheKey}_timestamp`;

  useWrappedTracker({
    mode: 'page',
    pageData: { pageName: 'anime' },
  });

  const getGenreLabel = useCallback((genreId: number) => {
    return t(`genres.id_${genreId}`, { defaultValue: `Genre ${genreId}` });
  }, [t]);

  const genreItems = useMemo(() => {
    return ANIME_GENRE_CONFIG.map((genre) => ({
      id: genre.id,
      name: t(genre.labelKey),
      route: genre.route,
      imageUrl: genreImages[genre.id],
    }));
  }, [genreImages, t]);

  const rankedAnimeShows = useMemo(() => {
    return uniqueById(animeShows).filter(isValidAnimeShow).sort(compareAnimeByQuality);
  }, [animeShows]);

  const popularAnimeShows = useMemo(() => {
    return [...rankedAnimeShows].sort(compareAnimeByPopularity).slice(0, 15);
  }, [rankedAnimeShows]);

  const topRatedAnimeShows = useMemo(() => {
    return rankedAnimeShows
      .filter((show) => (show.vote_count ?? 0) >= 50)
      .sort(compareAnimeByRating)
      .slice(0, 15);
  }, [rankedAnimeShows]);

  const keywordHighlightShows = useMemo(() => {
    return rankedAnimeShows
      .filter((show) => (show.vote_count ?? 0) >= 100 || (show.vote_average ?? 0) >= 7.2)
      .slice(0, 15);
  }, [rankedAnimeShows]);

  const keywordRecentShows = useMemo(() => {
    return [...rankedAnimeShows].sort(compareAnimeByRecent).slice(0, 15);
  }, [rankedAnimeShows]);

  const organizeContentByCategories = useCallback((items: AnimeShow[]) => {
    const filteredItems = uniqueById(items).filter(isValidAnimeShow);
    const genreMap: Record<number, AnimeShow[]> = {};

    filteredItems.forEach((item) => {
      item.genre_ids?.forEach((genreId) => {
        if (genreId === 16) {
          return;
        }
        if (!genreMap[genreId]) {
          genreMap[genreId] = [];
        }
        if (!genreMap[genreId].some((show) => show.id === item.id)) {
          genreMap[genreId].push(item);
        }
      });
    });

    const priorityMap = new Map(CATEGORY_PRIORITY.map((id, index) => [id, index]));
    const getCategoryRank = (category: Category) => {
      const priorityIndex = priorityMap.get(Number(category.id));
      const priorityBonus = priorityIndex === undefined ? 0 : (priorityMap.size - priorityIndex) * 20;
      return (category.score ?? 0) + priorityBonus;
    };

    const dynamicCategories: Category[] = Object.entries(genreMap)
      .map(([genreId, genreItems]) => {
        const rankedGenreItems = [...genreItems].sort(compareAnimeByQuality);
        const categoryScore = rankedGenreItems.reduce((sum, item) => sum + getAnimeSortScore(item), 0) / Math.max(rankedGenreItems.length, 1);

        return {
          id: genreId,
          title: getGenreLabel(Number(genreId)),
          items: rankedGenreItems.slice(0, 15),
          score: categoryScore,
        };
      })
      .filter((category) => category.items.length >= 3)
      .sort((left, right) => {
        const rankDiff = getCategoryRank(right) - getCategoryRank(left);
        if (rankDiff !== 0) {
          return rankDiff;
        }

        const itemCountDiff = right.items.length - left.items.length;
        if (itemCountDiff !== 0) {
          return itemCountDiff;
        }

        return left.title.localeCompare(right.title, undefined, { sensitivity: 'base', numeric: true });
      })
      .slice(0, 6);

    setCategories(dynamicCategories);
  }, [getGenreLabel]);

  const fetchAnimeShows = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const cachedData = sessionStorage.getItem(dataCacheKey);
      const cacheTimestamp = sessionStorage.getItem(dataCacheTsKey);

      if (cachedData && cacheTimestamp) {
        const isRecent = (Date.now() - Number(cacheTimestamp)) < DATA_CACHE_TTL_MS;
        if (isRecent) {
          const parsed = JSON.parse(cachedData);
          setAnimeShows(parsed.animeShows || []);
          setFeaturedShows(parsed.featuredShows || []);
          setTopContent(parsed.topContent || []);
          organizeContentByCategories(parsed.animeShows || []);
          setLoading(false);
          return;
        }
      }

      const animeKeywordId = await resolveAnimeKeywordId();

      const baseRequests = Array.from({ length: 3 }, (_, index) =>
        axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, { page: index + 1 }),
        }),
      );

      const curatedRequests = [
        axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
            sort_by: 'vote_average.desc',
            'vote_count.gte': 250,
            page: 1,
          }),
        }),
        axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
            sort_by: 'first_air_date.desc',
            'vote_count.gte': 50,
            page: 1,
          }),
        }),
        axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
            with_genres: '16,10759',
            page: 1,
          }),
        }),
        axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
            with_genres: '16,10765',
            page: 1,
          }),
        }),
        axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
            with_genres: '16,35',
            page: 1,
          }),
        }),
        axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
            with_genres: '16,18',
            page: 1,
          }),
        }),
        axios.get('https://api.themoviedb.org/3/discover/tv', {
          params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
            with_genres: '16,9648',
            page: 1,
          }),
        }),
      ];

      const responses = await Promise.all([...baseRequests, ...curatedRequests]);
      const allShows = uniqueById(
        responses.flatMap((response) =>
          (response.data?.results || [])
            .filter(isValidAnimeShow)
            .map((show: AnimeShow) => ({
              ...show,
              media_type: 'tv',
            })),
        ),
      );
      const rankedShows = [...allShows].sort(compareAnimeByQuality);

      const featured = rankedShows.filter((show) => show.backdrop_path && show.overview).slice(0, 8);
      const top = rankedShows.slice(0, 15);

      setAnimeShows(rankedShows);
      setFeaturedShows(featured);
      setTopContent(top);
      organizeContentByCategories(rankedShows);

      sessionStorage.setItem(dataCacheKey, JSON.stringify({
        animeShows: rankedShows,
        featuredShows: featured,
        topContent: top,
      }));
      sessionStorage.setItem(dataCacheTsKey, Date.now().toString());
    } catch (fetchError) {
      console.error('Error fetching anime shows:', fetchError);
      setError(t('home.errorLoadingData'));
    } finally {
      setLoading(false);
    }
  }, [dataCacheKey, dataCacheTsKey, organizeContentByCategories, t, tmdbLanguage]);

  useEffect(() => {
    fetchAnimeShows();
  }, [fetchAnimeShows]);

  useEffect(() => {
    const loadGenreImages = async () => {
      try {
        const cachedImages = sessionStorage.getItem(genreImageCacheKey);
        const cachedTimestamp = sessionStorage.getItem(genreImageCacheTsKey);

        if (cachedImages && cachedTimestamp && (Date.now() - Number(cachedTimestamp)) < ONE_DAY_MS) {
          setGenreImages(JSON.parse(cachedImages));
          return;
        }

        const animeKeywordId = await resolveAnimeKeywordId();
        const imageEntries = await Promise.all(
          ANIME_GENRE_CONFIG.map(async (genre) => {
            try {
              const response = await axios.get('https://api.themoviedb.org/3/discover/tv', {
                params: buildAnimeDiscoverParams(tmdbLanguage, animeKeywordId, {
                  with_genres: genre.discoverGenres,
                  page: 1,
                }),
              });

              const firstVisual = Array.isArray(response.data?.results)
                ? response.data.results.find((show: AnimeShow) => show.backdrop_path || show.poster_path)
                : null;
              const imagePath = firstVisual?.backdrop_path || firstVisual?.poster_path || '';
              return [genre.id, imagePath ? `https://image.tmdb.org/t/p/w780${imagePath}` : undefined] as const;
            } catch {
              return [genre.id, undefined] as const;
            }
          }),
        );

        const nextImages = Object.fromEntries(imageEntries);
        setGenreImages(nextImages);
        sessionStorage.setItem(genreImageCacheKey, JSON.stringify(nextImages));
        sessionStorage.setItem(genreImageCacheTsKey, Date.now().toString());
      } catch {
        // Ignore genre image loading failures.
      }
    };

    loadGenreImages();
  }, [genreImageCacheKey, genreImageCacheTsKey, tmdbLanguage]);

  useEffect(() => {
    document.title = `${t('animePage.title')} - Movix`;
  }, [i18n.language, t]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="bg-red-600/10 text-red-600 px-6 py-4 rounded-lg">
          {error}
        </div>
      </div>
    );
  }

  if (loading && animeShows.length === 0) {
    return (
      <div className="container mx-auto px-4 py-8">
        <GridSkeleton />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <style>{pageStyles}</style>

      <div className="relative w-full">
        {featuredShows.length > 0 && (
          <HeroSlider
            items={featuredShows.map((show) => ({ ...show, media_type: 'tv' }))}
          />
        )}
      </div>

      <div className="w-full bg-black py-6 relative -mt-24 z-[20]">
        <EmblaCarouselGenres
          title={<span><span className="text-white mr-2">🧭</span><span>{t('genres.findByGenre')}</span></span>}
          items={genreItems}
        />
      </div>

      <div className="pb-12 -mt-4 relative z-[20]">
        {topContent.length > 0 && (
          <LazySection index={0} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              title={<span><span className="text-red-600 mr-2">🔥</span><span>{t('animePage.trending')}</span></span>}
              items={topContent.map((item) => ({
                ...item,
                media_type: 'tv',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || '',
              }))}
              mediaType="anime-trending"
              showRanking={true}
            />
          </LazySection>
        )}

        {popularAnimeShows.length > 0 && (
          <LazySection index={1} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              title={<span><span className="text-pink-500 mr-2">✦</span><span>{t('animePage.popularNow')}</span></span>}
              items={popularAnimeShows.map((item) => ({
                ...item,
                media_type: 'tv',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || '',
              }))}
              mediaType="anime-popular-tmdb"
            />
          </LazySection>
        )}

        {topRatedAnimeShows.length > 0 && (
          <LazySection index={2} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              title={<span><span className="text-amber-400 mr-2">★</span><span>{t('animePage.topRated')}</span></span>}
              items={topRatedAnimeShows.map((item) => ({
                ...item,
                media_type: 'tv',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || '',
              }))}
              mediaType="anime-top-rated-tmdb"
            />
          </LazySection>
        )}

        {keywordHighlightShows.length > 0 && (
          <LazySection index={3} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              title={<span><span className="text-cyan-400 mr-2">✦</span><span>{t('animePage.keywordHighlights')}</span></span>}
              items={keywordHighlightShows.map((item) => ({
                ...item,
                media_type: 'tv',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || '',
              }))}
              mediaType="anime-keyword-highlights"
              showRanking={true}
            />
          </LazySection>
        )}

        {keywordRecentShows.length > 0 && (
          <LazySection index={4} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              title={<span><span className="text-sky-400 mr-2">⏱</span><span>{t('animePage.keywordRecent')}</span></span>}
              items={keywordRecentShows.map((item) => ({
                ...item,
                media_type: 'tv',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || '',
              }))}
              mediaType="anime-keyword-recent"
            />
          </LazySection>
        )}

        {categories.map((category, index) => (
          <LazySection key={category.id} index={5 + index} immediateLoadCount={IMMEDIATE_LOAD_COUNT}>
            <EmblaCarousel
              title={category.title}
              items={category.items.map((item) => ({
                ...item,
                media_type: 'tv',
                poster_path: item.poster_path || '',
                backdrop_path: item.backdrop_path || '',
                overview: item.overview || '',
              }))}
              mediaType={category.id}
            />
          </LazySection>
        ))}

        <TelegramPromotion />
      </div>
    </div>
  );
};

export default Anime;
