const CACHE = 'web-absen-v1';
const OFFLINE_URL = '/absen';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([OFFLINE_URL])).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
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

  const title = data.title || 'Web Absen';
  const body  = data.body  || 'Ada pengingat absen untuk Anda.';
  const url   = data.url   || '/absen';
  const icon  = '/icon-192.png';
  const badge = '/icon-192.png';
  const tag   = data.type  || 'absen-reminder';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      renotify: false,
      requireInteraction: false,
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
        if (client.url.includes('/absen') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
