/*
 * Service worker de la PWA.
 *
 * Regla de oro: NUNCA cachear respuestas de la API. Sólo se guardan assets
 * estáticos del mismo origen (HTML, CSS, JS, iconos y el manifest). Cualquier
 * petición cruzada —la API en otro origin— se deja pasar sin interceptar.
 */
var CACHE = 'raiz-esencia-shell-v5';
var SHELL = [
  './',
  './index.html',
  './css/style.css?v=5',
  './js/config.js?v=5',
  './js/app.js?v=5',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (nombres) {
      return Promise.all(nombres
        .filter(function (nombre) { return nombre !== CACHE; })
        .map(function (nombre) { return caches.delete(nombre); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function esAssetEstatico(url) {
  if (url.origin !== self.location.origin) return false;
  if (/\.(css|js|png|svg|ico|webmanifest|jpg|jpeg|webp)$/i.test(url.pathname)) return true;
  return url.pathname === '/' || /\.html?$/i.test(url.pathname);
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (!esAssetEstatico(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(function (response) {
        var copia = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copia); });
        return response;
      }).catch(function () {
        return caches.match(request).then(function (respuesta) {
          return respuesta || caches.match('./index.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (guardada) {
      var actualizada = fetch(request).then(function (response) {
        if (response && response.ok) {
          var copia = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copia); });
        }
        return response;
      }).catch(function () { return guardada; });
      return guardada || actualizada;
    })
  );
});
