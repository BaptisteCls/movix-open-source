import { useState, useMemo, useCallback, useEffect, useDeferredValue } from 'react';
import { FilterOptions, type FilterItemType } from '../components/FilterSystem';

interface WatchItem {
  id: number | string;
  type: Exclude<FilterItemType, 'all'>;
  title: string;
  name?: string;
  poster_path: string;
  addedAt: string;
  searchText?: string;
  episodeInfo?: {
    season: number;
    episode: number;
  };
  backdrop_path?: string | null;
  overview?: string;
}

interface UseOptimizedFilterProps {
  items: WatchItem[];
  initialFilters?: Partial<FilterOptions>;
}

interface IndexedItem {
  item: WatchItem;
  normalizedTitle: string;
  normalizedSearchText: string;
  addedAtMs: number;
  addedAtDayMs: number;
}

const DEFAULT_FILTERS: FilterOptions = {
  searchTerm: '',
  typeFilter: 'all',
  sortBy: 'date',
  sortOrder: 'desc'
};

const normalizeDateToDay = (date?: Date): number | null => {
  if (!date) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

const isSameDateRange = (
  current?: FilterOptions['dateRange'],
  next?: FilterOptions['dateRange']
): boolean => {
  const currentStart = current?.start?.getTime() ?? null;
  const currentEnd = current?.end?.getTime() ?? null;
  const nextStart = next?.start?.getTime() ?? null;
  const nextEnd = next?.end?.getTime() ?? null;
  return currentStart === nextStart && currentEnd === nextEnd;
};

export const useOptimizedFilter = ({ items, initialFilters }: UseOptimizedFilterProps) => {
  const [filters, setFilters] = useState<FilterOptions>({
    ...DEFAULT_FILTERS,
    ...initialFilters
  });
  const [isSorting, setIsSorting] = useState(false);
  const deferredSearchTerm = useDeferredValue(filters.searchTerm);

  useEffect(() => {
    if (filters.sortBy === 'name') {
      setIsSorting(true);
      const timer = setTimeout(() => setIsSorting(false), 100);
      return () => clearTimeout(timer);
    }

    setIsSorting(false);
  }, [filters.sortBy]);

  const indexedItems = useMemo<IndexedItem[]>(() => {
    return items.map((item) => {
      let addedAtMs = Date.parse(item.addedAt);
      if (Number.isNaN(addedAtMs)) {
        addedAtMs = 0;
      }

      const addedDate = new Date(addedAtMs);
      const addedAtDayMs = new Date(
        addedDate.getFullYear(),
        addedDate.getMonth(),
        addedDate.getDate()
      ).getTime();

      return {
        item,
        normalizedTitle: (item.title || item.name || '').toLowerCase(),
        normalizedSearchText: (item.searchText || item.title || item.name || '').toLowerCase(),
        addedAtMs,
        addedAtDayMs
      };
    });
  }, [items]);

  const normalizedSearchTerm = deferredSearchTerm.toLowerCase().trim();
  const startDayMs = normalizeDateToDay(filters.dateRange?.start);
  const endDayMs = normalizeDateToDay(filters.dateRange?.end);

  const filteredItems = useMemo(() => {
    let result = indexedItems.filter((indexedItem) => {
      const { item, normalizedSearchText, addedAtDayMs } = indexedItem;

      if (filters.typeFilter !== 'all' && item.type !== filters.typeFilter) {
        return false;
      }

      if (normalizedSearchTerm && !normalizedSearchText.includes(normalizedSearchTerm)) {
        return false;
      }

      if (startDayMs !== null && addedAtDayMs < startDayMs) {
        return false;
      }

      if (endDayMs !== null && addedAtDayMs > endDayMs) {
        return false;
      }

      return true;
    });

    if (filters.sortBy === 'name') {
      result.sort((a, b) => {
        const aKey = a.normalizedTitle;
        const bKey = b.normalizedTitle;

        if (aKey === bKey) return 0;
        if (aKey < bKey) return filters.sortOrder === 'desc' ? 1 : -1;
        return filters.sortOrder === 'desc' ? -1 : 1;
      });
    } else {
      result.sort((a, b) => {
        const comparison = a.addedAtMs - b.addedAtMs;
        return filters.sortOrder === 'desc' ? -comparison : comparison;
      });
    }

    return result.map((indexedItem) => indexedItem.item);
  }, [
    indexedItems,
    filters.typeFilter,
    filters.sortBy,
    filters.sortOrder,
    normalizedSearchTerm,
    startDayMs,
    endDayMs
  ]);

  const typeCounts = useMemo(() => {
    return items.reduce(
      (acc, item) => {
        acc[item.type] += 1;
        return acc;
      },
      {
        all: items.length,
        movie: 0,
        tv: 0,
        collection: 0,
        'shared-list': 0,
        'live-tv': 0
      }
    );
  }, [items]);

  const stats = useMemo(
    () => ({
      total: items.length,
      filtered: filteredItems.length,
      typeCounts
    }),
    [items.length, filteredItems.length, typeCounts]
  );

  const areFiltersEqual = useCallback((current: FilterOptions, next: FilterOptions) => {
    return (
      current.searchTerm === next.searchTerm &&
      current.typeFilter === next.typeFilter &&
      current.sortBy === next.sortBy &&
      current.sortOrder === next.sortOrder &&
      isSameDateRange(current.dateRange, next.dateRange)
    );
  }, []);

  const updateFilters = useCallback((newFilters: Partial<FilterOptions>) => {
    setFilters((prev) => {
      const nextFilters = {
        ...prev,
        ...newFilters
      };

      if (areFiltersEqual(prev, nextFilters)) {
        return prev;
      }

      return nextFilters;
    });
  }, [areFiltersEqual]);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  const getSearchSuggestions = useCallback((term: string, limit: number = 5) => {
    const normalizedTerm = term.trim().toLowerCase();
    if (!normalizedTerm) return [];

    return indexedItems
      .filter(({ normalizedTitle }) => {
        return normalizedTitle.includes(normalizedTerm) && normalizedTitle !== normalizedTerm;
      })
      .slice(0, limit)
      .map(({ item }) => ({
        id: item.id,
        title: item.title || item.name || '',
        type: item.type
      }));
  }, [indexedItems]);

  return {
    filteredItems,
    filters,
    stats,
    isSorting,
    updateFilters,
    resetFilters,
    getSearchSuggestions
  };
};

export default useOptimizedFilter;
