import axios from 'axios';
import { getTmdbLanguage } from '../i18n';

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  type: 'movie' | 'tv' | 'person' | 'genre' | 'company';
  img?: string;
  backdrop?: string;
  tmdbId: number;
  val: number; // node size
  year?: string;
  rating?: number;
  overview?: string;
  color?: string;
  // force-graph internal
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  label: string;
  type: 'actor' | 'director' | 'genre' | 'similar' | 'recommendation' | 'company';
  strength: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

// ─── Graph fetch options (customization) ──────────────────────────────────────

export interface GraphFetchOptions {
  /** Include cast/actors */
  actors: boolean;
  /** Max actors per content */
  actorLimit: number;
  /** Include directors */
  directors: boolean;
  /** Include genres */
  genres: boolean;
  /** Include similar content */
  similar: boolean;
  /** Max similar items */
  similarLimit: number;
  /** Include recommendations */
  recommendations: boolean;
  /** Max recommendation items */
  recommendationLimit: number;
  /** Recursion depth (0 = root only, 1 = expand similar/recs) */
  depth: number;
}

export const DEFAULT_GRAPH_OPTIONS: GraphFetchOptions = {
  actors: true,
  actorLimit: 8,
  directors: true,
  genres: true,
  similar: true,
  similarLimit: 6,
  recommendations: true,
  recommendationLimit: 6,
  depth: 1,
};

// ─── Color palette ────────────────────────────────────────────────────────────

const NODE_COLORS: Record<GraphNode['type'], string> = {
  movie: '#e50914',   // Netflix red
  tv: '#3b82f6',      // Blue
  person: '#f59e0b',  // Amber
  genre: '#8b5cf6',   // Purple
  company: '#10b981', // Emerald
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNodeId(type: string, id: number): string {
  return `${type}-${id}`;
}

function getImg(path: string | null, size = 'w185'): string | undefined {
  return path ? `${IMG_BASE}/${size}${path}` : undefined;
}

// ─── Fetch core content details + credits + similar + recommendations ─────────

async function fetchContentGraph(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  depth: number = 1,
  options: GraphFetchOptions = DEFAULT_GRAPH_OPTIONS
): Promise<GraphData> {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const visited = new Set<string>();

  async function explore(type: 'movie' | 'tv', id: number, currentDepth: number) {
    const nodeId = makeNodeId(type, id);
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    try {
      // Build parallel requests based on enabled options
      const requests: Promise<any>[] = [
        axios.get(`${TMDB_BASE}/${type}/${id}`, {
          params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
        }),
      ];
      // credits (needed for actors OR directors)
      if (options.actors || options.directors) {
        requests.push(
          axios.get(`${TMDB_BASE}/${type}/${id}/credits`, {
            params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
          })
        );
      } else {
        requests.push(Promise.resolve({ data: { cast: [], crew: [] } }));
      }
      // similar
      if (options.similar) {
        requests.push(
          axios.get(`${TMDB_BASE}/${type}/${id}/similar`, {
            params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), page: 1 },
          })
        );
      } else {
        requests.push(Promise.resolve({ data: { results: [] } }));
      }
      // recommendations
      if (options.recommendations) {
        requests.push(
          axios.get(`${TMDB_BASE}/${type}/${id}/recommendations`, {
            params: { api_key: TMDB_API_KEY, language: getTmdbLanguage(), page: 1 },
          })
        );
      } else {
        requests.push(Promise.resolve({ data: { results: [] } }));
      }

      const [detailsRes, creditsRes, similarRes, recsRes] = await Promise.all(requests);

      const d = detailsRes.data;
      const title = type === 'movie' ? d.title : d.name;
      const date = type === 'movie' ? d.release_date : d.first_air_date;

      // Add main node
      const mainNode: GraphNode = {
        id: nodeId,
        label: title || 'Sans titre',
        type,
        img: getImg(d.poster_path),
        backdrop: getImg(d.backdrop_path, 'w780'),
        tmdbId: id,
        val: currentDepth === 0 ? 28 : 18,
        year: date ? date.substring(0, 4) : undefined,
        rating: d.vote_average,
        overview: d.overview,
        color: NODE_COLORS[type],
      };
      nodes.set(nodeId, mainNode);

      // ─── Cast (top N actors) ───────────────────────────────────
      if (options.actors) {
      const cast = (creditsRes.data.cast || []).slice(0, options.actorLimit);
      for (const person of cast) {
        const personId = makeNodeId('person', person.id);
        if (!nodes.has(personId)) {
          nodes.set(personId, {
            id: personId,
            label: person.name,
            type: 'person',
            img: getImg(person.profile_path),
            tmdbId: person.id,
            val: 10,
            color: NODE_COLORS.person,
          });
        }
        links.push({
          source: nodeId,
          target: personId,
          label: person.character || 'Acteur',
          type: 'actor',
          strength: 0.7,
        });
      }

      }

      // ─── Director(s) ──────────────────────────────────────────
      if (options.directors) {
      const directors = (creditsRes.data.crew || []).filter(
        (c: any) => c.job === 'Director'
      );
      for (const dir of directors) {
        const dirId = makeNodeId('person', dir.id);
        if (!nodes.has(dirId)) {
          nodes.set(dirId, {
            id: dirId,
            label: dir.name,
            type: 'person',
            img: getImg(dir.profile_path),
            tmdbId: dir.id,
            val: 14,
            color: '#ef4444', // red-ish for directors
          });
        }
        links.push({
          source: nodeId,
          target: dirId,
          label: 'Réalisateur',
          type: 'director',
          strength: 0.9,
        });
      }

      }

      // ─── Genres ────────────────────────────────────────────────
      if (options.genres) {
      for (const genre of d.genres || []) {
        const genreId = makeNodeId('genre', genre.id);
        if (!nodes.has(genreId)) {
          nodes.set(genreId, {
            id: genreId,
            label: genre.name,
            type: 'genre',
            tmdbId: genre.id,
            val: 12,
            color: NODE_COLORS.genre,
          });
        }
        links.push({
          source: nodeId,
          target: genreId,
          label: 'Genre',
          type: 'genre',
          strength: 0.4,
        });
      }

      }

      // ─── Similar (top N) ──────────────────────────────────────────
      const similar = (similarRes.data.results || []).slice(0, options.similarLimit);
      for (const item of similar) {
        const simType = item.media_type || type;
        const simId = makeNodeId(simType, item.id);
        const simTitle = simType === 'movie' ? item.title : item.name;
        const simDate = simType === 'movie' ? item.release_date : item.first_air_date;

        if (!nodes.has(simId)) {
          nodes.set(simId, {
            id: simId,
            label: simTitle || 'Sans titre',
            type: simType as 'movie' | 'tv',
            img: getImg(item.poster_path),
            backdrop: getImg(item.backdrop_path, 'w780'),
            tmdbId: item.id,
            val: 14,
            year: simDate ? simDate.substring(0, 4) : undefined,
            rating: item.vote_average,
            overview: item.overview,
            color: NODE_COLORS[simType as 'movie' | 'tv'] || NODE_COLORS.movie,
          });
        }
        links.push({
          source: nodeId,
          target: simId,
          label: 'Similaire',
          type: 'similar',
          strength: 0.5,
        });

        // Recurse into similar at reduced depth
        if (currentDepth < options.depth) {
          await explore(simType as 'movie' | 'tv', item.id, currentDepth + 1);
        }
      }

      // ─── Recommendations (top N) ──────────────────────────────────
      const recs = (recsRes.data.results || []).slice(0, options.recommendationLimit);
      for (const item of recs) {
        const recType = item.media_type || type;
        const recId = makeNodeId(recType, item.id);
        const recTitle = recType === 'movie' ? item.title : item.name;
        const recDate = recType === 'movie' ? item.release_date : item.first_air_date;

        if (!nodes.has(recId)) {
          nodes.set(recId, {
            id: recId,
            label: recTitle || 'Sans titre',
            type: recType as 'movie' | 'tv',
            img: getImg(item.poster_path),
            backdrop: getImg(item.backdrop_path, 'w780'),
            tmdbId: item.id,
            val: 14,
            year: recDate ? recDate.substring(0, 4) : undefined,
            rating: item.vote_average,
            overview: item.overview,
            color: NODE_COLORS[recType as 'movie' | 'tv'] || NODE_COLORS.movie,
          });
        }
        links.push({
          source: nodeId,
          target: recId,
          label: 'Recommandé',
          type: 'recommendation',
          strength: 0.6,
        });

        if (currentDepth < options.depth) {
          await explore(recType as 'movie' | 'tv', item.id, currentDepth + 1);
        }
      }
    } catch (err) {
      console.error(`CinéGraph: failed to fetch ${type}/${id}`, err);
    }
  }

  await explore(mediaType, tmdbId, 0);

  // Deduplicate links
  const linkSet = new Set<string>();
  const uniqueLinks = links.filter((l) => {
    const key = `${typeof l.source === 'string' ? l.source : (l.source as any).id}-${typeof l.target === 'string' ? l.target : (l.target as any).id}-${l.type}`;
    if (linkSet.has(key)) return false;
    linkSet.add(key);
    return true;
  });

  return {
    nodes: Array.from(nodes.values()),
    links: uniqueLinks,
  };
}

// ─── Search TMDB for starting point ─────────────────────────────────────────

export async function searchTMDB(query: string): Promise<Array<{
  id: number;
  title: string;
  type: 'movie' | 'tv';
  year?: string;
  poster?: string;
  rating?: number;
}>> {
  try {
    const res = await axios.get(`${TMDB_BASE}/search/multi`, {
      params: {
        api_key: TMDB_API_KEY,
        language: getTmdbLanguage(),
        query,
        page: 1,
      },
    });
    return (res.data.results || [])
      .filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv')
      .slice(0, 12)
      .map((r: any) => ({
        id: r.id,
        title: r.media_type === 'movie' ? r.title : r.name,
        type: r.media_type as 'movie' | 'tv',
        year: (r.release_date || r.first_air_date || '').substring(0, 4) || undefined,
        poster: getImg(r.poster_path, 'w154'),
        rating: r.vote_average,
      }));
  } catch {
    return [];
  }
}

// ─── Fetch trending for default display ─────────────────────────────────────

export async function fetchTrending(): Promise<Array<{
  id: number;
  title: string;
  type: 'movie' | 'tv';
  year?: string;
  poster?: string;
  rating?: number;
}>> {
  try {
    const res = await axios.get(`${TMDB_BASE}/trending/all/week`, {
      params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
    });
    return (res.data.results || [])
      .filter((r: any) => r.media_type === 'movie' || r.media_type === 'tv')
      .slice(0, 20)
      .map((r: any) => ({
        id: r.id,
        title: r.media_type === 'movie' ? r.title : r.name,
        type: r.media_type as 'movie' | 'tv',
        year: (r.release_date || r.first_air_date || '').substring(0, 4) || undefined,
        poster: getImg(r.poster_path, 'w154'),
        rating: r.vote_average,
      }));
  } catch {
    return [];
  }
}

// ─── Fetch person filmography graph ─────────────────────────────────────────

export async function fetchPersonGraph(personId: number, options: GraphFetchOptions = DEFAULT_GRAPH_OPTIONS): Promise<GraphData> {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];

  try {
    const [personRes, creditsRes] = await Promise.all([
      axios.get(`${TMDB_BASE}/person/${personId}`, {
        params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
      }),
      axios.get(`${TMDB_BASE}/person/${personId}/combined_credits`, {
        params: { api_key: TMDB_API_KEY, language: getTmdbLanguage() },
      }),
    ]);

    const person = personRes.data;
    const personNodeId = makeNodeId('person', personId);
    nodes.set(personNodeId, {
      id: personNodeId,
      label: person.name,
      type: 'person',
      img: getImg(person.profile_path),
      tmdbId: personId,
      val: 28,
      overview: person.biography,
      color: NODE_COLORS.person,
    });

    // Sort cast credits by popularity, take top N based on actorLimit * 2
    const castCredits = (creditsRes.data.cast || [])
      .sort((a: any, b: any) => (b.vote_count || 0) - (a.vote_count || 0))
      .slice(0, options.actorLimit * 3);

    for (const credit of castCredits) {
      const type = credit.media_type as 'movie' | 'tv';
      if (type !== 'movie' && type !== 'tv') continue;
      const contentId = makeNodeId(type, credit.id);
      const title = type === 'movie' ? credit.title : credit.name;
      const date = type === 'movie' ? credit.release_date : credit.first_air_date;

      if (!nodes.has(contentId)) {
        nodes.set(contentId, {
          id: contentId,
          label: title || 'Sans titre',
          type,
          img: getImg(credit.poster_path),
          tmdbId: credit.id,
          val: 14,
          year: date ? date.substring(0, 4) : undefined,
          rating: credit.vote_average,
          color: NODE_COLORS[type],
        });
      }
      links.push({
        source: personNodeId,
        target: contentId,
        label: credit.character || 'Rôle',
        type: 'actor',
        strength: 0.6,
      });
    }

    // Also crew (director) credits
    const crewCredits = (creditsRes.data.crew || [])
      .filter((c: any) => c.job === 'Director')
      .sort((a: any, b: any) => (b.vote_count || 0) - (a.vote_count || 0))
      .slice(0, 10);

    for (const credit of crewCredits) {
      const type = credit.media_type as 'movie' | 'tv';
      if (type !== 'movie' && type !== 'tv') continue;
      const contentId = makeNodeId(type, credit.id);
      const title = type === 'movie' ? credit.title : credit.name;
      const date = type === 'movie' ? credit.release_date : credit.first_air_date;

      if (!nodes.has(contentId)) {
        nodes.set(contentId, {
          id: contentId,
          label: title || 'Sans titre',
          type,
          img: getImg(credit.poster_path),
          tmdbId: credit.id,
          val: 14,
          year: date ? date.substring(0, 4) : undefined,
          rating: credit.vote_average,
          color: NODE_COLORS[type],
        });
      }
      links.push({
        source: personNodeId,
        target: contentId,
        label: 'Réalisateur',
        type: 'director',
        strength: 0.8,
      });
    }
  } catch (err) {
    console.error('CinéGraph: failed to fetch person', err);
  }

  return {
    nodes: Array.from(nodes.values()),
    links,
  };
}

export { fetchContentGraph, NODE_COLORS, makeNodeId, getImg };
