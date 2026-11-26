// 궤적 기록 · GPX 저장/불러오기 · 고도 프로필. index.html에서 setupTrack(map, …)으로 붙임
// index.html이 300줄을 넘어 기능 단위로 분리 (GUIDELINES 3장)

// 누적 오르막/내리막(m). 기준점에서 step 이상 바뀔 때만 셈 → 작은 오르내림 떨림이 쌓여 부풀려지는 것 방지
export function climb(eles, step = 3) {
  let up = 0, down = 0, ref = eles[0];
  for (const e of eles) {
    if (e - ref >= step) { up += e - ref; ref = e; }
    else if (ref - e >= step) { down += ref - e; ref = e; }
  }
  const rest = eles.at(-1) - ref; // 마지막 기준점 이후 step 미만으로 남은 변화도 반영 (안 하면 끝부분이 빠짐)
  return { up: up + Math.max(rest, 0), down: down + Math.max(-rest, 0) };
}

export function setupTrack(map, { maplibregl, say, pitch, demUrl }) {
  const KEY = 'hiking-3d:track';
  const MAX_ACC = 50; // m. 숲·골짜기에서 튀는 점 제거
  const MIN_STEP = 5; // m. 멈춰 있을 때 같은 자리에 점이 쌓이는 것 방지
  let rec = JSON.parse(localStorage.getItem(KEY) || 'null') || { recording: false, points: [] };
  let watchId = null, wakeLock = null;

  function dist(a, b) { // 하버사인, m
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  const km = (pts) => pts.reduce((d, p, i) => (i ? d + dist(pts[i - 1], p) : 0), 0) / 1000;
  const drawTrack = (pts) => map.getSource('track').setData({
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) } });

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(rec)); }
    catch { say('저장 공간이 가득 차 기록을 저장하지 못했습니다. 기록을 멈추고 GPX로 내려받으세요.'); }
  }

  function onPos(pos) {
    const { latitude: lat, longitude: lon, altitude: ele, accuracy } = pos.coords;
    if (accuracy > MAX_ACC) return;
    const p = { lat, lon, ele, t: pos.timestamp };
    const last = rec.points.at(-1);
    if (last && dist(last, p) < MIN_STEP) return;
    rec.points.push(p);
    save(); drawTrack(rec.points); updateStatus();
  }

  // 웹페이지는 화면이 꺼지면 GPS를 못 받으므로, 기록 중엔 화면을 켜 둠
  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 미지원·저전력 모드 */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (rec.recording && document.visibilityState === 'visible') keepAwake(); // 탭 전환 시 자동 해제되므로 다시 요청
  });

  function start(resume) {
    if (!navigator.geolocation) return say('이 브라우저는 위치 기능이 없어 기록할 수 없습니다.');
    if (!resume) rec = { recording: true, points: [] };
    rec.recording = true; save(); drawTrack(rec.points);
    document.getElementById('profile').style.display = 'none'; // 기록 상태 표시와 같은 자리라 숨김
    watchId = navigator.geolocation.watchPosition(onPos, (e) => {
      say(`위치를 받지 못했습니다: ${e.message}`);
      if (e.code === 1) stop();
    }, { enableHighAccuracy: true });
    keepAwake(); updateStatus();
  }

  function stop() {
    navigator.geolocation.clearWatch(watchId); watchId = null;
    wakeLock?.release(); wakeLock = null;
    rec.recording = false; save(); updateStatus();
    if (rec.points.length) { downloadGpx(rec.points); showProfile(rec.points); }
    else say('기록된 점이 없습니다.');
  }

  function toGpx(pts) {
    const trkpts = pts.map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">`
      + (p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '')
      + `<time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
  <gpx version="1.1" creator="hiking-3d" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>hiking-3d ${new Date(pts[0].t).toISOString()}</name><trkseg>
  ${trkpts}
  </trkseg></trk>
  </gpx>
  `;
  }

  function downloadGpx(pts) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toGpx(pts)], { type: 'application/gpx+xml' }));
    a.download = `hiking-${new Date(pts[0].t).toLocaleString('sv-SE').replace(/\D/g, '').slice(0, 12)}.gpx`; // 현지 시각 YYYYMMDDhhmm
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say(`GPX 저장: ${pts.length}개 점, ${km(pts).toFixed(2)} km`);
  }

  function loadGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const pts = [...doc.getElementsByTagName('trkpt')].map((e) => ({ lat: +e.getAttribute('lat'), lon: +e.getAttribute('lon') }));
    if (!pts.length || pts.some((p) => isNaN(p.lat) || isNaN(p.lon))) return say('GPX에서 경로(trkpt)를 찾지 못했습니다.');
    drawTrack(pts);
    showProfile(pts);
    const b = new maplibregl.LngLatBounds();
    pts.forEach((p) => b.extend([p.lon, p.lat]));
    map.fitBounds(b, { padding: 60, pitch, bearing: map.getBearing() });
    say(`불러옴: ${pts.length}개 점, ${km(pts).toFixed(2)} km`);
  }

  // ── 고도 프로필 ──
  // 폰 GPS 고도는 ±10~20 m씩 튀어서, 지도와 같은 고도 타일(z14, 약 7.8 m/px)에서 높이를 읽음.
  // 타일은 sw.js가 저장하므로 본 적 있는 지역이면 오프라인에서도 그려짐
  const Z = 14, tiles = new Map();
  function demTile(x, y) {
    const k = `${x}/${y}`;
    if (!tiles.has(k)) tiles.set(k, (async () => {
      const res = await fetch(demUrl.replace('{z}', Z).replace('{x}', x).replace('{y}', y));
      if (!res.ok) throw new Error(res.status);
      // 색 보정이 들어가면 RGB에 담긴 고도 값이 바뀌므로 끔
      const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const ctx = Object.assign(document.createElement('canvas'), { width: 256, height: 256 }).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, 256, 256).data;
    })());
    return tiles.get(k);
  }
  async function elevation(p) {
    const n = 2 ** Z, fx = (p.lon + 180) / 360 * n;
    const fy = (1 - Math.asinh(Math.tan(p.lat * Math.PI / 180)) / Math.PI) / 2 * n;
    const d = await demTile(Math.floor(fx), Math.floor(fy));
    const i = (Math.floor((fy % 1) * 256) * 256 + Math.floor((fx % 1) * 256)) * 4;
    const v = d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; // Terrarium 인코딩
    return v < -100 ? null : v; // 고도 타일의 -1000 m대 결측 픽셀
  }

  const profEl = document.getElementById('profile');
  async function showProfile(pts) {
    if (pts.length < 2) return;
    let eles;
    try { eles = await Promise.all(pts.map(elevation)); }
    catch { return say('고도 타일을 받지 못해 고도 프로필을 그릴 수 없습니다.'); }
    let prev = null;
    eles = eles.map((e) => (prev = e ?? prev ?? 0)); // 결측은 앞 값으로 채움
    const dists = pts.map((p, i) => (i ? dist(pts[i - 1], p) : 0));
    for (let i = 1; i < dists.length; i++) dists[i] += dists[i - 1];
    const total = dists.at(-1) || 1, lo = Math.min(...eles), hi = Math.max(...eles), span = Math.max(hi - lo, 20);
    const every = Math.ceil(pts.length / 400); // 그래프 폭(400)보다 촘촘한 점은 안 보이므로 솎음
    const xy = eles.map((_, i) => i).filter((i) => i % every === 0 || i === eles.length - 1)
      .map((i) => `${(dists[i] / total * 400).toFixed(1)},${(95 - (eles[i] - lo) / span * 85).toFixed(1)}`);
    const { up, down } = climb(eles);
    const summary = `${(total / 1000).toFixed(2)} km · ↑ ${Math.round(up)} m · ↓ ${Math.round(down)} m · 최고 ${Math.round(hi)} m`;
    profEl.innerHTML = `<div class="ph"><span>${summary}</span><button type="button" aria-label="고도 프로필 닫기">✕</button></div>`
      + `<svg viewBox="0 0 400 100" preserveAspectRatio="none" aria-hidden="true">`
      + `<polygon points="0,100 ${xy.join(' ')} 400,100" fill="rgba(214,36,159,.18)"/>`
      + `<polyline points="${xy.join(' ')}" fill="none" stroke="#d6249f" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
    profEl.setAttribute('aria-label', `고도 프로필: ${summary}, 최저 ${Math.round(lo)} m`);
    profEl.querySelector('button').onclick = () => (profEl.style.display = 'none');
    profEl.style.display = 'block';
  }

  const statusEl = document.getElementById('status');
  const recBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'txt' });
  const loadBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'txt', textContent: '📂', title: 'GPX 불러오기' });
  loadBtn.setAttribute('aria-label', 'GPX 불러오기');
  // accept=".gpx"를 주면 iOS가 GPX 파일을 회색으로 막는 경우가 있어 비워 두고 내용으로 검사
  const fileIn = Object.assign(document.createElement('input'), { type: 'file', hidden: true });

  function updateStatus() {
    const label = rec.recording ? '기록 중지하고 GPX 저장' : '궤적 기록 시작';
    Object.assign(recBtn, { textContent: rec.recording ? '■' : '●', title: label });
    recBtn.setAttribute('aria-label', label);
    recBtn.classList.toggle('on', rec.recording);
    statusEl.style.display = rec.recording ? 'block' : 'none';
    statusEl.textContent = `● 기록 중 · ${km(rec.points).toFixed(2)} km · ${rec.points.length}점`;
  }

  recBtn.onclick = () => (rec.recording ? stop() : start(false));
  loadBtn.onclick = () => (rec.recording ? say('기록 중에는 불러올 수 없습니다.') : fileIn.click());
  fileIn.onchange = async () => { if (fileIn.files[0]) loadGpx(await fileIn.files[0].text()); fileIn.value = ''; };
  document.body.append(fileIn);
  map.addControl({
    onAdd() {
      const div = Object.assign(document.createElement('div'), { className: 'maplibregl-ctrl maplibregl-ctrl-group' });
      div.append(recBtn, loadBtn);
      return div;
    },
    onRemove() {},
  });
  updateStatus();

  map.on('load', () => {
    drawTrack(rec.points);
    if (rec.recording) { start(true); say('이전 기록을 이어서 기록합니다.'); } // 탭이 꺼졌다 다시 열린 경우
  });
}
