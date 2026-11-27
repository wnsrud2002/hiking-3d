// 등산로 선택: 평소엔 조각 탭 → 강조·고도 그래프, 경로 모드(⇢)에선 출발·도착 탭 → 등산로를 따라 최단 경로
import { fmtDist } from './profile.js';
import { sunset } from './sun.js';
import { flyAlong } from './fly.js';
import { buildGraph, nearestNode, snapPair, shortestPath, toblerCumulative, toblerEdge, progress, cumulative, resample } from './graph.js';

const SNAP = 100; // m. 누른 곳에서 이보다 먼 등산로에는 붙이지 않음
const OFF = 30; // m. 경로에서 이만큼(GPS 오차가 더 크면 그만큼) 벗어나면 알림
const ARRIVE = 20; // m. 남은 거리가 이보다 짧으면 도착

const KIND = { peak: '봉우리', view: '전망대', water: '약수터', shelter: '쉼터', toilets: '화장실', guide: '이정표', trailhead: '들머리(차도와 만나는 곳)' };

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간 ${Math.round(m % 60)}분` : `${Math.round(m)}분`);
const clock = (d) => d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

export function setupRoute(map, { maplibregl, say, profile, geo, trails, pois }) {
  let lines = null, graph = null;
  const load = async () => {
    if (!lines) lines = (await (await fetch(trails)).json()).features.map((f) => f.geometry.coordinates);
    if (!graph) graph = buildGraph(lines);
  };
  const line = (coords) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  const empty = { type: 'FeatureCollection', features: [] };
  const clearPick = () => map.getSource('pick').setData(empty);
  // 찾은 경로는 따라 걷는 중에 지도를 잘못 눌러도 지워지지 않게, 경로 찾기(⇢)나 안내 창 ✕로만 지움
  const clearRoute = () => {
    map.getSource('route').setData(empty); markers.forEach((m) => m.remove()); markers = [];
    stopFly?.(); follow = null; followEl.style.display = 'none';
  };
  let markers = [], mode = false, start = null, follow = null, here = null, stopFly = null;

  // ── 경로 따라가기: 위치가 들어올 때마다 남은 거리·시간, 이탈 알림 ──
  const followEl = document.getElementById('follow');
  function renderFollow() {
    if (!follow || !followEl) return;
    const { fine, cum, mins, state } = follow;
    let left = cum.at(-1), leftMin = mins?.at(-1), warn = [];
    if (state) {
      left -= state.along;
      const k = state.i; // 투영점이 든 구간 [k-1, k]의 비율로 남은 시간도 나눔
      const t = (state.along - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
      if (mins) leftMin = mins.at(-1) - (mins[k - 1] + t * (mins[k] - mins[k - 1]));
      if (state.off) warn.push(`경로에서 ${Math.round(state.offBy)} m 벗어남`);
    }
    let text = state?.arrived ? '도착' : `${state ? '남은' : '경로'} ${fmtDist(left)}`;
    if (mins && !state?.arrived) {
      // 일몰은 도착점 기준. 휴식을 뺀 보행 시간이라 실제 도착은 이보다 늦음
      const eta = Date.now() + leftMin * 60e3, end = fine.at(-1), set = sunset(new Date(Date.now()), end.lat, end.lon);
      text += ` · 약 ${fmtMin(leftMin)} · 도착 ${clock(new Date(eta))}${set ? ` · 일몰 ${clock(set)}` : ''}`;
      const late = set && eta > set.getTime();
      if (late) warn.push('일몰 뒤 도착 예상: 랜턴을 챙기거나 \'하산\' 버튼으로 가장 빠른 하산길을 찾으세요');
      if (late && !follow.late) { navigator.vibrate?.([200, 100, 200]); say('일몰 전에 도착하기 어렵습니다.'); }
      follow.late = late;
    }
    if (!state) text += ' · 위치 버튼(◎)을 켜면 남은 거리 안내';
    followEl.innerHTML = `<div class="ph"><span>${text}${warn.map((w) => `<br><b class="warn">${w}</b>`).join('')}</span>`
      + `<span><button type="button" class="fly">${stopFly ? '■' : '▶'}</button>`
      + '<button type="button" class="end" aria-label="경로 안내 끝내기" title="경로 안내 끝내기">✕</button></span></div>';
    const fly = followEl.querySelector('.fly'), label = stopFly ? '미리 보기 멈춤' : '경로 3D 미리 날아보기';
    Object.assign(fly, { title: label, onclick: toggleFly });
    fly.setAttribute('aria-label', label);
    followEl.querySelector('.end').onclick = () => { clearRoute(); profile.hide(); };
    followEl.style.display = 'block';
  }
  function toggleFly() {
    if (stopFly) return stopFly();
    const { fine, cum } = follow;
    stopFly = flyAlong(map, fine, cum, {
      onStep: (d) => profile.cursor(d), // 그래프 세로선·지도 점이 함께 따라감
      onEnd: () => { stopFly = null; renderFollow(); },
    });
    renderFollow();
  }

  function onPosition() {
    if (!follow || !here) return;
    const prev = follow.state;
    const r = progress(follow.fine, follow.cum, here, prev?.along);
    // GPS 오차가 크면 벗어났는지 돌아왔는지 판단을 미룸 (오차가 커졌다고 '돌아왔다'고 하지 않게)
    const off = r.off > Math.max(OFF, here.accuracy ?? 0) ? true : r.off <= OFF ? false : !!prev?.off;
    if (off && !prev?.off) { navigator.vibrate?.([200, 100, 200]); say(`경로에서 ${Math.round(r.off)} m 벗어났습니다.`); }
    if (!off && prev?.off) say('경로로 돌아왔습니다.');
    const arrived = follow.cum.at(-1) - r.along < ARRIVE;
    if (arrived && !prev?.arrived) { navigator.vibrate?.(300); say('도착했습니다.'); }
    follow.state = { ...r, off, offBy: r.off, arrived };
    renderFollow();
  }
  geo?.on('geolocate', (pos) => { here = { lon: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy }; onPosition(); });

  const lonlat = ({ lng, lat }) => ({ lon: lng, lat });
  const pin = (i, color) => markers.push(new maplibregl.Marker({ color, scale: 0.7 }).setLngLat([graph.pts[i].lon, graph.pts[i].lat]).addTo(map));

  // 점 → 화면에 그린 선까지의 픽셀 거리
  function pxDist(pt, coords) {
    let best = Infinity;
    for (let i = 1; i < coords.length; i++) {
      const a = map.project(coords[i - 1]), b = map.project(coords[i]);
      const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(a.x + t * dx - pt.x, a.y + t * dy - pt.y));
    }
    return best;
  }

  // OSM 길 하나는 다리·계단 등 태그가 바뀌는 곳에서도 잘려 몇 m짜리 토막이 많음 →
  // 그래프를 따라 양쪽으로 갈림길(연결 3개 이상)이나 막다른 끝까지 넓혀 '갈림길 사이 구간'을 고름
  function toJunctions(coords) {
    const key = ([lon, lat]) => graph.pts.findIndex((p) => p.lon.toFixed(5) === lon.toFixed(5) && p.lat.toFixed(5) === lat.toFixed(5));
    const path = coords.map(key);
    const seen = new Set(path);
    for (let side = 0; side < 2; side++) {
      for (;;) {
        const end = path.at(-1), next = graph.adj[end].filter(([v]) => !seen.has(v));
        if (graph.adj[end].length !== 2 || next.length !== 1) break;
        path.push(next[0][0]); seen.add(next[0][0]);
      }
      path.reverse();
    }
    return path.map((i) => graph.pts[i]);
  }

  // 선·점이 작아 손가락으로 정확히 누르기 어려워 주변 ±12 px 안에서 찾음
  const near = ({ x, y }, layer) => map.queryRenderedFeatures([[x - 12, y - 12], [x + 12, y + 12]], { layers: [layer] });

  // 정상·쉼터 등 점을 눌렀으면 이름·종류·고도 안내 (조각 선택보다 우선)
  function pickPoi(e) {
    const found = near(e.point, 'pois');
    if (!found.length) return false;
    const d = (f) => map.project(f.geometry.coordinates).dist(e.point);
    const { name, kind, ele } = found.reduce((a, b) => (d(b) < d(a) ? b : a)).properties;
    say(`${name ? `${name} · ` : ''}${KIND[kind]} · 고도 ${ele} m`);
    return true;
  }

  async function pickSegment(e) {
    // 그중 누른 곳에 가장 가까운 선을 고름
    const found = near(e.point, 'trails');
    if (!found.length) return clearPick();
    await load();
    // 타일에 잘린 조각이 아니라 원본 전체 선으로 비교 (generateId = 파일 속 순서)
    const id = found.map((f) => f.id).reduce((a, b) => (pxDist(e.point, lines[b]) < pxDist(e.point, lines[a]) ? b : a));
    const pts = toJunctions(lines[id]);
    map.getSource('pick').setData(line(pts.map((p) => [p.lon, p.lat])));
    profile.show(pts, { color: '#e0a800' });
  }

  async function pickRoutePoint(e) {
    await load();
    const tap = lonlat(e.lngLat);
    if (nearestNode(graph, tap, SNAP) < 0) return say(`등산로에서 ${SNAP} m 안쪽을 눌러 주세요.`);
    if (start == null) {
      clearRoute(); start = tap; pin(nearestNode(graph, tap, SNAP), '#16a34a');
      return say('도착점을 누르세요.');
    }
    const [s, t] = snapPair(graph, start, tap, SNAP);
    clearRoute(); pin(s, '#16a34a'); pin(t, '#b91c1c');
    const r = shortestPath(graph, s, t);
    start = null; setMode(false);
    if (!r) return say('두 지점을 잇는 등산로가 없습니다. 같은 산줄기 안에서 골라 주세요.');
    showRoute(r.path.map((k) => graph.pts[k]));
  }

  // 찾은 경로 → 초록 선·안내 창·고도 그래프 (경로 찾기·하산길이 같이 씀)
  async function showRoute(pts) {
    map.getSource('route').setData(line(pts.map((p) => [p.lon, p.lat])));
    const fine = resample(pts); // 20 m 간격: 걷는 시간 계산과 진행 위치 계산을 같은 점으로
    const eles = await profile.elevations(fine);
    const mins = eles && toblerCumulative(fine, eles);
    follow = { fine, cum: cumulative(fine), mins, state: null };
    renderFollow();
    onPosition(); // 위치가 이미 켜져 있으면 바로 남은 거리
    profile.show(pts, { color: '#16a34a', note: mins ? ` · 걷는 시간 약 ${fmtMin(mins.at(-1))}` : '' });
  }

  // ── 가장 빠른 하산길: 지금 위치(없으면 지도 가운데)에서 걷는 시간이 가장 짧은 들머리(등산로가 차도와 만나는 곳)로 ──
  let heads = null, nodeEles;
  async function descend() {
    await load();
    heads ??= new Set((await (await fetch(pois)).json()).features.filter((f) => f.properties.kind === 'trailhead')
      .map((f) => nearestNode(graph, { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }, 15)).filter((i) => i >= 0));
    if (!heads.size) return say('이 산 데이터에 들머리가 없습니다.');
    const from = here ?? lonlat(map.getCenter());
    const s = nearestNode(graph, from, 3 * SNAP);
    if (s < 0) return say(`${here ? '지금 위치' : '지도 가운데'}에서 ${3 * SNAP} m 안에 등산로가 없습니다.`);
    // 오르막·내리막을 반영해야 가까워도 봉우리를 하나 넘는 길을 피함. 고도 타일을 못 받으면 거리 기준
    nodeEles ??= await profile.elevations(graph.pts);
    const r = shortestPath(graph, s, heads, nodeEles ? toblerEdge(nodeEles) : undefined);
    if (!r) return say('이어진 들머리가 없습니다. 지나온 길로 돌아가세요.');
    if (r.path.length < 2) return say('이미 들머리(차도와 만나는 곳)에 있습니다.');
    clearPick(); clearRoute(); setMode(false);
    pin(s, '#16a34a'); pin(r.path.at(-1), '#b91c1c');
    await showRoute(r.path.map((k) => graph.pts[k]));
    say(`가장 빠른 하산길 (${here ? '지금 위치' : '위치가 꺼져 있어 지도 가운데'} 기준${nodeEles ? '' : ', 고도 없이 거리로 고름'})`);
  }
  const down = Object.assign(document.createElement('button'), { type: 'button', className: 'txt small', textContent: '하산', title: '가장 빠른 하산길' });
  down.setAttribute('aria-label', '가장 빠른 하산길');
  down.onclick = descend;

  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'txt', textContent: '⇢' });
  function setMode(on) {
    mode = on;
    const label = on ? '경로 찾기 취소' : '출발·도착을 눌러 경로 찾기';
    Object.assign(btn, { title: label });
    btn.setAttribute('aria-label', label);
    btn.classList.toggle('on', on);
  }
  btn.onclick = () => {
    start = null;
    if (mode) return setMode(false);
    clearPick(); clearRoute(); profile.hide(); setMode(true);
    say('출발점을 누르세요. (등산로 근처)');
  };
  setMode(false);
  map.addControl({
    onAdd() {
      const div = Object.assign(document.createElement('div'), { className: 'maplibregl-ctrl maplibregl-ctrl-group' });
      div.append(btn, down);
      return div;
    },
    onRemove() {},
  });
  // 경로 모드에선 정상을 눌러도 출발·도착점으로 씀
  map.on('click', (e) => (mode ? pickRoutePoint(e) : pickPoi(e) || pickSegment(e)));
}
