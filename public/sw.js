// Minimal service worker — PWA 설치 지원용
const CACHE = 'whispering-v1';

self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Network-first: 항상 최신 콘텐츠 우선, 오프라인 시 캐시 폴백
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // WebSocket은 서비스워커 처리 제외
  if (e.request.url.startsWith('ws')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
