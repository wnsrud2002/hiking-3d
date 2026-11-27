// 등산로 그래프 계산 (화면과 무관한 순수 함수). route.js가 쓰고 selftest.mjs가 검사
import { dist } from './profile.js';

const GAP = 10; // m. OSM에서 실제론 이어졌는데 살짝 떨어져 그려진 막다른 끝점(승학산 범위 4곳)을 이어 줌

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
