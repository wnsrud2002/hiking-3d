// 고도 읽기 · 누적 오르내림 · 고도 프로필 그래프. track.js(기록·GPX)와 route.js(등산로 선택)가 함께 씀

// 하버사인 거리(m). a, b: { lat, lon }
export function dist(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

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

export function createProfile({ say, demUrl }) {
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
  // 결측은 앞 값으로 채운 고도 배열. 타일을 못 받으면 null
  async function elevations(pts) {
    let eles;
    try { eles = await Promise.all(pts.map(elevation)); } catch { return null; }
    let prev = null;
    return eles.map((e) => (prev = e ?? prev ?? 0));
  }

  // #profile이 없는 이전 index.html과 섞여 불려도(갱신 도중) 다른 기능은 멈추지 않게
  const el = document.getElementById('profile');
  const hide = () => { if (el) el.style.display = 'none'; };

  // color: 그래프 색(지도 위 선과 맞춤), note: 머리줄 뒤에 붙일 문구
  async function show(pts, { color = '#d6249f', note = '' } = {}) {
    if (!el || pts.length < 2) return;
    const eles = await elevations(pts);
    if (!eles) return say('고도 타일을 받지 못해 고도 프로필을 그릴 수 없습니다.');
    const dists = pts.map((p, i) => (i ? dist(pts[i - 1], p) : 0));
    for (let i = 1; i < dists.length; i++) dists[i] += dists[i - 1];
    const total = dists.at(-1) || 1, lo = Math.min(...eles), hi = Math.max(...eles), span = Math.max(hi - lo, 20);
    const every = Math.ceil(pts.length / 400); // 그래프 폭(400)보다 촘촘한 점은 안 보이므로 솎음
    const xy = eles.map((_, i) => i).filter((i) => i % every === 0 || i === eles.length - 1)
      .map((i) => `${(dists[i] / total * 400).toFixed(1)},${(95 - (eles[i] - lo) / span * 85).toFixed(1)}`);
    const { up, down } = climb(eles);
    const summary = `${total < 1000 ? `${Math.round(total)} m` : `${(total / 1000).toFixed(2)} km`} · ↑ ${Math.round(up)} m · ↓ ${Math.round(down)} m · 최고 ${Math.round(hi)} m${note}`;
    el.innerHTML = `<div class="ph"><span>${summary}</span><button type="button" aria-label="고도 프로필 닫기">✕</button></div>`
      + `<svg viewBox="0 0 400 100" preserveAspectRatio="none" aria-hidden="true">`
      + `<polygon points="0,100 ${xy.join(' ')} 400,100" fill="${color}" fill-opacity=".18"/>`
      + `<polyline points="${xy.join(' ')}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
    el.setAttribute('aria-label', `고도 프로필: ${summary}, 최저 ${Math.round(lo)} m`);
    el.querySelector('button').onclick = hide;
    el.style.display = 'block';
  }

  return { show, hide, elevations };
}
