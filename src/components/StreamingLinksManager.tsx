import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import ReusableModal from './ui/reusable-modal';
import { getTmdbLanguage } from '../i18n';

interface MovieResult {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string;
}

interface Season {
  season_number: number;
}

interface Episode {
  episode_number: number;
  name: string;
}

const StreamingLinksManager: React.FC = () => {
  const { t } = useTranslation();
  const [currentMedia, setCurrentMedia] = useState<'movie' | 'tv'>('movie');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MovieResult[]>([]);
  const [selectedItem, setSelectedItem] = useState<MovieResult | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedSeason, setSelectedSeason] = useState('');
  const [selectedEpisode, setSelectedEpisode] = useState('');
  const [links, setLinks] = useState<string[]>(['']);
  const [currentLinks, setCurrentLinks] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isMassAddModalOpen, setIsMassAddModalOpen] = useState(false);
  const [massLinksText, setMassLinksText] = useState('');
  const [startEpisode, setStartEpisode] = useState(1);

  // États pour la pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [totalResults, setTotalResults] = useState(0);

  const API_URL = import.meta.env.VITE_MAIN_API;
  const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

  const getAuthToken = () => localStorage.getItem('auth_token');

  const normalizeUrl = (url: string): string => {
    if (!url.trim()) return url;
    // Add https:// if URL doesn't have protocol
    if (!url.match(/^https?:\/\//i)) {
      return 'https://' + url;
    }
    return url;
  };

  const searchContent = async (page: number = 1) => {
    if (!searchQuery.trim()) {
      toast.error(t('streamingLinks.enterTitle'));
      return;
    }

    setIsLoading(true);
    try {
      const response = await axios.get(
        `https://api.themoviedb.org/3/search/${currentMedia}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}&query=${encodeURIComponent(searchQuery)}&page=${page}`
      );
      setSearchResults(response.data.results);
      setCurrentPage(response.data.page);
      setTotalPages(response.data.total_pages);
      setTotalResults(response.data.total_results);
    } catch (error) {
      console.error('Erreur lors de la recherche:', error);
      toast.error(t('streamingLinks.searchError'));
    } finally {
      setIsLoading(false);
    }
  };

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      searchContent(page);
    }
  };

  const goToNextPage = () => {
    if (currentPage < totalPages) {
      goToPage(currentPage + 1);
    }
  };

  const goToPreviousPage = () => {
    if (currentPage > 1) {
      goToPage(currentPage - 1);
    }
  };

  const openModal = async (item: MovieResult) => {
    setSelectedItem(item);
    setIsModalOpen(true);
    setLinks(['']);
    setCurrentLinks([]);

    // Réinitialiser les sélections pour les séries TV
    if (currentMedia === 'tv') {
      setSelectedSeason('');
      setSelectedEpisode('');
      setEpisodes([]);
    }

    if (currentMedia === 'tv') {
      try {
        const response = await axios.get(
          `https://api.themoviedb.org/3/tv/${item.id}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
        );
        setSeasons(response.data.seasons);
      } catch (error) {
        console.error('Erreur lors du chargement des saisons:', error);
      }
    } else {
      await loadCurrentLinks();
    }
  };

  const loadEpisodes = async (seasonNumber: string) => {
    if (!selectedItem || !seasonNumber) return;

    try {
      const response = await axios.get(
        `https://api.themoviedb.org/3/tv/${selectedItem.id}/season/${seasonNumber}?api_key=${TMDB_API_KEY}&language=${getTmdbLanguage()}`
      );
      setEpisodes(response.data.episodes);
      setSelectedEpisode('');
    } catch (error) {
      console.error('Erreur lors du chargement des épisodes:', error);
    }
  };

  const loadCurrentLinks = async () => {
    if (!selectedItem) return;

    try {
      let url = `${API_URL}/api/links/${currentMedia}/${selectedItem.id}`;

      if (currentMedia === 'tv' && selectedSeason && selectedEpisode) {
        url += `?season=${selectedSeason}&episode=${selectedEpisode}`;
      }

      const response = await axios.get(url);

      if (response.data.success) {
        const links = currentMedia === 'movie'
          ? response.data.data.links
          : response.data.data[0]?.links || [];
        setCurrentLinks(Array.isArray(links) ? links : []);
      } else {
        setCurrentLinks([]);
      }
    } catch (error) {
      console.error('Erreur lors du chargement des liens:', error);
      setCurrentLinks([]);
    }
  };

  const addLinkInput = () => {
    setLinks([...links, '']);
  };

  const removeLinkInput = (index: number) => {
    setLinks(links.filter((_, i) => i !== index));
  };

  const updateLink = (index: number, value: string) => {
    const newLinks = [...links];
    newLinks[index] = value;
    setLinks(newLinks);
  };

  const saveLinks = async () => {
    const validLinks = links.filter(link => link.trim()).map(link => normalizeUrl(link));

    if (validLinks.length === 0) {
      toast.error(t('streamingLinks.addAtLeastOneLink'));
      return;
    }

    if (!selectedItem) return;

    if (currentMedia === 'tv' && (!selectedSeason || !selectedEpisode)) {
      toast.error(t('streamingLinks.selectSeasonAndEpisode'));
      return;
    }

    try {
      const body: any = {
        type: currentMedia,
        id: selectedItem.id.toString(),
        links: validLinks
      };

      if (currentMedia === 'tv') {
        body.season = parseInt(selectedSeason);
        body.episode = parseInt(selectedEpisode);
      }

      await axios.post(`${API_URL}/api/admin/links`, body, {
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
          'Content-Type': 'application/json'
        }
      });

      toast.success(t('streamingLinks.linksSaved'));
      await loadCurrentLinks();
      setLinks(['']);
    } catch (error: any) {
      console.error('Erreur lors de l\'enregistrement:', error);
      toast.error('Erreur: ' + (error.response?.data?.error || error.message));
    }
  };

  const deleteAllLinks = async () => {
    if (!confirm(t('streamingLinks.confirmDeleteAll'))) return;
    if (!selectedItem) return;

    try {
      const body: any = {
        type: currentMedia,
        id: selectedItem.id.toString()
      };

      if (currentMedia === 'tv' && selectedSeason && selectedEpisode) {
        body.season = parseInt(selectedSeason);
        body.episode = parseInt(selectedEpisode);
      }

      await axios.delete(`${API_URL}/api/admin/links`, {
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
          'Content-Type': 'application/json'
        },
        data: body
      });

      toast.success(t('streamingLinks.linksDeleted'));
      await loadCurrentLinks();
    } catch (error: any) {
      console.error('Erreur lors de la suppression:', error);
      toast.error('Erreur: ' + (error.response?.data?.error || error.message));
    }
  };

  const deleteSpecificLink = async (index: number) => {
    if (!confirm(t('streamingLinks.confirmDeleteOne'))) return;
    if (!selectedItem) return;

    try {
      const updatedLinks = currentLinks.filter((_, i) => i !== index);

      if (updatedLinks.length === 0) {
        // Supprimer complètement l'entrée
        const body: any = {
          type: currentMedia,
          id: selectedItem.id.toString()
        };

        if (currentMedia === 'tv' && selectedSeason && selectedEpisode) {
          body.season = parseInt(selectedSeason);
          body.episode = parseInt(selectedEpisode);
        }

        await axios.delete(`${API_URL}/api/admin/links`, {
          headers: {
            'Authorization': `Bearer ${getAuthToken()}`,
            'Content-Type': 'application/json'
          },
          data: body
        });
      } else {
        // Mettre à jour avec les liens restants
        const body: any = {
          type: currentMedia,
          id: selectedItem.id.toString(),
          links: updatedLinks
        };

        if (currentMedia === 'tv' && selectedSeason && selectedEpisode) {
          body.season = parseInt(selectedSeason);
          body.episode = parseInt(selectedEpisode);
        }

        await axios.put(`${API_URL}/api/admin/links`, body, {
          headers: {
            'Authorization': `Bearer ${getAuthToken()}`,
            'Content-Type': 'application/json'
          }
        });
      }

      toast.success(t('streamingLinks.linkDeleted'));
      await loadCurrentLinks();
    } catch (error: any) {
      console.error('Erreur lors de la suppression:', error);
      toast.error('Erreur: ' + (error.response?.data?.error || error.message));
    }
  };

  const showMassAddInterface = () => {
    if (!selectedSeason) {
      toast.error(t('streamingLinks.selectSeasonFirst'));
      return;
    }

    setMassLinksText('');
    setStartEpisode(1);
    setIsMassAddModalOpen(true);
  };

  const closeMassAddModal = () => {
    setIsMassAddModalOpen(false);
  };

  const processMassEpisodeLinks = async () => {
    if (!selectedItem || !selectedSeason) return;

    try {
      const linksText = massLinksText.trim();

      if (!linksText) {
        toast.error(t('streamingLinks.enterAtLeastOneLink'));
        return;
      }

      // Split links by line and filter empty lines
      const links = linksText.split('\n')
        .map(link => link.trim())
        .filter(link => link.length > 0)
        .map(link => normalizeUrl(link));

      if (links.length === 0) {
        toast.error(t('streamingLinks.noValidLinks'));
        return;
      }

      let successCount = 0;
      let failCount = 0;

      // Process each link
      for (let i = 0; i < links.length; i++) {
        const episodeNumber = startEpisode + i;
        const link = links[i];

        try {
          // Add episode with link
          await axios.post(`${API_URL}/api/admin/links`, {
            type: 'tv',
            id: selectedItem.id.toString(),
            season: parseInt(selectedSeason),
            episode: episodeNumber,
            links: [link]
          }, {
            headers: {
              'Authorization': `Bearer ${getAuthToken()}`,
              'Content-Type': 'application/json'
            }
          });

          successCount++;
        } catch (error) {
          console.error(`Erreur pour l'épisode ${episodeNumber}:`, error);
          failCount++;
        }
      }

      toast.success(t('streamingLinks.massAddResult', { success: successCount, fail: failCount }));
      setIsMassAddModalOpen(false);

      // Reload current links if we're viewing the same season/episode
      if (selectedEpisode) {
        await loadCurrentLinks();
      }

    } catch (error: any) {
      console.error('Erreur lors de l\'ajout en masse:', error);
      toast.error('Erreur: ' + (error.response?.data?.error || error.message));
    }
  };

  // Réinitialiser la pagination quand on change de type de média
  useEffect(() => {
    setCurrentPage(1);
    setTotalPages(0);
    setTotalResults(0);
    setSearchResults([]);
  }, [currentMedia]);

  useEffect(() => {
    if (currentMedia === 'tv' && selectedSeason) {
      loadEpisodes(selectedSeason);
    }
  }, [selectedSeason]);

  useEffect(() => {
    if (currentMedia === 'tv' && selectedSeason && selectedEpisode) {
      loadCurrentLinks();
    } else if (currentMedia === 'movie' && selectedItem) {
      loadCurrentLinks();
    }
  }, [selectedSeason, selectedEpisode, selectedItem, currentMedia]);

  return (
    <div className="space-y-6">
      {/* Media Type Switch */}
      <div className="flex justify-center space-x-4">
        <button
          onClick={() => setCurrentMedia('movie')}
          className={`px-6 py-3 rounded-lg font-semibold transition-colors ${currentMedia === 'movie'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
        >
          {t('streamingLinks.movies')}
        </button>
        <button
          onClick={() => setCurrentMedia('tv')}
          className={`px-6 py-3 rounded-lg font-semibold transition-colors ${currentMedia === 'tv'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
        >
          {t('streamingLinks.series')}
        </button>
      </div>

      {/* Search */}
      <div className="flex space-x-4">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('streamingLinks.searchPlaceholder')}
          className="flex-1 px-4 py-3 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
          onKeyPress={(e) => e.key === 'Enter' && searchContent(1)}
        />
        <button
          onClick={() => searchContent(1)}
          disabled={isLoading}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? t('streamingLinks.searching') : t('streamingLinks.searchBtn')}
        </button>
      </div>

      {/* Search Results */}
      {searchResults.length > 0 && (
        <>
          {/* Informations de pagination */}
          <div className="text-center text-gray-400 mb-4">
            <p>
              {t('streamingLinks.pageInfo', { current: currentPage, total: totalPages })}
            </p>
          </div>

          {/* Grille des résultats */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
            {searchResults.map((item) => (
              <div
                key={item.id}
                onClick={() => openModal(item)}
                className="bg-gray-800 rounded-lg overflow-hidden cursor-pointer hover:bg-gray-700 transition-colors"
              >
                <img
                  src={
                    item.poster_path
                      ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                      : 'https://via.placeholder.com/200x300?text=No+Image'
                  }
                  alt={item.title || item.name}
                  className="w-full h-64 object-cover"
                />
                <div className="p-3">
                  <h3 className="font-semibold text-sm text-white truncate">
                    {item.title || item.name}
                  </h3>
                  <p className="text-gray-400 text-xs">
                    {item.release_date || item.first_air_date
                      ? new Date(item.release_date || item.first_air_date!).getFullYear()
                      : 'N/A'}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Contrôles de pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center items-center space-x-4">
              <button
                onClick={goToPreviousPage}
                disabled={currentPage === 1 || isLoading}
                className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                <span>‹</span>
                <span>{t('streamingLinks.previous')}</span>
              </button>

              {/* Numéros de page */}
              <div className="flex space-x-2">
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNumber;
                  if (totalPages <= 5) {
                    pageNumber = i + 1;
                  } else if (currentPage <= 3) {
                    pageNumber = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNumber = totalPages - 4 + i;
                  } else {
                    pageNumber = currentPage - 2 + i;
                  }

                  return (
                    <button
                      key={pageNumber}
                      onClick={() => goToPage(pageNumber)}
                      disabled={isLoading}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${currentPage === pageNumber
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {pageNumber}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={goToNextPage}
                disabled={currentPage === totalPages || isLoading}
                className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                <span>{t('streamingLinks.next')}</span>
                <span>›</span>
              </button>
            </div>
          )}
        </>
      )}

      {/* Modal */}
      <ReusableModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={selectedItem ? (selectedItem.title || selectedItem.name) : ''}
      >
        {selectedItem && (
          <div className="space-y-6">
            {/* Season/Episode Selectors for TV */}
            {currentMedia === 'tv' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    {t('streamingLinks.selectSeasonLabel')}
                  </label>
                  <Select
                    value={selectedSeason}
                    onValueChange={(value) => setSelectedSeason(value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t('streamingLinks.selectSeasonPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {seasons.map((season) => (
                        <SelectItem key={season.season_number} value={season.season_number.toString()}>
                          {t('streamingLinks.seasonLabel', { number: season.season_number })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {selectedSeason && (
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      {t('streamingLinks.selectEpisodeLabel')}
                    </label>
                    <Select
                      value={selectedEpisode}
                      onValueChange={(value) => setSelectedEpisode(value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t('streamingLinks.selectEpisodePlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {episodes.map((episode) => (
                          <SelectItem key={episode.episode_number} value={episode.episode_number.toString()}>
                            {t('streamingLinks.episodeLabel', { number: episode.episode_number, name: episode.name })}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Mass Add Button for TV */}
                {selectedSeason && (
                  <div className="mt-4">
                    <button
                      onClick={showMassAddInterface}
                      className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold"
                    >
                      {t('streamingLinks.massAdd')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Current Links */}
            {currentLinks.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold text-white mb-3">{t('streamingLinks.currentLinks')}</h3>
                <div className="space-y-2">
                  {currentLinks.map((link, index) => (
                    <div key={index} className="flex items-center justify-between bg-gray-800 p-3 rounded-lg">
                      <span className="text-gray-300 text-sm flex-1 break-all">{link}</span>
                      <button
                        onClick={() => deleteSpecificLink(index)}
                        className="ml-3 px-3 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
                      >
                        {t('streamingLinks.deleteLink')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* New Links */}
            <div>
              <h3 className="text-lg font-semibold text-white mb-3">{t('streamingLinks.newLinks')}</h3>
              <div className="space-y-3">
                {links.map((link, index) => (
                  <div key={index} className="flex space-x-2">
                    <input
                      type="text"
                      value={link}
                      onChange={(e) => updateLink(index, e.target.value)}
                  placeholder={t('streamingLinks.linkPlaceholder')}
                      className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                    />
                    {links.length > 1 && (
                      <button
                        onClick={() => removeLinkInput(index)}
                        className="px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                      >
                        -
                      </button>
                    )}
                  </div>
                ))}
                <button
                  onClick={addLinkInput}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                >
                  {t('streamingLinks.addLink')}
                </button>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex space-x-4">
              <button
                onClick={saveLinks}
                className="flex-1 px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold"
              >
                {t('streamingLinks.saveLinks')}
              </button>
              <button
                onClick={deleteAllLinks}
                className="flex-1 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 font-semibold"
              >
                {t('streamingLinks.deleteAllLinks')}
              </button>
            </div>
          </div>
        )}
      </ReusableModal>

      {/* Mass Add Modal */}
      <ReusableModal
        isOpen={isMassAddModalOpen}
        onClose={closeMassAddModal}
        title={t('streamingLinks.massAddTitle')}
      >
        <div className="space-y-6">
          <p className="text-gray-300">
            {t('streamingLinks.massAddDescription')}
          </p>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              {t('streamingLinks.startAtEpisode')}
            </label>
            <input
              type="number"
              value={startEpisode}
              onChange={(e) => setStartEpisode(parseInt(e.target.value) || 1)}
              min="1"
              className="w-20 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              {t('streamingLinks.linksPerLine')}
            </label>
            <textarea
              value={massLinksText}
              onChange={(e) => setMassLinksText(e.target.value)}
              placeholder={t('streamingLinks.pasteLinksPlaceholder')}
              className="w-full h-48 px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 font-mono text-sm"
            />
          </div>

          <div className="flex space-x-4">
            <button
              onClick={processMassEpisodeLinks}
              className="flex-1 px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold"
            >
              {t('streamingLinks.addEpisodes')}
            </button>
            <button
              onClick={closeMassAddModal}
              className="flex-1 px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 font-semibold"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </ReusableModal>
    </div>
  );
};

export default StreamingLinksManager;
