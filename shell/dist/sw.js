/*
 * dsh remote service worker, scope "/".
 *
 * The worker owns only the static app shell: index.html, the esbuild bundles,
 * the web app manifest, the icons, and the offline notice. It never caches
 * application data.
 *
 * Credential and API rules:
 * - Navigation responses are never written to Cache Storage. The pairing URL
 *   carries `relay`, `host`, and `token` query parameters, and caching that
 *   response would persist a device credential in the cache.
 * - Same-origin `/v1/` HTTP endpoints, requests with an Authorization header,
 *   and requests carrying token query parameters bypass the worker entirely.
 * - WebSocket traffic does not pass through fetch handlers; the `/v1/ws` guard
 *   is defense in depth in case a browser surfaces the handshake.
 * - Cross-origin requests (the relay HTTP API, WebSocket, or any other origin)
 *   are left untouched.
 *
 * Shell assets are network-first so a rebuilt bundle or manifest is picked up
 * while online; the precache is the fallback when the network fails.
 */

const CACHE_NAME = 'dsh-remote-shell-v1'
const CACHE_PREFIX = 'dsh-remote-shell-'
const SHELL_FALLBACK = '/index.html'
const OFFLINE_URL = '/dist/offline.html'

/* Keep in sync with APP_SHELL_ASSETS in src/pwa.ts. */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/dist/main.js',
  '/dist/main.css',
  '/dist/manifest.webmanifest',
  '/dist/icons/icon.svg',
  '/dist/icons/icon-192.png',
  '/dist/icons/icon-512.png',
  '/dist/offline.html',
]

const SHELL_ASSET_PATHS = new Set(SHELL_ASSETS)

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      // Fails loudly during install if the build did not copy a shell asset.
      await cache.addAll(SHELL_ASSETS)
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // WebSocket upgrade requests are not dispatched as fetch events, and other
  // methods (POST/PUT/DELETE) must reach the network untouched.
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    // Handled even when the URL contains `token`, but the response is never
    // cached; the fallback is the precached shell without query parameters.
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (isCredentialedOrApiRequest(request, url)) return
  if (!isShellAsset(url.pathname)) return

  event.respondWith(networkFirstAsset(request, url.pathname))
})

async function networkFirstNavigation(request) {
  try {
    return await fetch(request)
  } catch {
    const cache = await caches.open(CACHE_NAME)
    const shell = await cache.match(SHELL_FALLBACK)
    if (shell !== undefined) return shell
    const offline = await cache.match(OFFLINE_URL)
    if (offline !== undefined) return offline
    return textResponse('dsh remote is offline.\n')
  }
}

async function networkFirstAsset(request, pathname) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok && !response.redirected) {
      // Cache a clean URL key so no query string or credential can be stored.
      await cache.put(pathname, response.clone())
    }
    return response
  } catch {
    const cached = await cache.match(pathname)
    if (cached !== undefined) return cached
    return textResponse('dsh remote is offline.\n')
  }
}

/**
 * Exclude API and credential-bearing traffic from the worker.
 *
 * @param {Request} request incoming fetch request.
 * @param {URL} url parsed request URL.
 * @returns {boolean} true when the request must bypass the service worker.
 */
function isCredentialedOrApiRequest(request, url) {
  if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return true
  if (url.searchParams.has('token') || url.searchParams.has('pairToken')) return true
  if (url.searchParams.has('deviceToken')) return true
  if (request.headers.has('authorization') || request.headers.has('cookie')) return true
  return false
}

/**
 * @param {string} pathname same-origin request path.
 * @returns {boolean} true for a precached app-shell asset.
 */
function isShellAsset(pathname) {
  if (pathname === '/dist/sw.js') return false
  return SHELL_ASSET_PATHS.has(pathname) || pathname.startsWith('/dist/icons/')
}

function textResponse(body) {
  return new Response(body, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}
