export interface SharedListFavorite {
  shareCode: string;
  listName: string;
  username: string;
  avatar?: string;
  isVip?: boolean;
  itemCount: number;
  addedAt: string;
}

export const SHARED_LIST_FAVORITES_STORAGE_KEY = 'shared_list_favorites';

const isSharedListFavorite = (value: unknown): value is SharedListFavorite => {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<SharedListFavorite>;
  return (
    typeof candidate.shareCode === 'string' &&
    typeof candidate.listName === 'string' &&
    typeof candidate.username === 'string' &&
    typeof candidate.itemCount === 'number' &&
    typeof candidate.addedAt === 'string'
  );
};

export const readSharedListFavorites = (): SharedListFavorite[] => {
  try {
    const raw = localStorage.getItem(SHARED_LIST_FAVORITES_STORAGE_KEY);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter(isSharedListFavorite) : [];
  } catch {
    return [];
  }
};

export const writeSharedListFavorites = (favorites: SharedListFavorite[]): void => {
  try {
    localStorage.setItem(SHARED_LIST_FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // Ignore storage write errors
  }
};
