/**
 * Cloudflare Workers Proxy Server
 * Supporte la route /proxy pour le streaming de MP4 avec Range requests
 */

// Headers CORS pour toutes les réponses
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE, PATCH',
  'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range, Authorization, Cache-Control, Pragma',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

/**
 * Prépare les headers pour la requête vers l'URL cible
 */
function prepareHeaders(targetUrl, request, customHeaders = {}) {
  const url = new URL(targetUrl);
  const refererOrigin = `${url.protocol}//${url.host}`;
  const targetHost = url.host;

  // Headers par défaut pour les requêtes vidéo
  let headers = {
    'Accept': '*/*',
    'Accept-Encoding': 'identity;q=1, *;q=0',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Connection': 'keep-alive',
    'Host': targetHost,
    'Referer': request.headers.get('referer') || refererOrigin,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  };

  // Ajouter le header Range si présent
  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    headers['Range'] = rangeHeader;
  }

  // Ajouter les cookies si présents
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  // Fusionner les headers personnalisés (ils ont la priorité)
  if (customHeaders && typeof customHeaders === 'object') {
    headers = { ...headers, ...customHeaders };
  }

  return headers;
}

/**
 * Gère les requêtes OPTIONS (preflight CORS)
 */
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * Gère les requêtes proxy
 */
async function handleProxy(request) {
  try {
    // Extraire l'URL cible depuis les query parameters
    const url = new URL(request.url);
    const targetUrlParam = url.searchParams.get('url');
    
    if (!targetUrlParam) {
      return new Response(
        JSON.stringify({ error: 'No URL provided' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );
    }

    // Décoder l'URL
    const targetUrl = decodeURIComponent(targetUrlParam);

    // Extraire les headers personnalisés depuis le paramètre headers
    let customHeaders = {};
    const headersParam = url.searchParams.get('headers');
    if (headersParam) {
      try {
        customHeaders = JSON.parse(decodeURIComponent(headersParam));
      } catch (e) {
        // Si le parsing échoue, continuer sans les headers personnalisés
        console.warn('Failed to parse custom headers:', e);
      }
    }

    // Détecter si c'est un fichier MP4
    const isMp4 = targetUrl.toLowerCase().includes('.mp4') ||
                   request.headers.get('accept')?.includes('video/mp4');

    // Préparer les headers pour la requête
    const forwardHeaders = prepareHeaders(targetUrl, request, customHeaders);

    // Faire la requête vers l'URL cible
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      // Cloudflare Workers supporte automatiquement les Range requests
    });

    // Exécuter la requête avec fetch
    const response = await fetch(proxyRequest);

    // Si ce n'est pas une réponse réussie, retourner l'erreur
    if (!response.ok && response.status !== 206) {
      return new Response(
        JSON.stringify({
          error: 'Request failed',
          status: response.status,
          statusText: response.statusText,
        }),
        {
          status: response.status,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );
    }

    // Préparer les headers de réponse
    const responseHeaders = new Headers();

    // Copier les headers de la réponse source (sauf ceux qu'on ne veut pas)
    const headersToSkip = ['transfer-encoding', 'connection', 'content-encoding', 'access-control-allow-origin'];
    for (const [key, value] of response.headers.entries()) {
      if (!headersToSkip.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    // Ajouter les headers CORS
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(key, value);
    }

    // Headers spécifiques pour MP4
    if (isMp4) {
      responseHeaders.set('Accept-Ranges', 'bytes');
      responseHeaders.set('Cache-Control', 'public, max-age=3600');

      // S'assurer que Content-Type est défini
      if (!responseHeaders.has('Content-Type')) {
        responseHeaders.set('Content-Type', 'video/mp4');
      }

      // Pour les réponses 206 (Partial Content), s'assurer que Content-Range est présent
      if (response.status === 206) {
        const contentRange = response.headers.get('content-range');
        const contentLength = response.headers.get('content-length');

        if (contentRange) {
          responseHeaders.set('Content-Range', contentRange);
        }
        if (contentLength) {
          responseHeaders.set('Content-Length', contentLength);
        }

        // S'assurer que Accept-Ranges est présent
        if (!responseHeaders.has('Accept-Ranges')) {
          responseHeaders.set('Accept-Ranges', 'bytes');
        }
      }
    }

    // Retourner la réponse en streaming (Cloudflare Workers stream automatiquement)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error('Proxy error:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal Server Error',
        message: error.message,
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  }
}

/**
 * Handler principal du worker
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Gérer les requêtes OPTIONS (preflight CORS)
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    // Route proxy
    if (path === '/proxy' || path.startsWith('/proxy/')) {
      return handleProxy(request);
    }

    // Route de santé
    if (path === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          message: 'Cloudflare Workers Proxy Server is running',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );
    }

    // Route non trouvée
    return new Response(
      JSON.stringify({ error: 'Not Found' }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        },
      }
    );
  },
};

