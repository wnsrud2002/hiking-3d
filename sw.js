// 산에서 신호가 약하거나 없어도 열리도록 저장해 두는 서비스 워커.
// - 앱·데이터(같은 출처): 저장본을 바로 보여주고 뒤에서 새로 받음 → 배포 후 두 번째 열 때 새 버전
// - MapLibre(버전 고정 CDN): 바뀔 일이 없어 저장본 우선
// - 지도·고도 타일, 글꼴: 한 번 본 것만 저장. OSM 정책상 미리 대량으로 받지 않음.
//   OSM 응답 헤더가 stale-while-revalidate·stale-if-error 7일을 허용하므로 그 방식을 따름
const APP = 'hiking-3d-app-v1';
const TILES = 'hiking-3d-tiles'; // 앱 버전이 바뀌어도 이미 본 타일은 유지
const ML = 'https://unpkg.com/maplibre-gl@6.19.0/dist/';
const PRECACHE = ['./', 'trails.geojson', 'contours.geojson',
  ML + 'maplibre-gl.css', ML + 'maplibre-gl.mjs', ML + 'maplibre-gl-worker.mjs',
  'https://demotiles.maplibre.org/font/Open%20Sans%20Semibold/0-255.pbf'];
const TILE_HOSTS = ['tile.openstreetmap.org', 's3.amazonaws.com', 'demotiles.maplibre.org'];
const TILE_FRESH = 3 * 3600e3; // OSM max-age(약 3시간)가 지나면 뒤에서 새로 받음
const MAX_TILES = 3000; // 타일 1개 20~110 KB → 최대 수십~100여 MB. 넘으면 오래 저장된 것부터 지움

self.addEventListener('install', (e) => e.waitUntil(
  caches.open(APP).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())));

self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) e.respondWith(app(e, url));
  else if (url.href.startsWith(ML)) e.respondWith(cacheFirst(e.request));
  else if (TILE_HOSTS.includes(url.hostname)) e.respondWith(tile(e));
});

async function app(e, url) {
  const cache = await caches.open(APP);
  const key = url.origin + url.pathname; // ?v=6 같은 캐시 우회용 쿼리는 같은 파일로 취급
  const cached = await cache.match(key);
  const update = fetch(e.request).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  if (cached) {
    e.waitUntil(update.catch(() => {})); // 오프라인이면 갱신만 조용히 실패
    return cached;
  }
  return update;
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) (await caches.open(APP)).put(req, res.clone());
  return res;
}

let puts = 0;
async function saveTile(cache, req, res) {
  // 교차 출처 응답은 Date 헤더를 읽을 수 없어 저장 시각을 직접 붙임
  const headers = new Headers(res.headers);
  headers.set('x-saved', Date.now());
  await cache.put(req, new Response(await res.arrayBuffer(), { status: res.status, headers }));
  if (++puts % 100 === 0) { // 매번 전체 목록을 읽으면 느려서 100번에 한 번 정리
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map((k) => cache.delete(k)));
  }
}

async function tile(e) {
  const cache = await caches.open(TILES);
  const cached = await cache.match(e.request);
  const refresh = () => fetch(e.request).then(async (res) => {
    if (res.ok) await saveTile(cache, e.request, res.clone());
    return res;
  });
  if (!cached) return refresh();
  if (Date.now() - Number(cached.headers.get('x-saved')) > TILE_FRESH) e.waitUntil(refresh().catch(() => {}));
  return cached;
}
