// 산에서 신호가 약하거나 없어도 열리도록 저장해 두는 서비스 워커.
// - 앱·데이터(같은 출처): 저장본을 바로 보여주고, 페이지를 열 때마다 앱 파일 전체를 한 묶음으로 새로 받아
//   전부 성공해야 한꺼번에 교체 → 배포 후 두 번째 열 때 새 버전
// - MapLibre(버전 고정 CDN): 바뀔 일이 없어 저장본 우선
// - 지도·고도 타일, 글꼴: 한 번 본 것만 저장. OSM 정책상 미리 대량으로 받지 않음.
//   OSM 응답 헤더가 stale-while-revalidate·stale-if-error 7일을 허용하므로 그 방식을 따름
const APP = 'hiking-3d-app-v8'; // 앱 파일 구성·갱신 방식이 바뀌면 숫자를 올림 (v8: fly.js 추가)
const TILES = 'hiking-3d-tiles'; // 앱 버전이 바뀌어도 이미 본 타일은 유지
const ML = 'https://unpkg.com/maplibre-gl@6.19.0/dist/';
const CORE = ['./', 'track.js', 'route.js', 'profile.js', 'sun.js', 'fly.js', 'mountains.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const DATA = ['trails.geojson', 'contours.geojson', 'pois.geojson']; // data/<산>/ 아래. 산 하나에 약 0.7~1 MB
const PRECACHE = [...CORE, ...DATA.map((f) => `data/seunghak/${f}`),
  ML + 'maplibre-gl.css', ML + 'maplibre-gl.mjs', ML + 'maplibre-gl-worker.mjs',
  'https://demotiles.maplibre.org/font/Open%20Sans%20Semibold/0-255.pbf'];
const TILE_HOSTS = ['tile.openstreetmap.org', 's3.amazonaws.com', 'demotiles.maplibre.org'];
const TILE_FRESH = 3 * 3600e3; // OSM max-age(약 3시간)가 지나면 뒤에서 새로 받음
const MAX_TILES = 3000; // 타일 1개 20~110 KB → 최대 수십~100여 MB. 넘으면 오래 저장된 것부터 지움

self.addEventListener('install', (e) => e.waitUntil(
  // cache: 'reload' — GitHub Pages의 10분 HTTP 캐시에 남은 이전 파일을 저장하지 않도록
  caches.open(APP).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())));

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
  // ?v=6 같은 캐시 우회용 쿼리와 index.html은 묶음의 같은 파일로 취급
  const key = (url.origin + url.pathname).replace(/index\.html$/, '');
  if (e.request.mode === 'navigate') e.waitUntil(refreshApp(url));
  const cached = await cache.match(key);
  if (cached) return cached;
  const res = await fetch(e.request);
  if (res.ok) cache.put(key, res.clone());
  return res;
}

// 파일마다 따로 갱신하면 갱신 도중 '새 index.html + 이전 track.js'처럼 버전이 섞여 기능이 빠지거나
// 깨진다 (2026-11-26 배포본에서 실제로 발생). 전부 받아졌을 때만 한꺼번에 교체한다
// 산 데이터는 한 번이라도 연 산(저장본이 있는 산)과 지금 여는 산(?m=)만 → 안 가는 산까지 받지 않음
async function refreshApp(url) {
  try {
    const cache = await caches.open(APP);
    const ids = new Set((await cache.keys()).map((r) => new URL(r.url).pathname.match(/\/data\/([^/]+)\//)?.[1]).filter(Boolean));
    if (url.searchParams.get('m')) ids.add(url.searchParams.get('m'));
    // 목록에서 빠진 산·잘못된 ?m=이 섞이면 404로 묶음 전체가 영영 갱신되지 않으므로 지금 목록에 있는 산만
    const known = new Set((await (await fetch('mountains.json', { cache: 'no-cache' })).json()).map((m) => m.id));
    const files = [...CORE, ...[...ids].filter((id) => known.has(id)).flatMap((id) => DATA.map((f) => `data/${id}/${f}`))]; // 항상 같은 버전끼리 써야 하는 묶음
    const res = await Promise.all(files.map((f) => fetch(f, { cache: 'no-cache' }))); // 서버에 변경 여부 확인
    if (!res.every((r) => r.ok)) return;
    const bodies = await Promise.all(res.map((r) => r.blob()));
    await Promise.all(files.map((f, i) =>
      cache.put(new URL(f, self.registration.scope).href, new Response(bodies[i], { headers: res[i].headers }))));
  } catch { /* 오프라인·일부 실패: 지금 묶음을 그대로 씀 */ }
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
