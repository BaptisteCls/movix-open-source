export interface CoflixPlayerLike {
  clone_url?: string;
  decoded_url?: string;
  iframe_src?: string;
  url?: string;
}

export const getCoflixPreferredUrl = (source?: CoflixPlayerLike | null): string => {
  if (!source) return '';

  if (typeof source.clone_url === 'string' && source.clone_url.trim()) {
    return source.clone_url.trim();
  }

  if (typeof source.decoded_url === 'string' && source.decoded_url.trim()) {
    return source.decoded_url.trim();
  }

  if (typeof source.iframe_src === 'string' && source.iframe_src.trim()) {
    return source.iframe_src.trim();
  }

  if (typeof source.url === 'string' && source.url.trim()) {
    return source.url.trim();
  }

  return '';
};
