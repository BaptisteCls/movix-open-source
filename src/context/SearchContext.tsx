import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';
import i18n from '../i18n';
import { getTmdbLanguage } from '../i18n';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';

export interface SearchResult { // Added export keyword
  id: number;
  title?: string;
  name?: string;
  media_type: 'movie' | 'tv';
  poster_path: string;
  backdrop_path?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  genre_ids: number[];
  overview?: string;
  original_language?: string;
  origin_country?: string[];
}

interface PersonSuggestion {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department: string;
  popularity: number;
}

interface Genre {
  id: number;
  name: string;
}

interface SearchContextType {
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  genres: Genre[];
  selectedGenres: number[];
  toggleGenre: (genreId: number) => void;
  selectedType: 'all' | 'movie' | 'tv';
  setSelectedType: (type: 'all' | 'movie' | 'tv') => void;
  minRating: number;
  setMinRating: (rating: number) => void;
  hasMore: boolean;
  page: number;
  setPage: (page: number) => void;
  performSearch: (pageNum: number, isNewSearch?: boolean) => Promise<void>;
  loadingGenres: boolean;
  showFilters: boolean;
  setShowFilters: React.Dispatch<React.SetStateAction<boolean>>;
  isLoadingMore: boolean;
  totalPages: number;
  director: string;
  setDirector: (director: string) => void;
  actor: string;
  setActor: (actor: string) => void;
  year: string;
  setYear: (year: string) => void;
  directorSuggestions: PersonSuggestion[];
  actorSuggestions: PersonSuggestion[];
  loadingSuggestions: boolean;
  fetchPeopleSuggestions: (query: string, type: 'director' | 'actor') => Promise<void>;
  selectPerson: (person: PersonSuggestion, type: 'director' | 'actor') => void;
  clearSuggestions: () => void;
  autocompleteSuggestions: SearchResult[];
  loadingAutocomplete: boolean;
  fetchAutocompleteSuggestions: (query: string) => Promise<void>;
  clearAutocompleteSuggestions: () => void;
  selectedLanguage: string;
  setSelectedLanguage: (language: string) => void;
  selectedCountry: string;
  setSelectedCountry: (country: string) => void;
}

const SearchContext = createContext<SearchContextType | null>(null);

export const useSearch = () => {
  const context = useContext(SearchContext);
  if (!context) {
    throw new Error('useSearch must be used within a SearchProvider');
  }
  return context;
};

// Ajout du mapping statique des genres TMDB -> français
const GENRES_FR: Record<number, string> = {
  28: 'Action',
  12: 'Aventure',
  16: 'Animation',
  35: 'Comédie',
  80: 'Crime',
  99: 'Documentaire',
  18: 'Drame',
  10751: 'Famille',
  14: 'Fantastique',
  36: 'Histoire',
  27: 'Horreur',
  10402: 'Musique',
  9648: 'Mystère',
  10749: 'Romance',
  878: 'Science-Fiction',
  10770: 'Téléfilm',
  53: 'Thriller',
  10752: 'Guerre',
  37: 'Western',
  10759: 'Action & Aventure',
  10762: 'Enfants',
  10763: 'Actualités',
  10764: 'Téléréalité',
  10765: 'Science-Fiction & Fantastique',
  10766: 'Feuilleton',
  10767: 'Talk-show',
  10768: 'Guerre & Politique'
};

export const SearchProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [selectedGenres, setSelectedGenres] = useState<number[]>([]);
  const [selectedType, setSelectedType] = useState<'all' | 'movie' | 'tv'>('all');
  const [minRating, setMinRating] = useState<number>(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadingGenres, setLoadingGenres] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [director, setDirector] = useState<string>('');
  const [actor, setActor] = useState<string>('');
  const [year, setYear] = useState<string>('');
  const [directorSuggestions, setDirectorSuggestions] = useState<PersonSuggestion[]>([]);
  const [actorSuggestions, setActorSuggestions] = useState<PersonSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<SearchResult[]>([]);
  const [loadingAutocomplete, setLoadingAutocomplete] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('');
  const [selectedCountry, setSelectedCountry] = useState<string>('');

  // Function to fetch people suggestions from TMDB
  const fetchPeopleSuggestions = async (searchQuery: string, type: 'director' | 'actor') => {
    if (!searchQuery || searchQuery.length < 2) {
      if (type === 'director') {
        setDirectorSuggestions([]);
      } else {
        setActorSuggestions([]);
      }
      return;
    }

    setLoadingSuggestions(true);

    try {
      const response = await axios.get(`https://api.themoviedb.org/3/search/person`, {
        params: {
          api_key: TMDB_API_KEY,
          query: searchQuery,
          language: getTmdbLanguage(),
          page: 1,
        }
      });

      const results = response.data.results
        .filter((person: any) => {
          // Vérifier que la personne a des œuvres connues
          if (!person.known_for || person.known_for.length === 0) {
            return false;
          }

          // Vérifier que les œuvres connues sont des films ou séries (pas des personnes)
          const validWorks = person.known_for.filter((work: any) =>
            work.media_type === 'movie' || work.media_type === 'tv'
          );

          if (validWorks.length === 0) {
            return false;
          }

          // Vérifier que la personne a au moins une œuvre avec une note décente ou récente
          const hasRelevantWork = validWorks.some((work: any) => {
            const releaseYear = work.release_date ? new Date(work.release_date).getFullYear() :
              work.first_air_date ? new Date(work.first_air_date).getFullYear() : 0;
            return work.vote_average >= 5.0 || releaseYear >= 2000;
          });

          if (!hasRelevantWork) {
            return false;
          }

          if (type === 'director') {
            return person.known_for_department === 'Directing' ||
              person.known_for_department === 'Production' ||
              person.known_for.some((work: any) => work.job === 'Director');
          } else {
            return person.known_for_department === 'Acting';
          }
        })
        .slice(0, 5); // Limit to 5 suggestions

      if (type === 'director') {
        setDirectorSuggestions(results);
      } else {
        setActorSuggestions(results);
      }
    } catch (error) {
      console.error(`Error fetching ${type} suggestions:`, error);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  // Function to select a person from suggestions
  const selectPerson = (person: PersonSuggestion, type: 'director' | 'actor') => {
    if (type === 'director') {
      setDirector(person.name);
      setDirectorSuggestions([]);
    } else {
      setActor(person.name);
      setActorSuggestions([]);
    }
  };

  // Function to clear all suggestions
  const clearSuggestions = () => {
    setDirectorSuggestions([]);
    setActorSuggestions([]);
  };

  // Function to fetch autocomplete suggestions
  const fetchAutocompleteSuggestions = async (searchQuery: string) => {
    if (!searchQuery || searchQuery.length < 2) {
      setAutocompleteSuggestions([]);
      return;
    }

    setLoadingAutocomplete(true);
    try {
      const response = await axios.get(`https://api.themoviedb.org/3/search/multi`, {
        params: {
          api_key: TMDB_API_KEY,
          query: searchQuery,
          language: getTmdbLanguage(),
          page: 1,
          sort_by: 'popularity.desc'
        }
      });

      const suggestions = response.data.results
        .filter((item: any) => (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path)
        // Tri par popularité décroissante pour afficher d'abord les plus populaires
        .sort((a: any, b: any) => b.popularity - a.popularity)
        .slice(0, 5); // Limit to 5 suggestions

      setAutocompleteSuggestions(suggestions);
    } catch (error) {
      console.error('Error fetching autocomplete suggestions:', error);
      setAutocompleteSuggestions([]);
    } finally {
      setLoadingAutocomplete(false);
    }
  };

  const clearAutocompleteSuggestions = () => {
    setAutocompleteSuggestions([]);
  };

  const checkAvailability = async (item: SearchResult) => {
    // Toujours retourner true sans vérification
    return true;
  };

  const performSearch = async (pageNum: number, isNewSearch: boolean = false) => {
    // Modifier la définition de isGenreSearch pour ne pas dépendre de query
    const hasFilters = selectedGenres.length > 0 || selectedType !== 'all' || minRating > 0 || director || actor || year || selectedLanguage || selectedCountry;
    const isGenreSearch = hasFilters;

    if ((!hasMore && !isNewSearch && !isGenreSearch) || isLoading) return;

    if (!query && selectedGenres.length === 0 && selectedType === 'all' && minRating === 0 && !director && !actor && !year && !selectedLanguage && !selectedCountry) return;

    const loadingMore = !isNewSearch && isGenreSearch;

    if (isNewSearch) {
      setLoading(true);
      setPage(1); // Réinitialise la page pour une nouvelle recherche
      // Réinitialise les IDs pour une nouvelle recherche
    } else if (loadingMore) {
      setIsLoadingMore(true);
    }

    setIsLoading(true);
    setError(null);

    try {
      let searchResults: SearchResult[] = [];
      let tmdbInitialResults: any[] = [];
      let currentTotalPages = 0;

      // Get TMDB results first for both movies and TV shows
      if (query) {
        try {
          console.log('Getting initial TMDB results for:', query);

          // Détermine s'il faut utiliser search ou discover (uniquement si pas de requête texte)
          const shouldUseDiscover = !query;

          // Paramètres de base communs
          const baseSearchParams: Record<string, any> = {
            api_key: TMDB_API_KEY,
            query: query,
            language: getTmdbLanguage(),
            page: pageNum,
            sort_by: 'popularity.desc',
          };

          // Ajout de filtres supplémentaires
          // Ajouter les paramètres spécifiques à discover
          if (shouldUseDiscover) {
            if (selectedGenres.length > 0) {
              baseSearchParams.with_genres = selectedGenres.join(',');
            }

            if (minRating > 0) {
              baseSearchParams['vote_average.gte'] = minRating;
            }

            if (director || actor) {
              // Obtenir les IDs est asynchrone, fait plus bas ou déjà fait ?
              // Le code original faisait await getPeopleIds ici, mais c'est mieux de le gérer proprement
            }
          }

          // Gestion spécifique Director/Actor pour discover (déplacé du bloc incorrect précédent)
          if (shouldUseDiscover && (director || actor)) {
            const peopleIds = await getPeopleIds(director, actor);
            if (peopleIds) {
              baseSearchParams.with_people = peopleIds;
            }
          }

          // Filter by language if selected
          if (shouldUseDiscover && selectedLanguage) {
            baseSearchParams.with_original_language = selectedLanguage;
          }

          // Filter by country if selected
          if (shouldUseDiscover && selectedCountry) {
            baseSearchParams.with_origin_country = selectedCountry;
          }

          let tvResults = [];
          let movieResults = [];

          // TV results
          if (selectedType === 'all' || selectedType === 'tv') {
            const tvEndpoint = shouldUseDiscover ? 'discover/tv' : 'search/tv';

            // Pour discover/tv, on ajuste certains paramètres spécifiques
            const tvParams = { ...baseSearchParams };
            if (tvEndpoint === 'discover/tv') {
              if (year) {
                delete tvParams.year; // Année n'est pas compatible avec discover/tv
                tvParams.first_air_date_year = year;
              }
            }

            const tvResponse = await axios.get(`https://api.themoviedb.org/3/${tvEndpoint}`, {
              params: tvParams
            });

            // Format TV results
            tvResults = tvResponse.data.results
              .filter((result: any) => {
                // Ne filtrer côté client que si on n'utilise pas discover
                if (!shouldUseDiscover && selectedGenres.length > 0) {
                  // Vérifier si au moins un des genres du résultat est dans selectedGenres
                  return result.genre_ids && result.genre_ids.some((genreId: number) =>
                    selectedGenres.includes(genreId)
                  );
                }
                return true;
              })
              .map((result: any) => ({
                ...result,
                media_type: 'tv'
              }));

            // Contribution à la pagination
            if (selectedType === 'tv') {
              currentTotalPages = tvResponse.data.total_pages || 0;
            }
          }

          // Movie results
          if (selectedType === 'all' || selectedType === 'movie') {
            const movieEndpoint = shouldUseDiscover ? 'discover/movie' : 'search/movie';

            // Pour discover/movie, on ajuste certains paramètres spécifiques
            const movieParams = { ...baseSearchParams };
            if (movieEndpoint === 'discover/movie') {
              if (year) {
                delete movieParams.year; // Année n'est pas compatible avec discover/movie
                movieParams.primary_release_year = year;
              }
            }

            const movieResponse = await axios.get(`https://api.themoviedb.org/3/${movieEndpoint}`, {
              params: movieParams
            });

            // Format movie results
            movieResults = movieResponse.data.results
              .filter((result: any) => {
                // Ne filtrer côté client que si on n'utilise pas discover
                if (!shouldUseDiscover && selectedGenres.length > 0) {
                  // Vérifier si au moins un des genres du résultat est dans selectedGenres
                  return result.genre_ids && result.genre_ids.some((genreId: number) =>
                    selectedGenres.includes(genreId)
                  );
                }
                return true;
              })
              .map((result: any) => ({
                ...result,
                media_type: 'movie'
              }));

            // Contribution à la pagination
            if (selectedType === 'movie') {
              currentTotalPages = movieResponse.data.total_pages || 0;
            } else if (selectedType === 'all') {
              // Update total pages (using maximum of both results)
              currentTotalPages = Math.max(currentTotalPages, movieResponse.data.total_pages || 0);
            }
          }

          // Mettre à jour le total de pages
          setTotalPages(currentTotalPages);

          // Combine results based on selected type
          if (selectedType === 'all') {
            // Combiner et trier par popularité décroissante
            tmdbInitialResults = [...tvResults, ...movieResults]
              .sort((a, b) => b.popularity - a.popularity);
          } else if (selectedType === 'tv') {
            tmdbInitialResults = tvResults;
          } else {
            tmdbInitialResults = movieResults;
          }

          console.log('Initial TMDB results count:', tmdbInitialResults.length);
        } catch (error) {
          console.error('Error getting initial TMDB results:', error);
        }

        // Filter for valid results and language (client-side filtering for search query)
        tmdbInitialResults = tmdbInitialResults.filter(result => {
          if (!result.poster_path) return false;

          if (query) {
            // Filtrage CLIENT-SIDE complet pour le mode Recherche (Query)

            // Language
            if (selectedLanguage && result.original_language !== selectedLanguage) return false;

            // Genres
            if (selectedGenres.length > 0) {
              if (!result.genre_ids || !result.genre_ids.some((id: number) => selectedGenres.includes(id))) return false;
            }

            // Rating
            if (minRating > 0 && result.vote_average < minRating) return false;

            // Year
            if (year) {
              const date = result.release_date || result.first_air_date;
              if (!date || date.substring(0, 4) !== year) return false;
            }

            // Country
            if (selectedCountry) {
              if (!result.origin_country || !result.origin_country.includes(selectedCountry)) return false;
            }
          }

          return true;
        });
      }

      // Recherche TMDB supplémentaire si nécessaire
      if (query && tmdbInitialResults.length > 0) {
        searchResults = tmdbInitialResults;
      }

      // Recherche par filtres uniquement (sans query)
      if (!query && (selectedGenres.length > 0 || selectedType !== 'all' || minRating > 0 || director || actor || year || selectedLanguage || selectedCountry)) {
        const baseParams: any = {
          api_key: TMDB_API_KEY,
          with_genres: selectedGenres.join(','),
          page: isGenreSearch ? pageNum : 1,
          language: getTmdbLanguage(),
          vote_average_gte: minRating,
          sort_by: 'popularity.desc'
        };
        if (selectedLanguage) {
          baseParams.with_original_language = selectedLanguage;
        }
        if (selectedCountry) {
          baseParams.with_origin_country = selectedCountry;
        }
        if (year) {
          if (selectedType === 'movie' || selectedType === 'all') baseParams.primary_release_year = year;
          else if (selectedType === 'tv') baseParams.first_air_date_year = year;
        }
        if (selectedType === 'movie' || selectedType === 'all') baseParams.with_release_type = '2|3';
        if (selectedType === 'tv' || selectedType === 'all') {
          if (selectedType === 'tv') {
            baseParams.with_genres = selectedGenres.length > 0 ? selectedGenres.join(',') : '10759|18|10768';
            if (!baseParams.vote_average_gte || baseParams.vote_average_gte < 7.0) baseParams.vote_average_gte = 7.0;
            baseParams['vote_count.gte'] = 50;
          }
        }
        if (director || actor) {
          const peopleIds = await getPeopleIds(director, actor);
          if (peopleIds) baseParams.with_people = peopleIds;
        }
        let endpoint = 'search/multi';
        const params: any = { ...baseParams };
        if (!query && isGenreSearch) {
          if (selectedType === 'all') {
            try {
              const movieResponse = await axios.get(`https://api.themoviedb.org/3/discover/movie`, { params: { ...baseParams } });
              const tvResponse = await axios.get(`https://api.themoviedb.org/3/discover/tv`, { params: { ...baseParams } });
              const movieResults = movieResponse.data.results.map((result: any) => ({ ...result, media_type: 'movie' }));
              const tvResults = tvResponse.data.results.map((result: any) => ({ ...result, media_type: 'tv' }));
              const combinedResults = [...movieResults, ...tvResults].sort((a, b) => b.popularity - a.popularity);
              currentTotalPages = Math.max(movieResponse.data.total_pages || 0, tvResponse.data.total_pages || 0);
              setTotalPages(currentTotalPages);
              searchResults = combinedResults.filter((result: any) => {
                if (!result.poster_path) return false;
                return result.vote_average >= minRating;
              });
            } catch (error) {
              console.error('Error with dual API calls:', error);
              endpoint = 'discover/movie';
            }
          } else {
            endpoint = `discover/${selectedType}`;
          }
        } else if (query && isGenreSearch) {
          endpoint = 'search/multi';
          params.query = query;
          if (searchResults.length >= 20 && selectedType === 'all') {
            setResults(searchResults);
            setPage(pageNum);
            setHasMore(pageNum < currentTotalPages);
            setLoading(false);
            setIsLoading(false);
            setIsLoadingMore(false);
            return;
          }
        } else if (query) {
          endpoint = 'search/multi';
          params.query = query;
        }
        if (endpoint && endpoint.startsWith('discover')) {
          const response = await axios.get(`https://api.themoviedb.org/3/${endpoint}`, { params });
          if (response.data.total_pages && (!currentTotalPages || isGenreSearch)) {
            currentTotalPages = response.data.total_pages;
            setTotalPages(currentTotalPages);
          }
          let tmdbResults = response.data.results.filter((result: any) => {
            if (!result.poster_path) return false;
            if (endpoint.includes('discover')) return result.vote_average >= minRating;
            return (result.media_type === 'movie' || result.media_type === 'tv') && result.vote_average >= minRating;
          });
          if (endpoint === 'discover/movie') tmdbResults = tmdbResults.map((result: any) => ({ ...result, media_type: 'movie' }));
          else if (endpoint === 'discover/tv') tmdbResults = tmdbResults.map((result: any) => ({ ...result, media_type: 'tv' }));
          searchResults = tmdbResults;
        }
      }

      if (isNewSearch) {
        setResults(searchResults);
      } else {
        setResults(prev => [...prev, ...searchResults]);
      }
      setPage(pageNum + 1);
      setHasMore(searchResults.length >= 20 || (pageNum < currentTotalPages));
    } catch (error) {
      console.error('Error searching:', error);
      setError(i18n.t('search.searchError'));
    } finally {
      setLoading(false);
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  };

  // Helper function to get people IDs for actors and directors from TMDB
  const getPeopleIds = async (directorName?: string, actorName?: string): Promise<string | undefined> => {
    if (!directorName && !actorName) return undefined;

    try {
      const peopleIds: number[] = [];

      // Search for director
      if (directorName) {
        const directorResponse = await axios.get(`https://api.themoviedb.org/3/search/person`, {
          params: {
            api_key: TMDB_API_KEY,
            query: directorName,
            language: getTmdbLanguage()
          }
        });

        const directors = directorResponse.data.results.filter((person: any) => {
          return person.known_for_department === 'Directing';
        });

        if (directors.length > 0) {
          peopleIds.push(directors[0].id);
        }
      }

      // Search for actor
      if (actorName) {
        const actorResponse = await axios.get(`https://api.themoviedb.org/3/search/person`, {
          params: {
            api_key: TMDB_API_KEY,
            query: actorName,
            language: getTmdbLanguage()
          }
        });

        const actors = actorResponse.data.results.filter((person: any) => {
          return person.known_for_department === 'Acting';
        });

        if (actors.length > 0) {
          peopleIds.push(actors[0].id);
        }
      }

      return peopleIds.length > 0 ? peopleIds.join('|') : undefined;
    } catch (error) {
      console.error('Error searching for people:', error);
      return undefined;
    }
  };

  const handleTypeChange = (newType: 'all' | 'movie' | 'tv') => {
    setSelectedType(newType);
    setPage(1); // Reset page when type changes
    // Reset existing IDs when type changes
    // Ne lance plus la recherche automatiquement
  };

  useEffect(() => {
    const fetchGenres = async () => {
      setLoadingGenres(true);
      try {
        const [movieGenres, tvGenres] = await Promise.all([
          axios.get(`https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}`),
          axios.get(`https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_API_KEY}`)
        ]);

        const excludedGenres = [
          'War & Politics',
          'Talk',
          'Soap',
          'Sci-Fi & Fantasy',
          'News',
          'Kids',
          'Action & Adventure',
          'Documentary',
          'Reality'
        ];

        let filteredGenres;
        if (selectedType === 'movie') {
          filteredGenres = movieGenres.data.genres;
        } else if (selectedType === 'tv') {
          filteredGenres = tvGenres.data.genres.filter((genre: Genre) =>
            !excludedGenres.includes(genre.name)
          );
        } else {
          filteredGenres = Array.from(new Set([
            ...movieGenres.data.genres,
            ...tvGenres.data.genres.filter((genre: Genre) =>
              !excludedGenres.includes(genre.name)
            )
          ].map((genre) => JSON.stringify(genre))))
            .map((genre) => JSON.parse(genre));
        }

        // Remplacement des noms par les noms français
        const genresFr = filteredGenres.map((genre: Genre) => ({
          id: genre.id,
          name: GENRES_FR[genre.id] || genre.name
        }));

        setGenres(genresFr);
        setSelectedGenres([]);
      } catch (error) {
        console.error('Error fetching genres:', error);
      } finally {
        setLoadingGenres(false);
      }
    };

    fetchGenres();
  }, [selectedType]);

  const toggleGenre = (genreId: number) => {
    setSelectedGenres(prev =>
      prev.includes(genreId)
        ? prev.filter(id => id !== genreId)
        : [...prev, genreId]
    );
    // Reset page and existingResultIds when genres change
    setPage(1);

  };

  // Reset page and existingResultIds when minRating changes
  useEffect(() => {
    setPage(1);

  }, [minRating]);

  // Reset page and existingResultIds when query changes
  // Reset page and existingResultIds when query changes
  useEffect(() => {
    setPage(1);

  }, [query]);

  // Reset page and existingResultIds when selectedLanguage changes
  useEffect(() => {
    setPage(1);

  }, [selectedLanguage]);

  // Reset page and existingResultIds when selectedCountry changes
  useEffect(() => {
    setPage(1);

  }, [selectedCountry]);

  const value = {
    query,
    setQuery,
    results,
    loading,
    error,
    genres,
    selectedGenres,
    toggleGenre,
    selectedType,
    setSelectedType: handleTypeChange,
    minRating,
    setMinRating,
    hasMore,
    page,
    setPage,
    performSearch,
    loadingGenres,
    showFilters,
    setShowFilters,
    isLoadingMore,
    totalPages,
    director,
    setDirector,
    actor,
    setActor,
    year,
    setYear,
    directorSuggestions,
    actorSuggestions,
    loadingSuggestions,
    fetchPeopleSuggestions,
    selectPerson,
    clearSuggestions,
    autocompleteSuggestions,
    loadingAutocomplete,
    fetchAutocompleteSuggestions,
    clearAutocompleteSuggestions,
    selectedLanguage,
    setSelectedLanguage,
    selectedCountry,
    setSelectedCountry,
  };

  return (
    <SearchContext.Provider value={value}>
      {children}
    </SearchContext.Provider>
  );
};
