// 등산로 선택: 평소엔 조각 탭 → 강조·고도 그래프, 경로 모드(⇢)에선 출발·도착 탭 → 등산로를 따라 최단 경로
import { dist } from './profile.js';
import { sunset } from './sun.js';

const GAP = 10; // m. OSM에서 실제론 이어졌는데 살짝 떨어져 그려진 막다른 끝점(승학산 범위 4곳)을 이어 줌
const SNAP = 100; // m. 누른 곳에서 이보다 먼 등산로에는 붙이지 않음
const OFF = 30; // m. 경로에서 이만큼(GPS 오차가 더 크면 그만큼) 벗어나면 알림
const ARRIVE = 20; // m. 남은 거리가 이보다 짧으면 도착

// GeoJSON LineString 좌표 배열들 → 그래프. 같은 좌표(소수 5자리 ≈ 1 m)는 같은 지점 = 갈림길
export function buildGraph(lines) {
  const id = new Map(), pts = [], adj = [];
  const node = ([lon, lat]) => {
    const k = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    if (!id.has(k)) { id.set(k, pts.length); pts.push({ lon, lat }); adj.push([]); }
    return id.get(k);
  };
  const link = (a, b) => {
    if (a === b) return;
    const w = dist(pts[a], pts[b]);
    adj[a].push([b, w]); adj[b].push([a, w]);
  };
  for (const cs of lines) for (let i = 1; i < cs.length; i++) link(node(cs[i - 1]), node(cs[i]));

  // 연결 덩어리 번호 → 막다른 끝점을 GAP 안의 '다른 덩어리' 지점과 이어 줌 (같은 덩어리끼리 이으면 지름길이 생김)
  const comp = components(adj);
  const cell = (p) => `${Math.floor(p.lat * 111320 / GAP)},${Math.floor(p.lon * 111320 * Math.cos(p.lat * Math.PI / 180) / GAP)}`;
  const grid = new Map();
  pts.forEach((p, i) => { const k = cell(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  let joined = 0;
  pts.forEach((p, i) => {
    if (adj[i].length !== 1) return;
    const [cy, cx] = cell(p).split(',').map(Number);
    let best = -1, bd = GAP;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
        const d = comp[j] !== comp[i] ? dist(p, pts[j]) : Infinity;
        if (d < bd) { bd = d; best = j; }
      }
    }
    if (best >= 0) { link(i, best); joined++; }
  });
  return { pts, adj, joined, comp: components(adj) }; // 이은 뒤 다시 셈: 경로 찾기에서 출발·도착을 같은 덩어리에 붙일 때 씀
}

function components(adj) {
  const comp = new Int32Array(adj.length).fill(-1);
  for (let s = 0, c = 0; s < adj.length; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s]; comp[s] = c;
    while (stack.length) for (const [v] of adj[stack.pop()]) if (comp[v] < 0) { comp[v] = c; stack.push(v); }
    c++;
  }
  return comp;
}

// p에서 within m 안의 가장 가까운 지점. c를 주면 그 연결 덩어리 안에서만. 없으면 -1
export function nearestNode({ pts, comp }, p, within, c = null) {
  let best = -1, bd = within;
  pts.forEach((q, i) => { if (c != null && comp[i] !== c) return; const d = dist(p, q); if (d < bd) { bd = d; best = i; } });
  return best;
}

// 누른 두 곳 → 서로 이어진 출발·도착 지점. 절·마을 안의 외딴 짧은 길에 먼저 붙으면 큰 등산로망이 바로 옆인데도
// 경로가 없다고 나오므로(금정산 범어사: 66 m 옆 130 m짜리 조각), 상대 쪽 덩어리에서 다시 찾아 봄
export function snapPair(graph, a, b, within) {
  let s = nearestNode(graph, a, within), t = nearestNode(graph, b, within);
  if (s < 0 || t < 0 || graph.comp[s] === graph.comp[t]) return [s, t];
  const t2 = nearestNode(graph, b, within, graph.comp[s]);
  if (t2 >= 0) return [s, t2];
  const s2 = nearestNode(graph, a, within, graph.comp[t]);
  return s2 >= 0 ? [s2, t] : [s, t];
}

// 다익스트라(이진 힙). 경로가 없으면 null
export function shortestPath({ pts, adj }, s, t) {
  const d = new Float64Array(pts.length).fill(Infinity), prev = new Int32Array(pts.length).fill(-1), heap = [];
  const push = (x) => {
    heap.push(x);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  d[s] = 0; push([0, s]);
  while (heap.length) {
    const [du, u] = pop();
    if (u === t) break;
    if (du > d[u]) continue; // 이미 더 짧게 확정된 지점의 낡은 항목
    for (const [v, w] of adj[u]) if (du + w < d[v]) { d[v] = du + w; prev[v] = u; push([d[v], v]); }
  }
  if (d[t] === Infinity) return null;
  const path = [];
  for (let v = t; v !== -1; v = prev[v]) path.push(v);
  return { path: path.reverse(), length: d[t] };
}

// 걷는 시간(분). Tobler 보행 함수 v = 6·e^(-3.5·|경사+0.05|) km/h (평지 약 5 km/h, 완만한 내리막에서 가장 빠름).
// 꼭짓점 사이가 몇 m뿐이면 7.8 m 고도 픽셀 경계에서 경사가 튀므로, 20 m 간격으로 다시 찍은 점을 넣을 것
// 누적 값(분): out[i] = 0번 점에서 i번 점까지 걷는 시간
export function toblerCumulative(pts, eles) {
  const out = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = dist(pts[i - 1], pts[i]);
    out.push(out[i - 1] + (dx ? dx / 1000 / (6 * Math.exp(-3.5 * Math.abs((eles[i] - eles[i - 1]) / dx + 0.05))) * 60 : 0));
  }
  return out;
}
export const toblerMinutes = (pts, eles) => toblerCumulative(pts, eles).at(-1);

// 경로 위 진행 위치. cum[i] = i번 점까지 누적 거리(m). 반환 { off: 경로까지 거리, along: 투영점까지 누적 거리, i: 구간 번호 }
// 지그재그 길은 옆 굽이가 GPS 오차 안에 들 수 있어, 지난 위치(last) 앞뒤 50 m 안에서 찾은 점이
// 전체에서 가장 가까운 점보다 15 m 이상 멀지 않으면 그쪽을 씀 (신호가 오래 끊겼다 돌아오면 전체 기준)
export function progress(pts, cum, p, last = null) {
  const mx = 111320 * Math.cos(p.lat * Math.PI / 180), my = 111320; // 20 m 구간이라 평면 근사로 충분
  const cand = [];
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1].lon - p.lon) * mx, ay = (pts[i - 1].lat - p.lat) * my;
    const dx = (pts[i].lon - pts[i - 1].lon) * mx, dy = (pts[i].lat - pts[i - 1].lat) * my;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    cand.push({ off: Math.hypot(ax + t * dx, ay + t * dy), along: cum[i - 1] + t * (cum[i] - cum[i - 1]), i });
  }
  const nearest = (cs) => cs.reduce((a, b) => (b.off < a.off ? b : a), { off: Infinity });
  const all = nearest(cand), local = last == null ? all : nearest(cand.filter((c) => Math.abs(c.along - last) <= 50));
  return local.off <= all.off + 15 ? local : all;
}

export const cumulative = (pts) => pts.reduce((acc, p, i) => (acc.push(i ? acc[i - 1] + dist(pts[i - 1], p) : 0), acc), []);

export function resample(pts, step = 20) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.round(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push({ lon: a.lon + (b.lon - a.lon) * k / n, lat: a.lat + (b.lat - a.lat) * k / n });
  }
  return out;
}

const KIND = { peak: '봉우리', view: '전망대', water: '약수터', shelter: '쉼터', toilets: '화장실', guide: '이정표' };

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간 ${Math.round(m % 60)}분` : `${Math.round(m)}분`);
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
const clock = (d) => d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

export function setupRoute(map, { maplibregl, say, profile, geo, trails }) {
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
    follow = null; followEl.style.display = 'none';
  };
  let markers = [], mode = false, start = null, follow = null, here = null;

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
      if (late) warn.push('일몰 뒤 도착 예상: 랜턴을 챙기거나 더 짧은 하산길을 고르세요');
      if (late && !follow.late) { navigator.vibrate?.([200, 100, 200]); say('일몰 전에 도착하기 어렵습니다.'); }
      follow.late = late;
    }
    if (!state) text += ' · 위치 버튼(◎)을 켜면 남은 거리 안내';
    followEl.innerHTML = `<div class="ph"><span>${text}${warn.map((w) => `<br><b class="warn">${w}</b>`).join('')}</span>`
      + '<button type="button" aria-label="경로 안내 끝내기" title="경로 안내 끝내기">✕</button></div>';
    followEl.querySelector('button').onclick = () => { clearRoute(); profile.hide(); };
    followEl.style.display = 'block';
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
    const pts = r.path.map((k) => graph.pts[k]);
    map.getSource('route').setData(line(pts.map((p) => [p.lon, p.lat])));
    const fine = resample(pts); // 20 m 간격: 걷는 시간 계산과 진행 위치 계산을 같은 점으로
    const eles = await profile.elevations(fine);
    const mins = eles && toblerCumulative(fine, eles);
    follow = { fine, cum: cumulative(fine), mins, state: null };
    renderFollow();
    onPosition(); // 위치가 이미 켜져 있으면 바로 남은 거리
    profile.show(pts, { color: '#16a34a', note: mins ? ` · 걷는 시간 약 ${fmtMin(mins.at(-1))}` : '' });
  }

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
      div.append(btn);
      return div;
    },
    onRemove() {},
  });
  // 경로 모드에선 정상을 눌러도 출발·도착점으로 씀
  map.on('click', (e) => (mode ? pickRoutePoint(e) : pickPoi(e) || pickSegment(e)));
}
