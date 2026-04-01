import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Filter, X, Film, Tv, FolderOpen, SortAsc, SortDesc, Type } from 'lucide-react';
import InputMask from 'react-input-mask';
import { useTranslation } from 'react-i18next';
import CustomDropdown from './CustomDropdown';
import CustomDatePicker from './CustomDatePicker';

export interface FilterOptions {
  searchTerm: string;
  typeFilter: 'all' | 'movie' | 'tv' | 'collection';
  sortBy: 'date' | 'name';
  sortOrder: 'asc' | 'desc';
  dateRange?: {
    start?: Date;
    end?: Date;
  };
}

interface FilterSystemProps {
  onFiltersChange: (filters: FilterOptions) => void;
  totalItems: number;
  filteredItems: number;
  isSorting?: boolean;
  className?: string;
}

const FilterSystem: React.FC<FilterSystemProps> = ({
  onFiltersChange,
  totalItems,
  filteredItems,
  isSorting = false,
  className = ''
}) => {
  const { t, i18n } = useTranslation();
  const [filters, setFilters] = useState<FilterOptions>({
    searchTerm: '',
    typeFilter: 'all',
    sortBy: 'date',
    sortOrder: 'desc'
  });
  const [searchInput, setSearchInput] = useState('');

  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [isTextMode, setIsTextMode] = useState(false);
  const [textStartDate, setTextStartDate] = useState('');
  const [textEndDate, setTextEndDate] = useState('');

  // Fonction pour valider et parser une date au format JJ/MM/AAAA
  const parseDateFromMask = (maskedValue: string): Date | null => {
    if (!maskedValue || maskedValue.length !== 10) return null;
    
    const parts = maskedValue.split('/');
    if (parts.length !== 3) return null;
    
    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1; // Les mois commencent à 0
    const year = parseInt(parts[2]);
    
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
    if (day < 1 || day > 31 || month < 0 || month > 11 || year < 1900 || year > 2100) return null;
    
    const date = new Date(year, month, day);
    return isNaN(date.getTime()) ? null : date;
  };

  const areFiltersEqual = useCallback((current: FilterOptions, next: FilterOptions) => {
    const currentStart = current.dateRange?.start?.getTime() ?? null;
    const currentEnd = current.dateRange?.end?.getTime() ?? null;
    const nextStart = next.dateRange?.start?.getTime() ?? null;
    const nextEnd = next.dateRange?.end?.getTime() ?? null;

    return (
      current.searchTerm === next.searchTerm &&
      current.typeFilter === next.typeFilter &&
      current.sortBy === next.sortBy &&
      current.sortOrder === next.sortOrder &&
      currentStart === nextStart &&
      currentEnd === nextEnd
    );
  }, []);

  const applyFilterUpdate = useCallback(
    (updater: (prev: FilterOptions) => FilterOptions) => {
      setFilters((prev) => {
        const next = updater(prev);
        if (areFiltersEqual(prev, next)) {
          return prev;
        }

        onFiltersChange(next);
        return next;
      });
    },
    [areFiltersEqual, onFiltersChange]
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      applyFilterUpdate((prev) => ({
        ...prev,
        searchTerm: searchInput
      }));
    }, 180);

    return () => window.clearTimeout(timeout);
  }, [searchInput, applyFilterUpdate]);

  const handleFilterChange = useCallback((key: keyof FilterOptions, value: any) => {
    applyFilterUpdate((prev) => ({
      ...prev,
      [key]: value
    }));
  }, [applyFilterUpdate]);

  const handleDateRangeChange = useCallback((newDateRange: any) => {
    applyFilterUpdate((prev) => ({
      ...prev,
      dateRange: newDateRange
    }));
  }, [applyFilterUpdate]);

  // Synchroniser les états texte avec les dates quand on bascule de mode
  const syncTextStates = useCallback(() => {
    if (filters.dateRange?.start) {
      const startDate = filters.dateRange.start;
      setTextStartDate(`${startDate.getDate().toString().padStart(2, '0')}/${(startDate.getMonth() + 1).toString().padStart(2, '0')}/${startDate.getFullYear()}`);
    } else {
      setTextStartDate('');
    }
    
    if (filters.dateRange?.end) {
      const endDate = filters.dateRange.end;
      setTextEndDate(`${endDate.getDate().toString().padStart(2, '0')}/${(endDate.getMonth() + 1).toString().padStart(2, '0')}/${endDate.getFullYear()}`);
    } else {
      setTextEndDate('');
    }
  }, [filters.dateRange]);

  const clearFilters = useCallback(() => {
    const defaultFilters: FilterOptions = {
      searchTerm: '',
      typeFilter: 'all',
      sortBy: 'date',
      sortOrder: 'desc'
    };
    setSearchInput('');
    setTextStartDate('');
    setTextEndDate('');
    setFilters(defaultFilters);
    onFiltersChange(defaultFilters);
  }, [onFiltersChange]);

  const hasActiveFilters = useMemo(() => {
    return searchInput !== '' || 
           filters.typeFilter !== 'all' || 
           filters.sortBy !== 'date' || 
           filters.sortOrder !== 'desc' ||
           filters.dateRange?.start ||
           filters.dateRange?.end;
  }, [filters, searchInput]);

  return (
    <div className={`bg-gray-800/50 backdrop-blur-sm rounded-lg p-4 mb-6 relative z-10 ${className}`}>
      {/* Main Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
        {/* Search Input */}
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder={t('filter.searchByName')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-gray-700/50 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Type Filter */}
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => handleFilterChange('typeFilter', 'all')}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              filters.typeFilter === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {t('filter.all')}
          </button>
          <button
            onClick={() => handleFilterChange('typeFilter', 'movie')}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 ${
              filters.typeFilter === 'movie'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            <Film className="w-4 h-4" />
            {t('filter.movies')}
          </button>
          <button
            onClick={() => handleFilterChange('typeFilter', 'tv')}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 ${
              filters.typeFilter === 'tv'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            <Tv className="w-4 h-4" />
            {t('filter.series')}
          </button>
          <button
            onClick={() => handleFilterChange('typeFilter', 'collection')}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 ${
              filters.typeFilter === 'collection'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            <FolderOpen className="w-4 h-4" />
            {t('filter.collections')}
          </button>
        </div>

        {/* Sort Controls */}
        <div className="flex gap-2 flex-wrap sm:flex-nowrap">
           <CustomDropdown
             options={[
               { value: 'date', label: t('filter.addedDate') },
               { value: 'name', label: t('filter.name') }
             ]}
             value={filters.sortBy}
             onChange={(value) => handleFilterChange('sortBy', value as 'date' | 'name')}
             disabled={isSorting}
             className="min-w-[140px]"
             position="bottom"
           />
           
           <button
             onClick={() => handleFilterChange('sortOrder', filters.sortOrder === 'asc' ? 'desc' : 'asc')}
             disabled={isSorting}
             className={`px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white hover:bg-gray-600 transition-colors ${
               isSorting ? 'opacity-50 cursor-not-allowed' : ''
             }`}
             title={`${filters.sortOrder === 'asc' ? t('filter.sortOrderDesc') : t('filter.sortOrderAsc')}`}
           >
             {isSorting ? (
               <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
             ) : filters.sortOrder === 'asc' ? (
               <SortAsc className="w-4 h-4" />
             ) : (
               <SortDesc className="w-4 h-4" />
             )}
           </button>
        </div>

        {/* Advanced Filters Toggle */}
        <button
          onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
            showAdvancedFilters || hasActiveFilters
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          <Filter className="w-4 h-4" />
          {t('filter.advancedFilters')}
        </button>

        {/* Clear Filters */}
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="px-3 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors flex items-center gap-1"
          >
            <X className="w-4 h-4" />
            {t('filter.clear')}
          </button>
        )}
      </div>

      {/* Advanced Filters Panel */}
      <AnimatePresence mode="wait">
        {showAdvancedFilters && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="mt-4 pt-4 border-t border-gray-600"
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Date Range Filter */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-300">
                    {t('filter.addedPeriod')}
                  </label>
                  {(filters.dateRange?.start || filters.dateRange?.end) && (
                    <button
                      onClick={() => handleDateRangeChange({ start: undefined, end: undefined })}
                      className="text-xs text-gray-400 hover:text-white transition-colors"
                    >
                      {t('filter.clearDates')}
                    </button>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  {!isTextMode ? (
                    <>
                      <CustomDatePicker
                        value={filters.dateRange?.start}
                        onChange={(date) => {
                          // Si on sélectionne une date de début, réinitialiser la date de fin si elle est antérieure
                          let newEndDate = filters.dateRange?.end;
                          if (date && filters.dateRange?.end) {
                            const startDateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                            const endDateOnly = new Date(filters.dateRange.end.getFullYear(), filters.dateRange.end.getMonth(), filters.dateRange.end.getDate());
                            if (endDateOnly < startDateOnly) {
                              newEndDate = undefined;
                            }
                          }
                          
                          handleDateRangeChange({
                            start: date,
                            end: newEndDate
                          });
                        }}
                        placeholder={t('filter.startDate')}
                        className="flex-1"
                        position="bottom"
                        maxDate={filters.dateRange?.end}
                      />
                      <CustomDatePicker
                        value={filters.dateRange?.end}
                        onChange={(date) => {
                          handleDateRangeChange({
                            ...filters.dateRange,
                            end: date
                          });
                        }}
                        placeholder={t('filter.endDate')}
                        className="flex-1"
                        position="bottom"
                        minDate={filters.dateRange?.start}
                      />
                    </>
                  ) : (
                    <div className="flex gap-2 flex-1">
                      <InputMask
                        mask="99/99/9999"
                        value={textStartDate}
                        onChange={(e) => {
                          const value = e.target.value;
                          setTextStartDate(value);
                          
                          // Parser la date seulement si le format est complet (JJ/MM/AAAA)
                          if (value === '' || value.includes('_')) {
                            handleDateRangeChange({
                              ...filters.dateRange,
                              start: undefined
                            });
                            return;
                          }
                          
                          const date = parseDateFromMask(value);
                          if (date) {
                            handleDateRangeChange({
                              ...filters.dateRange,
                              start: date
                            });
                          }
                        }}
                        placeholder="JJ/MM/AAAA"
                        className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <InputMask
                        mask="99/99/9999"
                        value={textEndDate}
                        onChange={(e) => {
                          const value = e.target.value;
                          setTextEndDate(value);
                          
                          // Parser la date seulement si le format est complet (JJ/MM/AAAA)
                          if (value === '' || value.includes('_')) {
                            handleDateRangeChange({
                              ...filters.dateRange,
                              end: undefined
                            });
                            return;
                          }
                          
                          const date = parseDateFromMask(value);
                          if (date) {
                            handleDateRangeChange({
                              ...filters.dateRange,
                              end: date
                            });
                          }
                        }}
                        placeholder="JJ/MM/AAAA"
                        className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}
                  
                  {/* Bouton de basculement mode texte */}
                  <button
                    onClick={() => {
                      if (!isTextMode) {
                        syncTextStates();
                      }
                      setIsTextMode(!isTextMode);
                    }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 whitespace-nowrap ${
                      isTextMode
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                    title={isTextMode ? t('filter.calendarMode') : t('filter.directInputMode')}
                  >
                    <Type className="w-4 h-4" />
                    {isTextMode ? "📅" : "✏️"}
                  </button>
                </div>
                
                {/* Indicateur de format en mode texte */}
                {isTextMode && (
                  <div className="mt-2 text-xs text-gray-400 bg-gray-800/50 px-3 py-2 rounded-lg">
                    💡 {t('filter.dateFormatHint')}
                  </div>
                )}
              </div>

              {/* Results Count */}
              <div className="flex flex-col items-end gap-2">
                <div className="text-sm text-gray-400">
                  {t('filter.itemsCount', { filtered: filteredItems, total: totalItems })}
                  {filteredItems !== totalItems && (
                    <span className="ml-2 text-blue-400">
                      ({Math.round((filteredItems / totalItems) * 100)}%)
                    </span>
                  )}
                </div>
                {(filters.dateRange?.start || filters.dateRange?.end) && (
                  <div className="text-xs text-blue-400 bg-blue-600/20 px-2 py-1 rounded">
                    {filters.dateRange?.start && filters.dateRange?.end ? (
                      t('filter.dateRangeFromTo', { start: filters.dateRange.start.toLocaleDateString(i18n.language), end: filters.dateRange.end.toLocaleDateString(i18n.language) })
                    ) : filters.dateRange?.start ? (
                      t('filter.dateRangeFrom', { start: filters.dateRange.start.toLocaleDateString(i18n.language) })
                    ) : (
                      t('filter.dateRangeTo', { end: filters.dateRange?.end?.toLocaleDateString(i18n.language) })
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default React.memo(FilterSystem);

