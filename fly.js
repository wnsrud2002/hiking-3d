// 경로 미리 날아보기: 카메라가 경로를 따라 기울여 날아감. 지도를 만지면 멈춤

// 누적 거리 cum(m) 기준으로 경로 위 d m 지점 (선형 보간)
export function pointAt(pts, cum, d) {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < d) i++;
  const t = Math.max(0, Math.min(1, (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
  return { lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t, lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t };
}

// a → b 방위각(도, 북쪽 0 시계방향). 좁은 범위라 평면 근사
export const bearing = (a, b) =>
  (Math.atan2((b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat) * 180 / Math.PI + 360) % 360;

// onStep(d): 매 화면마다 진행 거리, onEnd(): 끝나거나 멈췄을 때. 반환값을 부르면 멈춤
export function flyAlong(map, pts, cum, { onStep, onEnd }) {
  const total = cum.at(-1);
  const seconds = Math.max(12, Math.min(45, total / 80)); // 2 km ≈ 25초. 너무 짧으면 어지럽고 길면 지루함
  const AHEAD = 80; // m. 바로 다음 점을 보면 지그재그마다 화면이 휙휙 돌아서 조금 앞을 봄
  let head = bearing(pts[0], pointAt(pts, cum, AHEAD)), t0 = null, frame = 0, done = false;

  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    canvas.removeEventListener('pointerdown', stop);
    canvas.removeEventListener('wheel', stop);
    onEnd?.();
  };
  const canvas = map.getCanvasContainer();
  canvas.addEventListener('pointerdown', stop);
  canvas.addEventListener('wheel', stop, { passive: true });

  const step = (now) => {
    t0 ??= now;
    const d = Math.min(total, (now - t0) / 1000 / seconds * total);
    const p = pointAt(pts, cum, d), ahead = pointAt(pts, cum, Math.min(total, d + AHEAD));
    if (d < total - 1) { // 끝에선 앞을 볼 점이 없어 방향 유지
      const want = bearing(p, ahead);
      head = (head + ((want - head + 540) % 360 - 180) * 0.05 + 360) % 360; // 화면마다 5%씩 따라가 부드럽게 돎
    }
    map.jumpTo({ center: [p.lon, p.lat], bearing: head, pitch: 65, zoom: 15.5 });
    onStep?.(d);
    if (d >= total) return stop();
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return stop;
}
