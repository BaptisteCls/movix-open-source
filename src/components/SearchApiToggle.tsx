import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSearch } from '../context/SearchContext';

const SearchApiToggle: React.FC = () => {
  const { t } = useTranslation();
  const { 
    useNewApi, 
    setUseNewApi, 
    fetchLinks, 
    setFetchLinks 
  } = useSearch();

  return (
    <div className="mb-4 mt-2">
      <div className="flex flex-col space-y-3">
        <div className="flex items-center">
          <label className="inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={useNewApi}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUseNewApi(e.target.checked)}
              className="sr-only peer"
            />
            <div className="relative w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
            <span className="ms-3 text-sm font-medium text-white">{t('search.newSearchApi')}</span>
          </label>
          <div className="ml-2 text-xs text-gray-400 cursor-help" title={t('search.useNewSearchApi')}>
            ?
          </div>
        </div>
        
        {useNewApi && (
          <div className="flex items-center">
            <label className="inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={fetchLinks}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFetchLinks(e.target.checked)}
                className="sr-only peer"
              />
              <div className="relative w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
              <span className="ms-3 text-sm font-medium text-white">{t('search.fetchLinks')}</span>
            </label>
            <div className="ml-2 text-xs text-gray-400 cursor-help" title={t('search.fetchLinksDescription')}>
              ?
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchApiToggle; 