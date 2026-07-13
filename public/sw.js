const CACHE = 'egs-attendance-v2';
const OFFLINE_URL = '/absen';
const PRECACHE = [
  OFFLINE_URL,
  '/manifest.json',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/notification-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE).catch(err => console.warn('[SW] precache partial failure:', err)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(OFFLINE_URL))
    );
  }
});

// ── Push Notification ─────────────────────────────────────────────────────────

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch {}

  const title = data.title || 'EGS Attendance';
  const body  = data.body  || 'Ada pengingat absen untuk Anda.';
  const url   = data.url   || '/absen';
  const tag   = data.type  || 'absen-reminder';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/icon-192.png',
      badge: '/notification-icon.png',
      tag,
      renotify: false,
      requireInteraction: false,
      vibrate: [200, 100, 200],
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/absen';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('/absen') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
