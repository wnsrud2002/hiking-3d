// 현장 점검 모드 (?check=1로 켜고 ?check=0으로 끔): 산에서 위치·나침반·등산로 거리·알림을 1행씩 기록해 CSV로 내려받음.
// 집에서 이 파일을 보고 GPS 필터(50 m·5 m)·이탈 기준(30 m)·나침반 보정을 조정하려는 것
import { dist } from './profile.js';

const KEY = 'hiking-3d:check', ROWS = 'hiking-3d:check-rows';
const MAX_ROWS = 10000; // 1초에 1행이면 약 3시간. localStorage 한도(약 5 MB) 안
const COLS = 'time,lat,lon,accuracy_m,gps_alt_m,dem_alt_m,speed_ms,gps_heading,compass_heading,heading_diff,trail_dist_m,online,visible,recording,event';

// p에서 가장 가까운 등산로 선분까지 거리(m). 좁은 범위라 평면 근사
export function trailDistance(lines, p) {
  const mx = 111320 * Math.cos(p.lat * Math.PI / 180), my = 111320;
  let best = Infinity;
  for (const cs of lines) {
    for (let i = 1; i < cs.length; i++) {
      const ax = (cs[i - 1][0] - p.lon) * mx, ay = (cs[i - 1][1] - p.lat) * my;
      const dx = (cs[i][0] - cs[i - 1][0]) * mx, dy = (cs[i][1] - cs[i - 1][1]) * my;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

// 두 방위의 차이(-180~180). 359°와 1°는 2°
export const headingDiff = (a, b) => ((a - b + 540) % 360) - 180;

export function setupCheck(map, { profile, trails }) {
  const q = new URLSearchParams(location.search).get('check');
  if (q != null) localStorage.setItem(KEY, q === '1' ? '1' : '0'); // 홈 화면 앱은 주소에 ?check가 없어 켠 상태를 기억
  if (localStorage.getItem(KEY) !== '1') return;

  const rows = JSON.parse(localStorage.getItem(ROWS) || '[]');
  let lines = null, compass = null, on = false, watch = null;
  const cell = (v, d = 1) => (v == null || Number.isNaN(v) ? '' : typeof v === 'number' ? v.toFixed(d) : `"${String(v).replace(/"/g, '""')}"`);
  const add = (cells) => {
    rows.push(cells.join(','));
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
    try { localStorage.setItem(ROWS, JSON.stringify(rows)); } catch { /* 가득 참: 화면 숫자로 알 수 있음 */ }
    render();
  };
  const recording = () => !!JSON.parse(localStorage.getItem('hiking-3d:track') || 'null')?.recording;
  const base = () => [new Date().toISOString()];

  // index.html의 화살표와 같은 식 (iOS: 북 기준 시계방향 / 안드로이드: 반시계 alpha)
  const onCompass = (e) => {
    const raw = e.webkitCompassHeading ?? (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute') ? 360 - e.alpha : null);
    if (raw != null && !Number.isNaN(raw)) compass = (raw + (screen.orientation?.angle ?? 0)) % 360;
  };
  addEventListener('ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation', onCompass);

  async function onPos(pos) {
    const c = pos.coords, p = { lon: c.longitude, lat: c.latitude };
    lines ??= (await (await fetch(trails)).json()).features.map((f) => f.geometry.coordinates);
    const [dem] = (await profile.elevations([p])) ?? [null];
    const gh = c.heading != null && !Number.isNaN(c.heading) && c.speed > 0.5 ? c.heading : null; // 멈춰 있으면 GPS 방향은 의미 없음
    add([...base(), cell(p.lat, 6), cell(p.lon, 6), cell(c.accuracy), cell(c.altitude), cell(dem), cell(c.speed, 2), cell(gh, 0),
      cell(compass, 0), cell(gh != null && compass != null ? headingDiff(compass, gh) : null, 0), cell(trailDistance(lines, p)),
      navigator.onLine ? 1 : 0, document.visibilityState === 'visible' ? 1 : 0, recording() ? 1 : 0, '']);
  }

  // 이탈·도착·일몰 등 앱이 띄운 안내 문구를 같은 표에 끼워 넣음 (각 기능 코드를 고치지 않고)
  const notice = document.getElementById('notice');
  new MutationObserver(() => on && notice.textContent
    && add([...base(), ...Array(13).fill(''), cell(notice.textContent)])).observe(notice, { childList: true, characterData: true, subtree: true });
  document.addEventListener('visibilitychange', () => on && add([...base(), ...Array(13).fill(''), cell(`화면 ${document.visibilityState}`)]));

  const el = document.getElementById('check');
  function render() {
    const fixes = rows.filter((r) => r.split(',')[3]);
    const acc = fixes.map((r) => +r.split(',')[3]).sort((a, b) => a - b);
    el.innerHTML = `<div class="ph"><b>현장 점검 ${on ? '● 기록 중' : '멈춤'}</b></div>`
      + `<div>${rows.length}행 · 위치 ${fixes.length}개${acc.length ? ` · GPS 오차 중앙값 ${acc[acc.length >> 1].toFixed(0)} m` : ''}</div>`
      + `<div class="btns"><button type="button" class="go">${on ? '멈춤' : '시작'}</button>`
      + '<button type="button" class="csv">CSV 내려받기</button><button type="button" class="clr">지우기</button></div>';
    el.querySelector('.go').onclick = toggle;
    el.querySelector('.csv').onclick = download;
    el.querySelector('.clr').onclick = () => {
      if (!confirm(`점검 기록 ${rows.length}행을 지울까요? 되돌릴 수 없습니다.`)) return;
      rows.length = 0; localStorage.removeItem(ROWS); render();
    };
    el.style.display = 'block';
  }
  function toggle() {
    on = !on;
    if (on) {
      // 위치 버튼과 따로 원본 위치를 받음: 기록 기능의 50 m·5 m 필터에 걸러진 점까지 남기려고
      watch = navigator.geolocation?.watchPosition(onPos, (e) => add([...base(), ...Array(13).fill(''), cell(`위치 오류 ${e.code}: ${e.message}`)]),
        { enableHighAccuracy: true });
      add([...base(), ...Array(13).fill(''), cell(`점검 시작 · ${navigator.userAgent}`)]);
    } else {
      navigator.geolocation?.clearWatch(watch);
      add([...base(), ...Array(13).fill(''), cell('점검 멈춤')]);
    }
  }
  function download() {
    const a = document.createElement('a');
    // 엑셀에서 한글이 깨지지 않게 BOM을 붙임
    a.href = URL.createObjectURL(new Blob(['﻿' + [COLS, ...rows].join('\n')], { type: 'text/csv' }));
    a.download = `hiking-check-${new Date().toLocaleString('sv-SE').replace(/\D/g, '').slice(0, 12)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  render();
  return { onPos }; // 검사용
}
