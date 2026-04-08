import axios from 'axios';
import { getTmdbLanguage } from '../i18n';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const KEYWORD_ID_CACHE_PREFIX = 'movix_tmdb_keyword_id_';
const MEDIA_KEYWORDS_CACHE_PREFIX = 'movix_tmdb_media_keyword_ids_';

export interface TmdbKeyword {
  id: number;
  name: string;
}

const normalizeKeywordLabel = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const readSessionCache = <T>(key: string): T | null => {
  try {
    const rawValue = sessionStorage.getItem(key);
    return rawValue ? (JSON.parse(rawValue) as T) : null;
  } catch {
    return null;
  }
};

const writeSessionCache = (key: string, value: unknown) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore cache write failures.
  }
};

export const searchTmdbKeywords = async (
  query: string,
  _language: string = getTmdbLanguage(),
  limit = 8,
): Promise<TmdbKeyword[]> => {
  const trimmedQuery = query.trim();
  if (!TMDB_API_KEY || trimmedQuery.length < 2) {
    return [];
  }

  const normalizedQuery = normalizeKeywordLabel(trimmedQuery);
  const response = await axios.get('https://api.themoviedb.org/3/search/keyword', {
    params: {
      api_key: TMDB_API_KEY,
      query: trimmedQuery,
      page: 1,
    },
  });

  const results = Array.isArray(response.data?.results) ? response.data.results : [];

  return results
    .filter((keyword: TmdbKeyword) => Boolean(keyword?.id && keyword?.name))
    .sort((left: TmdbKeyword, right: TmdbKeyword) => {
      const leftLabel = normalizeKeywordLabel(left.name);
      const rightLabel = normalizeKeywordLabel(right.name);
      const leftExact = leftLabel === normalizedQuery;
      const rightExact = rightLabel === normalizedQuery;

      if (leftExact !== rightExact) {
        return leftExact ? -1 : 1;
      }

      const leftStartsWith = leftLabel.startsWith(normalizedQuery);
      const rightStartsWith = rightLabel.startsWith(normalizedQuery);
      if (leftStartsWith !== rightStartsWith) {
        return leftStartsWith ? -1 : 1;
      }

      return left.name.localeCompare(right.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
    })
    .slice(0, limit)
    .map((keyword: TmdbKeyword) => ({
      id: keyword.id,
      name: keyword.name,
    }));
};

export const resolveTmdbKeywordId = async (
  keyword: string,
  language: string = getTmdbLanguage(),
): Promise<number | null> => {
  const normalizedKeyword = normalizeKeywordLabel(keyword);
  if (!TMDB_API_KEY || !normalizedKeyword) {
    return null;
  }

  const cacheKey = `${KEYWORD_ID_CACHE_PREFIX}${normalizedKeyword}`;
  const cachedKeywordId = readSessionCache<number>(cacheKey);
  if (typeof cachedKeywordId === 'number' && !Number.isNaN(cachedKeywordId)) {
    return cachedKeywordId;
  }

  try {
    const keywords = await searchTmdbKeywords(keyword, language, 10);
    const exactMatch =
      keywords.find((item) => normalizeKeywordLabel(item.name) === normalizedKeyword) ||
      keywords.find((item) => normalizeKeywordLabel(item.name).includes(normalizedKeyword));

    if (exactMatch?.id) {
      writeSessionCache(cacheKey, exactMatch.id);
      return exactMatch.id;
    }
  } catch (error) {
    console.warn(`Unable to resolve TMDB keyword id for "${keyword}":`, error);
  }

  return null;
};

export const fetchTmdbMediaKeywordIds = async (
  mediaType: 'movie' | 'tv',
  id: number | string,
): Promise<number[]> => {
  if (!TMDB_API_KEY) {
    return [];
  }

  const cacheKey = `${MEDIA_KEYWORDS_CACHE_PREFIX}${mediaType}_${id}`;
  const cachedKeywordIds = readSessionCache<number[]>(cacheKey);
  if (Array.isArray(cachedKeywordIds)) {
    return cachedKeywordIds;
  }

  const response = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${id}/keywords`, {
    params: {
      api_key: TMDB_API_KEY,
    },
  });

  const rawKeywords = mediaType === 'movie' ? response.data?.keywords : response.data?.results;
  const keywordIds = Array.isArray(rawKeywords)
    ? rawKeywords
        .map((keyword: TmdbKeyword) => keyword?.id)
        .filter((keywordId: unknown): keywordId is number => typeof keywordId === 'number')
    : [];

  writeSessionCache(cacheKey, keywordIds);
  return keywordIds;
};
