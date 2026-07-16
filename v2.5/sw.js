/* Rudertrimm v2 service worker: app-scoped, allowlisted, versioned caching. */
'use strict';
importScripts('./version.js');
const RELEASE = globalThis.RUDERTRIMM_RELEASE;
if (!RELEASE) throw new TypeError('Zentrale Release-Metadaten fehlen');
const {appVersion: APP_VERSION, buildDate: BUILD_DATE, buildId: BUILD_ID, shellRevision: SHELL_REVISION} = RELEASE;

const CACHE_FAMILY = 'rudertrimm-v2::';
const SCOPE_URL = new URL(self.registration.scope);
if (SCOPE_URL.origin !== self.location.origin) throw new TypeError('Service-worker scope must be same-origin');
const SCOPE_CACHE_PREFIX = `${CACHE_FAMILY}scope::${encodeURIComponent(SCOPE_URL.origin + SCOPE_URL.pathname)}::`;
const CACHE_NAME = `${SCOPE_CACHE_PREFIX}shell::${APP_VERSION}::${BUILD_ID}`;
const SHELL_URL = new URL('./index.html', SCOPE_URL).href;

const PRECACHE_PATHS = Object.freeze([
  './index.html',
  './version.js',
  './manifest.json',
  './css/base.css',
  './css/v2.css',
  './js/app.bundle.js',
  './js/app.mjs',
  './js/core.mjs',
  './js/storage.mjs',
  './js/import-adapter.mjs',
  './js/history.mjs',
  './js/efa-csv.mjs',
  './js/legacy-v1.mjs',
  './js/recommendations.mjs',
  './js/ui-session.mjs',
  './icon-192.png',
  './icon-512.png',
]);

const PRECACHE_URLS = new Map(PRECACHE_PATHS.map(path => {
  const url = new URL(path, SCOPE_URL);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) {
    throw new TypeError(`Unsafe precache URL: ${url.href}`);
  }
  return [`${url.origin}${url.pathname}`, url.href];
}));

function expectedContentType(url) {
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('.html')) return /^text\/html(?:;|$)/iu;
  if (pathname.endsWith('.json')) return /^(?:application\/(?:manifest\+)?json|text\/json)(?:;|$)/iu;
  if (pathname.endsWith('.css')) return /^text\/css(?:;|$)/iu;
  if (pathname.endsWith('.mjs') || pathname.endsWith('.js')) return /^(?:text|application)\/javascript(?:;|$)/iu;
  if (pathname.endsWith('.png')) return /^image\/png(?:;|$)/iu;
  return null;
}

function isCacheableResponse(response, {expectHTML = false, expectedURL = null} = {}) {
  if (!response || !response.ok || response.type === 'opaque' || response.type === 'opaqueredirect') return false;
  if (response.redirected) return false;
  if (response.type !== 'basic' && response.type !== 'default') return false;
  let responseURL;
  try { responseURL = new URL(response.url); } catch { return false; }
  if (responseURL.origin !== self.location.origin || !responseURL.pathname.startsWith(SCOPE_URL.pathname)) return false;
  if (expectedURL) {
    const expected = new URL(expectedURL);
    if (responseURL.href !== expected.href) return false;
  }
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (expectHTML && !contentType.startsWith('text/html')) return false;
  const expectedType = expectedURL ? expectedContentType(expectedURL) : null;
  if (expectedType && !expectedType.test(contentType)) return false;
  return true;
}

async function notifyClients(type, extra = {}) {
  const clients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  for (const client of clients) client.postMessage({type, appVersion: APP_VERSION, buildDate: BUILD_DATE, buildId: BUILD_ID, shellRevision: SHELL_REVISION, ...extra});
}

async function precacheShell() {
  const responses = await Promise.all([...PRECACHE_URLS.values()].map(async url => {
    const request = new Request(url, {cache: 'reload', credentials: 'same-origin'});
    const response = await fetch(request);
    if (!isCacheableResponse(response, {expectHTML: url === SHELL_URL, expectedURL: url})) {
      throw new TypeError(`Refusing non-cacheable precache response: ${url}`);
    }
    return {request: new Request(url, {credentials: 'same-origin'}), response};
  }));

  try {
    const cache = await caches.open(CACHE_NAME);
    for (const {request, response} of responses) await cache.put(request, response);
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await precacheShell();
    await notifyClients('RUDERTRIMM_UPDATE_WAITING');
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith(SCOPE_CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
    await notifyClients('RUDERTRIMM_UPDATE_ACTIVATED');
  })());
});

function canonicalAllowedAsset(requestURL) {
  if (requestURL.search) return null;
  return PRECACHE_URLS.get(`${requestURL.origin}${requestURL.pathname}`) ?? null;
}

function missingReleaseResponse(message) {
  return new Response(message, {
    status: 503,
    headers: {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'},
  });
}

async function navigationResponse() {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(SHELL_URL);
  return cached ?? missingReleaseResponse('Rudertrimm-Releasecache ist unvollständig. Bitte online neu installieren.');
}

async function allowlistedAssetResponse(canonicalURL) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(canonicalURL);
  return cached ?? missingReleaseResponse('Rudertrimm-Asset fehlt im aktiven Releasecache.');
}

self.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse());
    return;
  }

  const canonicalURL = canonicalAllowedAsset(url);
  if (canonicalURL) event.respondWith(allowlistedAssetResponse(canonicalURL));
});

self.addEventListener('message', event => {
  const type = event.data?.type;
  if (type === 'RUDERTRIMM_SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  } else if (type === 'RUDERTRIMM_GET_VERSION') {
    event.source?.postMessage?.({type: 'RUDERTRIMM_VERSION', appVersion: APP_VERSION, buildDate: BUILD_DATE, buildId: BUILD_ID, shellRevision: SHELL_REVISION, cacheName: CACHE_NAME});
  }
});
