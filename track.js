// 궤적 기록 · GPX 저장/불러오기 · 지난 산행 목록. index.html에서 setupTrack(map, …)으로 붙임
// index.html이 300줄을 넘어 기능 단위로 분리 (GUIDELINES 3장). 고도 그래프는 profile.js

import { dist, climb, fmtDist } from './profile.js';

export function setupTrack(map, { maplibregl, say, pitch, profile, mountain }) {
  const KEY = 'hiking-3d:track';
  const MAX_ACC = 50; // m. 숲·골짜기에서 튀는 점 제거
  const MIN_STEP = 5; // m. 멈춰 있을 때 같은 자리에 점이 쌓이는 것 방지
  let rec = JSON.parse(localStorage.getItem(KEY) || 'null') || { recording: false, points: [] };
  let watchId = null, wakeLock = null;
  // 지난 산행: localStorage 약 5 MB 한도라 점은 최대 500개로 솎아 [lon, lat]만 (산행 하나 약 20 KB → 200개 남짓)
  const HIKES = 'hiking-3d:hikes', MAX_PTS = 500;
  const hikes = () => JSON.parse(localStorage.getItem(HIKES) || '[]');

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
    profile.hide(); // 기록 상태 표시와 같은 자리라 숨김
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
    if (rec.points.length) { downloadGpx(rec.points); profile.show(rec.points); saveHike(rec.points); }
    else say('기록된 점이 없습니다.');
  }

  async function saveHike(pts) {
    if (pts.length < 2) return;
    const every = Math.ceil(pts.length / MAX_PTS);
    const thin = pts.filter((_, i) => i % every === 0 || i === pts.length - 1);
    const eles = await profile.elevations(thin); // GPS 고도는 튀어서 그래프와 같은 고도 타일로
    const hike = { t: pts[0].t, end: pts.at(-1).t, mountain, km: km(pts), ...(eles ? climb(eles) : {}),
      pts: thin.map((p) => [+p.lon.toFixed(5), +p.lat.toFixed(5)]) };
    try { localStorage.setItem(HIKES, JSON.stringify([hike, ...hikes()])); }
    catch { say('저장 공간이 가득 차 산행 목록에 넣지 못했습니다. 오래된 기록을 지워 주세요 (GPX는 내려받아짐).'); }
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
    showPts(pts);
    say(`불러옴: ${pts.length}개 점, ${km(pts).toFixed(2)} km`);
  }

  function showPts(pts) {
    drawTrack(pts);
    profile.show(pts);
    const b = new maplibregl.LngLatBounds();
    pts.forEach((p) => b.extend([p.lon, p.lat]));
    map.fitBounds(b, { padding: 60, pitch, bearing: map.getBearing() });
  }

  // ── 지난 산행 목록 (📂) ──
  const listEl = document.getElementById('hikes');
  const hours = (ms) => { const m = Math.round(ms / 60e3); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`; };
  function renderList() {
    const hs = hikes();
    listEl.innerHTML = '<div class="ph"><b>지난 산행</b><button type="button" class="x" aria-label="목록 닫기" title="목록 닫기">✕</button></div>'
      + (hs.length ? '' : '<div>아직 없습니다. ●로 기록하고 ■로 멈추면 여기에 쌓입니다.</div>')
      + hs.map((h, i) => {
        const day = new Date(h.t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' });
        const text = `${day} ${h.mountain ?? ''} · ${fmtDist(h.km * 1000)}${h.up != null ? ` · ↑ ${Math.round(h.up)} m` : ''} · ${hours(h.end - h.t)}`;
        return `<div class="row"><button type="button" class="open" data-i="${i}">${text}</button>`
          + `<button type="button" class="del" data-i="${i}" aria-label="${text} 기록 지우기" title="지우기">🗑</button></div>`;
      }).join('')
      + '<button type="button" class="gpx">GPX 파일 불러오기…</button>';
    listEl.querySelector('.x').onclick = () => (listEl.style.display = 'none');
    listEl.querySelector('.gpx').onclick = () => fileIn.click();
    listEl.querySelectorAll('.open').forEach((b) => (b.onclick = () => {
      listEl.style.display = 'none';
      showPts(hikes()[b.dataset.i].pts.map(([lon, lat]) => ({ lon, lat })));
    }));
    listEl.querySelectorAll('.del').forEach((b) => (b.onclick = () => {
      // 지우면 되돌릴 수 없어 한 번 더 확인
      if (!confirm('이 산행 기록을 지울까요? 되돌릴 수 없습니다.')) return;
      const hs2 = hikes(); hs2.splice(b.dataset.i, 1);
      localStorage.setItem(HIKES, JSON.stringify(hs2));
      renderList();
    }));
    listEl.style.display = 'block';
  }

  const statusEl = document.getElementById('status');
  const recBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'txt' });
  const loadBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'txt', textContent: '📂', title: '지난 산행·GPX 불러오기' });
  loadBtn.setAttribute('aria-label', '지난 산행·GPX 불러오기');
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
  loadBtn.onclick = () => (rec.recording ? say('기록 중에는 불러올 수 없습니다.')
    : listEl.style.display === 'block' ? (listEl.style.display = 'none') : renderList());
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
