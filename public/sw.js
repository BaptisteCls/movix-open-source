const CACHE_NAME = 'movix-shell-v2';
const APP_SHELL_URL = '/';
const PRECACHE_URLS = ['/movix.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Network-first pour les navigations afin d'eviter qu'un vieux index.html
  // pointe encore vers des chunks hashes supprimes apres un deploiement.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(event.request);

          if (response && response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(APP_SHELL_URL, response.clone());
          }

          return response;
        } catch (error) {
          const cachedShell = await caches.match(APP_SHELL_URL);
          if (cachedShell) {
            return cachedShell;
          }

          throw error;
        }
      })()
    );
  }
});
