/**
 * Service Worker - Batalha Naval High-Tech PWA
 * Caching tático offline e suporte a instalação como aplicativo nativo.
 */

const CACHE_NAME = 'batalha-naval-v2.5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/audio.js',
  '/js/haptics.js',
  '/js/game.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Pré-carregando arquivos essenciais para PWA (v2.5)...');
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[ServiceWorker] Removendo cache antigo:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Suporte a mensagens do cliente para forçar atualização ou purga de cache
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting' || (event.data && event.data.action === 'skipWaiting')) {
    self.skipWaiting();
  }
  if (event.data === 'clearCache' || (event.data && event.data.action === 'clearCache')) {
    event.waitUntil(
      caches.keys().then((keys) => {
        return Promise.all(keys.map((key) => caches.delete(key)));
      })
    );
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Não intercepta chamadas de API, WebSocket ou domínios externos
  if (url.pathname.startsWith('/api') || event.request.method !== 'GET') {
    return;
  }

  // Network-First com validação de rede para evitar servir código defasado
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Fallback para cache apenas quando offline
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
      })
  );
});

// --- PUSH NOTIFICATIONS ---
self.addEventListener('push', (event) => {
  let data = {
    title: 'Batalha Naval',
    body: 'Você recebeu um novo chamado tático!',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: '/' }
  };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const isFriendRequest = data.data && data.data.type === 'friend_request';
  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    vibrate: [250, 100, 250, 100, 250],
    tag: isFriendRequest ? 'naval-friend-request' : 'naval-challenge',
    renotify: true,
    data: data.data || { url: '/' },
    actions: [
      { action: 'accept', title: isFriendRequest ? 'Aceitar Amizade' : 'Aceitar Batalha' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url) 
    ? event.notification.data.url 
    : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Se já houver uma aba aberta com o jogo, foca nela e navega para o link da partida
      for (const client of windowClients) {
        if (client.url && 'focus' in client) {
          if ('navigate' in client) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      // Se não houver janela aberta, abre nova janela com a sala
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
