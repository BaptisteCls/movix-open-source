import axios from 'axios';
import { MAIN_API } from '../config/runtime';

const api = axios.create({
  baseURL: `${MAIN_API}/api/content`,
  timeout: 15000,
});

export interface SearchParams {
  q?: string;
  type?: 'multi' | 'movie' | 'tv' | 'person';
  page?: number;
  with_genres?: string;
  sort_by?: string;
  vote_average_gte?: number;
  with_people?: string;
  with_original_language?: string;
  with_origin_country?: string;
  year_gte?: string;
  year_lte?: string;
}

export interface DiscoverParams {
  with_genres?: string;
  with_watch_providers?: string;
  with_companies?: string;
  sort_by?: string;
  page?: number;
  vote_average_gte?: number;
  vote_count_gte?: number;
  with_original_language?: string;
  with_origin_country?: string;
  year_gte?: string;
  year_lte?: string;
  watch_region?: string;
  with_release_type?: string;
  include_adult?: boolean;
}

export interface CineGraphParams {
  actors?: string;
  actorLimit?: number;
  directors?: string;
  genres?: string;
  similar?: string;
  similarLimit?: number;
  recommendations?: string;
  recommendationLimit?: number;
  depth?: number;
}

export const contentAPI = {
  // Aggregated page routes
  getHome: () => api.get('/home').then(r => r.data),
  getMovies: () => api.get('/movies').then(r => r.data),
  getTV: () => api.get('/tv').then(r => r.data),

  // Detail routes
  getMovieDetails: (id: number | string) => api.get(`/movie/${id}`).then(r => r.data),
  getTVDetails: (id: number | string) => api.get(`/tv/${id}`).then(r => r.data),
  getTVSeason: (id: number | string, season: number) => api.get(`/tv/${id}/season/${season}`).then(r => r.data),
  getTVEpisode: (id: number | string, season: number, episode: number) =>
    api.get(`/tv/${id}/season/${season}/episode/${episode}`).then(r => r.data),
  getPerson: (id: number | string) => api.get(`/person/${id}`).then(r => r.data),

  // Search & discover
  search: (params: SearchParams) => api.get('/search', { params }).then(r => r.data),
  discover: (mediaType: string, params: DiscoverParams) => api.get(`/discover/${mediaType}`, { params }).then(r => r.data),

  // CineGraph
  getCineGraph: (mediaType: string, id: number | string, params?: CineGraphParams) =>
    api.get(`/cinegraph/${mediaType}/${id}`, { params }).then(r => r.data),
  searchCineGraph: (q: string, type?: string) =>
    api.get('/cinegraph/search', { params: { q, type } }).then(r => r.data),
  getCineGraphTrending: () => api.get('/cinegraph/trending').then(r => r.data),

  // Metadata
  getGenres: (mediaType: string) => api.get(`/genres/${mediaType}`).then(r => r.data),
  getGenreImages: (mediaType: string) => api.get(`/genre-images/${mediaType}`).then(r => r.data),
  getCollection: (id: number | string) => api.get(`/collection/${id}`).then(r => r.data),
  getCollections: () => api.get('/collections').then(r => r.data),
  getLogo: (mediaType: string, id: number | string) => api.get(`/logo/${mediaType}/${id}`).then(r => r.data),
  getTrending: (mediaType: string, timeWindow: string, page?: number) =>
    api.get(`/trending/${mediaType}/${timeWindow}`, { params: { page } }).then(r => r.data),
  getRecommendations: (mediaType: string, id: number | string, page?: number) =>
    api.get(`/recommendations/${mediaType}/${id}`, { params: { page } }).then(r => r.data),
  getSimilar: (mediaType: string, id: number | string, page?: number) =>
    api.get(`/similar/${mediaType}/${id}`, { params: { page } }).then(r => r.data),
  getDetails: (mediaType: string, id: number | string) => api.get(`/details/${mediaType}/${id}`).then(r => r.data),

  // Batch & collection discovery
  discoverCollections: (page?: number) => api.get('/discover-collections', { params: { page } }).then(r => r.data),
  searchCollections: (q: string) => api.get('/search-collections', { params: { q } }).then(r => r.data),
  batchDetails: (items: Array<{ mediaType: string; id: string | number }>) =>
    api.get('/batch-details', { params: { items: items.map(i => `${i.mediaType}:${i.id}`).join(',') } }).then(r => r.data),
};

export default contentAPI;
