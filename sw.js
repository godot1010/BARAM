// BARAM 서비스워커 - 최소한의 오프라인 지원 (PWA 요구사항 충족용)
//
// v1에는 index.html(앱 본체)까지 "캐시 우선"으로 서빙하는 문제가 있었다.
// sw.js 파일 자체가 안 바뀌면 브라우저가 새 서비스워커 설치 자체를 시도하지 않기
// 때문에, index.html을 아무리 새로 배포해도 이미 방문한 기기에서는 예전 캐시본이
// 계속 보이는 버그가 있었다 (앱 재설치로도 안 고쳐짐 - 저장공간을 공유하기 때문).
// v2부터는: 문서(HTML)는 항상 "네트워크 우선"으로 최신 버전을 먼저 시도하고,
// 오프라인일 때만 캐시로 대체한다. 아이콘/매니페스트 같은 정적 자산만 캐시 우선을 유지.
const CACHE_NAME = "baram-cache-v2";
const CORE_ASSETS = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/")) return; // TourAPI 호출은 캐싱하지 않고 항상 네트워크로

  // 문서(HTML) 요청은 항상 네트워크를 먼저 시도한다 - 새로 배포한 index.html이
  // 곧바로 반영되도록. 오프라인이라 네트워크가 실패할 때만 캐시로 대체한다.
  const isDocument = event.request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html";
  if (isDocument) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 그 외 정적 파일(아이콘, 매니페스트 등)은 기존처럼 캐시 우선 - 오프라인에서도 잘 뜨도록
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});
