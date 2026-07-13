const CACHE = 'egs-attendance-v3';

// Static assets hanya — JANGAN precache halaman yang butuh auth
const PRECACHE = [
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
      .then(c => c.addAll(PRECACHE).catch(err => {
        console.warn('[SW] precache partial failure (non-fatal):', err);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Hanya serve static assets dari cache; jangan intercept halaman auth
  const url = new URL(e.request.url);
  if (
    e.request.method === 'GET' &&
    PRECACHE.some(p => url.pathname === p)
  ) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request))
    );
  }
});

// ── Push Notification ─────────────────────────────────────────────────────────

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch {}

  const notification = data.notification || {};
  const title = data.title || notification.title || 'EGS Attendance';
  const body  = data.body  || notification.body  || 'Ada pengingat absen untuk Anda.';
  const url   = data.url   || data.click_action || data.link || '/absen';
  const tag   = data.type  || data.tag || 'absen-reminder';
  const icon  = data.icon  || notification.icon || '/icon-192.png';
  const badge = data.badge || '/notification-icon.png';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
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
