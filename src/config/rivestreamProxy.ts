const envProxies = (import.meta.env.VITE_RIVESTREAM_PROXIES as string | undefined)
  ?.split(',')
  .map(proxy => proxy.trim())
  .filter(Boolean) || [];

const proxiesEmbedHost = (() => {
  try {
    const value = import.meta.env.VITE_PROXIES_EMBED_API as string | undefined;
    return value ? new URL(value).host : '';
  } catch {
    return '';
  }
})();

export const RIVESTREAM_PROXIES = envProxies.length > 0
  ? envProxies
  : (proxiesEmbedHost ? [proxiesEmbedHost] : []);
