import { useState, useEffect } from 'react';

interface WatchStatus {
  id: number;
  type: 'movie' | 'tv';
  episodeInfo?: {
    season: number;
    episode: number;
  };
  title: string;
  poster_path: string;
  addedAt: string;
}

interface UseWatchStatusProps {
  id: number;
  type: 'movie' | 'tv';
  title: string;
  poster_path: string;
  episodeInfo?: {
    season: number;
    episode: number;
  };
}

const useWatchStatus = ({ id, type, title, poster_path, episodeInfo }: UseWatchStatusProps) => {
  const [isInWatchlist, setIsInWatchlist] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);
  const [isWatched, setIsWatched] = useState(false);

  const getKey = (status: string) => {
    const baseKey = `${status}_${type}`;
    return episodeInfo ? `${baseKey}_episodes` : baseKey;
  };

  const updateStatus = (status: string, value: boolean) => {
    const key = getKey(status);
    const items = JSON.parse(localStorage.getItem(key) || '[]');
    
    if (value) {
      const newItem: WatchStatus = {
        id,
        type,
        title,
        poster_path,
        episodeInfo,
        addedAt: new Date().toISOString()
      };
      
      const updatedItems = [...items.filter((item: WatchStatus) => 
        episodeInfo 
          ? item.id !== id || 
            item.episodeInfo?.season !== episodeInfo.season || 
            item.episodeInfo?.episode !== episodeInfo.episode
          : item.id !== id
      ), newItem];
      
      localStorage.setItem(key, JSON.stringify(updatedItems));
    } else {
      const filteredItems = items.filter((item: WatchStatus) =>
        episodeInfo
          ? item.id !== id ||
            item.episodeInfo?.season !== episodeInfo.season ||
            item.episodeInfo?.episode !== episodeInfo.episode
          : item.id !== id
      );
      localStorage.setItem(key, JSON.stringify(filteredItems));
    }
  };

  useEffect(() => {
    const checkStatus = (status: string) => {
      const key = getKey(status);
      const items = JSON.parse(localStorage.getItem(key) || '[]');
      return items.some((item: WatchStatus) =>
        episodeInfo
          ? item.id === id &&
            item.episodeInfo?.season === episodeInfo.season &&
            item.episodeInfo?.episode === episodeInfo.episode
          : item.id === id
      );
    };

    setIsInWatchlist(checkStatus('watchlist'));
    setIsFavorite(checkStatus('favorite'));
    setIsWatched(checkStatus('watched'));
  }, [id, type, episodeInfo]);

  return {
    isInWatchlist,
    isFavorite,
    isWatched,
    toggleWatchlist: () => {
      setIsInWatchlist(!isInWatchlist);
      updateStatus('watchlist', !isInWatchlist);
    },
    toggleFavorite: () => {
      setIsFavorite(!isFavorite);
      updateStatus('favorite', !isFavorite);
    },
    toggleWatched: () => {
      setIsWatched(!isWatched);
      updateStatus('watched', !isWatched);
    }
  };
};

export default useWatchStatus; 