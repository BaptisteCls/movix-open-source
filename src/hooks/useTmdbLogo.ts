import { useEffect, useState } from 'react';
import axios from 'axios';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const CACHE_KEY = 'movix_tmdb_logos_cache';
const CACHE_TIMESTAMP_KEY = 'movix_tmdb_logos_cache_timestamp';
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Helper functions for sessionStorage cache
function getLogoCache(): Record<string, string | null> {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    const timestamp = sessionStorage.getItem(CACHE_TIMESTAMP_KEY);

    if (cached && timestamp) {
      const isValid = (Date.now() - parseInt(timestamp)) < CACHE_DURATION_MS;
      if (isValid) {
        return JSON.parse(cached);
      }
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

function setLogoCache(cache: Record<string, string | null>) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    sessionStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * Fetches the best logo for a movie or TV show from TMDB.
 * Uses sessionStorage caching to avoid repeated API calls.
 * @param mediaType 'movie' | 'tv'
 * @param id TMDB ID
 * @param refreshKey Optional refresh key
 * @returns logoUrl (string | null)
 */
export function useTmdbLogo(mediaType: 'movie' | 'tv' | undefined, id: number | undefined, refreshKey?: number) {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mediaType || !id) {
      setLogoUrl(null);
      return;
    }

    const cacheKey = `${mediaType}_${id}`;
    const cache = getLogoCache();

    // Check if we have a cached result
    if (cacheKey in cache) {
      setLogoUrl(cache[cacheKey]);
      return;
    }

    let cancelled = false;
    async function fetchLogo() {
      try {
        const url = `https://api.themoviedb.org/3/${mediaType}/${id}/images?api_key=${TMDB_API_KEY}`;
        const res = await axios.get(url);
        const logos = res.data.logos || [];
        // Prefer French, then English, then any
        const logo = logos.find((l: any) => l.iso_639_1 === 'fr')
          || logos.find((l: any) => l.iso_639_1 === 'en')
          || logos[0];

        let logoUrlResult: string | null = null;
        if (logo && logo.file_path) {
          logoUrlResult = `https://image.tmdb.org/t/p/original${logo.file_path}`;
        }

        // Save to cache
        const updatedCache = getLogoCache();
        updatedCache[cacheKey] = logoUrlResult;
        setLogoCache(updatedCache);

        if (!cancelled) setLogoUrl(logoUrlResult);
      } catch (e) {
        // Cache null result to avoid repeated failed requests
        const updatedCache = getLogoCache();
        updatedCache[cacheKey] = null;
        setLogoCache(updatedCache);

        if (!cancelled) setLogoUrl(null);
      }
    }
    fetchLogo();
    return () => { cancelled = true; };
  }, [mediaType, id, refreshKey]);

  return logoUrl;
}
