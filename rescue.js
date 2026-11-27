// 구조 요청용 위치 공유: 좌표·국가지점번호·고도·가까운 이정표를 폰 공유 창(문자·메신저)으로. 자동 전송은 하지 않음
import { dist } from './profile.js';

// 경위도 → UTM-K(EPSG:5179, GRS80 횡메르카토르) [E, N] m. 국가지점번호가 이 좌표계 기준.
// 식: Snyder 'Map Projections – A Working Manual' (1987) 8-9~8-10
export function utmk(lon, lat) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, lon0 = 127.5, lat0 = 38, FE = 1000000, FN = 2000000;
  const r = Math.PI / 180, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const M = (p) => a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * p
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * p)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * p) - (35 * e2 ** 3 / 3072) * Math.sin(6 * p));
  const p = lat * r, N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2), T = Math.tan(p) ** 2, C = ep2 * Math.cos(p) ** 2;
  const A = (lon - lon0) * r * Math.cos(p);
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120);
  const y = k0 * (M(p) - M(lat0 * r) + N * Math.tan(p) * (A ** 2 / 2 + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
    + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720));
  return [FE + x, FN + y];
}

// 국가지점번호 '마라 3736 8107': 100 km 칸 글자(가로·세로, 가=E 700 km·N 1300 km부터) + 칸 안 10 m 단위 4자리씩
const LETTERS = '가나다라마바사아자차카타파하';
export function pointNumber(lon, lat) {
  const [E, N] = utmk(lon, lat);
  const ex = Math.floor((E - 700000) / 100000), ny = Math.floor((N - 1300000) / 100000);
  if (!LETTERS[ex] || !LETTERS[ny]) return null; // 한국 밖
  const four = (v) => String(Math.floor((v % 100000) / 10)).padStart(4, '0');
  return `${LETTERS[ex]}${LETTERS[ny]} ${four(E)} ${four(N)}`;
}

// 도·분·초 (119 상황실이 쓰는 형식 중 하나)
const dms = (v) => { const d = Math.floor(v), m = Math.floor((v - d) * 60), s = ((v - d) * 60 - m) * 60; return `${d}°${m}′${s.toFixed(1)}″`; };

export function setupRescue(map, { say, profile, geo, M, pois }) {
  let here = null;
  geo?.on('geolocate', (pos) => { here = { lon: pos.coords.longitude, lat: pos.coords.latitude, acc: pos.coords.accuracy, t: Date.now() }; });
  const el = document.getElementById('rescue');

  async function show() {
    // 버튼을 누른 순간의 위치를 새로 받음 (위치 버튼이 꺼져 있어도). 10초 안에 못 받으면 마지막 위치
    const p = await new Promise((ok) => navigator.geolocation
      ? navigator.geolocation.getCurrentPosition((pos) => ok({ lon: pos.coords.longitude, lat: pos.coords.latitude, acc: pos.coords.accuracy, t: Date.now() }),
        () => ok(here), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 })
      : ok(here));
    if (!p) return say('위치를 받지 못했습니다. 위치 권한을 켜거나 하늘이 트인 곳으로 이동해 다시 누르세요.');
    const [ele] = (await profile.elevations([p])) ?? [null];
    const marks = (await (await fetch(pois)).json()).features
      .filter((f) => f.properties.name && ['peak', 'guide', 'shelter', 'view', 'water'].includes(f.properties.kind))
      .map((f) => ({ name: f.properties.name, d: dist(p, { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }) }))
      .sort((a, b) => a.d - b.d);
    const near = !marks[0] || marks[0].d >= 2000 ? '' : marks[0].d < 20 ? `${marks[0].name} 바로 옆` : `${marks[0].name}에서 약 ${Math.round(marks[0].d / 10) * 10} m`;
    const pn = pointNumber(p.lon, p.lat);
    const age = Math.round((Date.now() - p.t) / 60e3);
    const text = [`[등산 중 구조 요청 위치] ${M.name}`,
      pn && `국가지점번호: ${pn}`,
      `위도 ${p.lat.toFixed(5)}, 경도 ${p.lon.toFixed(5)} (${dms(p.lat)} N, ${dms(p.lon)} E)`,
      `오차 약 ${Math.round(p.acc ?? 0)} m${ele != null ? ` · 고도 약 ${Math.round(ele)} m` : ''}${near ? ` · ${near}` : ''}`,
      `${new Date(p.t).toLocaleString('ko-KR', { hour12: false })}${age >= 1 ? ` (${age}분 전 위치)` : ''}`,
      `지도: https://www.openstreetmap.org/?mlat=${p.lat.toFixed(5)}&mlon=${p.lon.toFixed(5)}#map=17/${p.lat.toFixed(5)}/${p.lon.toFixed(5)}`,
    ].filter(Boolean).join('\n');
    // 화면에는 119 전화로 불러줄 내용을 크게. textContent로만 넣음 (OSM 이름이 섞이므로)
    el.innerHTML = '<div class="ph"><b>구조 요청 위치</b><button type="button" class="x" aria-label="닫기" title="닫기">✕</button></div>'
      + '<div class="say">119에 이렇게 말하세요 (근처 기둥형 표지판에 번호가 보이면 그 번호가 더 정확합니다)</div><div class="big"></div><pre></pre>'
      + '<div class="btns"><button type="button" class="share">공유(문자·메신저)</button><button type="button" class="copy">복사</button>'
      + '<a class="call" href="tel:119">119 전화</a></div>';
    el.querySelector('.big').textContent = `${M.name}${pn ? `, 국가지점번호 ${pn}` : ''}${near ? `, ${near}` : ''}`;
    el.querySelector('pre').textContent = text;
    el.querySelector('.x').onclick = () => (el.style.display = 'none');
    el.querySelector('.copy').onclick = async () => {
      try { await navigator.clipboard.writeText(text); say('복사했습니다. 문자나 메신저에 붙여 넣으세요.'); } catch { say('복사하지 못했습니다. 아래 글을 길게 눌러 복사하세요.'); }
    };
    el.querySelector('.share').onclick = async () => {
      if (!navigator.share) return el.querySelector('.copy').click(); // 공유 창이 없는 브라우저(데스크톱 등)는 복사로
      try { await navigator.share({ title: '구조 요청 위치', text }); } catch { /* 사용자가 취소 */ }
    };
    el.style.display = 'block';
  }

  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'txt', textContent: '📍', title: '구조 요청용 내 위치' });
  btn.setAttribute('aria-label', '구조 요청용 내 위치 (국가지점번호·좌표 공유)');
  btn.onclick = () => (el.style.display === 'block' ? (el.style.display = 'none') : show());
  map.addControl({
    onAdd() {
      const div = Object.assign(document.createElement('div'), { className: 'maplibregl-ctrl maplibregl-ctrl-group' });
      div.append(btn);
      return div;
    },
    onRemove() {},
  });
}
