// 자체 검사: node selftest.mjs  (브라우저 없이 계산 로직만)
import { climb, dist } from './profile.js';
import { sunset } from './sun.js';
import { pointAt, bearing } from './fly.js';
import { buildGraph, shortestPath, toblerMinutes, resample, progress, cumulative, snapPair } from './route.js';

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`);

// climb: 오르내림 누적, 3 m 미만 떨림 무시, 끝부분 잔여 반영
for (const [e, u, d] of [[[100, 150, 120, 200], 130, 30], [[100, 101, 99, 101, 99, 101, 100], 0, 0],
  [[100, 102, 104, 106], 6, 0], [[500, 400, 300], 0, 200], [[100, 300, 100], 200, 200]]) {
  const r = climb(e);
  ok(r.up === u && r.down === d, `climb ${JSON.stringify(e)} → ${JSON.stringify(r)}`);
}

// 그래프: 위도 35°에서 0.001° ≈ 경도 91 m / 위도 111 m
// A─B─C 직선과 A─D─C 우회로 → A→C는 직선
const A = [129, 35], B = [129.001, 35], C = [129.002, 35], D = [129.001, 35.002];
const g1 = buildGraph([[A, B, C], [A, D, C]]);
const r1 = shortestPath(g1, 0, 2);
ok(r1.path.length === 3 && r1.path[1] === 1, `직선을 골라야 함: ${r1.path}`);
near(r1.length, dist({ lon: 129, lat: 35 }, { lon: 129.002, lat: 35 }), 0.01, '직선 길이');

// 갈림길: 다른 선의 중간 꼭짓점을 공유하면 연결됨
const g2 = buildGraph([[A, B, C], [B, D]]);
ok(shortestPath(g2, g2.pts.findIndex((p) => p.lat === 35.002), 0) !== null, '중간 꼭짓점 공유 갈림길 연결');

// 끊긴 두 덩어리 → null, 끝점이 5 m 떨어진 경우엔 GAP(10 m)로 이어 줌
const far = buildGraph([[A, B], [[129.01, 35], [129.011, 35]]]);
ok(shortestPath(far, 0, 3) === null && far.joined === 0, '멀리 떨어지면 경로 없음');
const gap = buildGraph([[A, B], [[129.001055, 35], [129.002, 35]]]); // B와 약 5 m
ok(gap.joined >= 1 && shortestPath(gap, 0, 3) !== null, '5 m 끊김은 이어 줌');

// snapPair: 출발 탭 바로 옆 외딴 조각(20 m)보다 50 m 떨어진 큰 길이 도착점과 이어져 있으면 그쪽에 붙임
const main = [[129, 35], [129 + 300 / 91290, 35]], isolated = [[129, 35 + 20 / 111320], [129 + 10 / 91290, 35 + 20 / 111320]];
const gs = buildGraph([main, isolated]);
const tapA = { lon: 129, lat: 35 + 30 / 111320 }, tapB = { lon: 129 + 300 / 91290, lat: 35 };
const [ss, tt] = snapPair(gs, tapA, tapB, 100);
ok(gs.comp[ss] === gs.comp[tt] && shortestPath(gs, ss, tt) !== null, `snapPair 같은 덩어리: ${ss},${tt}`);
const [s2] = snapPair(gs, tapA, { lon: 129 + 10 / 91290, lat: 35 + 20 / 111320 }, 100);
ok(gs.pts[s2].lat > 35, '둘 다 외딴 조각 근처면 그대로');

// Tobler: 평지 1 km ≈ 5.04 km/h → 11.9분, 경사 +20%는 훨씬 느림
const flat = [{ lon: 129, lat: 35 }, { lon: 129 + 1 / 91.29, lat: 35 }];
near(toblerMinutes(flat, [0, 0]), 60 / (6 * Math.exp(-0.175)) * dist(flat[0], flat[1]) / 1000, 0.01, 'Tobler 평지');
ok(toblerMinutes(flat, [0, 200]) > 2 * toblerMinutes(flat, [0, 0]), 'Tobler 오르막이 더 느림');

// resample: 100 m 선을 20 m 간격 → 6점, 끝점 보존
const rs = resample([{ lon: 129, lat: 35 }, { lon: 129 + 0.1 / 91.29, lat: 35 }], 20);
ok(rs.length === 6 && rs.at(-1).lon === 129 + 0.1 / 91.29, `resample ${rs.length}`);

// progress: 200 m 동서 직선의 100 m 지점에서 북쪽 20 m → off 20, along 100
const M = 1 / 91290; // 위도 35°에서 경도 1 m (위도 1 m = 1/111320)
const line = resample([{ lon: 129, lat: 35 }, { lon: 129 + 200 * M, lat: 35 }]);
const pr = progress(line, cumulative(line), { lon: 129 + 100 * M, lat: 35 + 20 / 111320 });
near(pr.off, 20, 0.5, 'progress off'); near(pr.along, 100, 0.5, 'progress along');

// 지그재그: 동쪽 100 m → 북쪽 10 m → 서쪽 100 m. 두 굽이 사이(북쪽 5 m)는 양쪽 다 5 m라
// 지난 위치가 첫 굽이(along 40)면 첫 굽이(along 50), 둘째 굽이(along 150)면 둘째 굽이(along 160)
const zz = resample([{ lon: 129, lat: 35 }, { lon: 129 + 100 * M, lat: 35 },
  { lon: 129 + 100 * M, lat: 35 + 10 / 111320 }, { lon: 129, lat: 35 + 10 / 111320 }]);
const zc = cumulative(zz), mid = { lon: 129 + 50 * M, lat: 35 + 5 / 111320 };
near(progress(zz, zc, mid, 40).along, 50, 1, '지그재그 첫 굽이 유지');
near(progress(zz, zc, mid, 150).along, 160, 1, '지그재그 둘째 굽이 유지');

// 미리 날아보기: 200 m 직선의 50 m 지점, 동쪽 방위 90°·북쪽 0°
const fp = pointAt(line, cumulative(line), 50);
near(dist(line[0], fp), 50, 0.5, 'pointAt 50 m');
near(bearing(line[0], line.at(-1)), 90, 0.1, '방위 동쪽'); near(bearing({ lon: 129, lat: 35 }, { lon: 129, lat: 35.1 }), 0, 0.1, '방위 북쪽');

// 일몰: timeanddate.com 부산(35.18, 129.08) 2026년 11월 표와 2분 안. 저녁 9시에 물어도 그날 일몰
const kst = (d) => new Date(`${d}+09:00`);
for (const [d, ref] of [['2026-11-01', '17:29'], ['2026-11-15', '17:18'], ['2026-11-27', '17:12'], ['2026-11-30', '17:11']]) {
  for (const at of ['09:00', '21:00']) near(sunset(kst(`${d}T${at}`), 35.1796, 129.0756) - kst(`${d}T${ref}`), 0, 2 * 60e3, `일몰 ${d} ${at}`);
}

console.log('자체 검사 통과: climb 5 · 그래프·최단경로 7 · Tobler 2 · resample 1 · 진행 위치 4 · 날아보기 3 · 일몰 8');
