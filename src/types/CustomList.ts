export interface CustomList {
  id: number;
  name: string;
  items: {
    id: number;
    type: 'movie' | 'tv';
    title: string;
    poster_path: string;
    addedAt: string;
  }[];
} 