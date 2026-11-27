// 등산로 경사도 색칠 ('경사' 버튼): 길을 약 40 m씩 잘라 양 끝 고도 차 ÷ 길이로 경사(%)를 구해 색으로 보여줌
import { dist } from './profile.js';

const STEP = 40; // m. 고도 타일이 7.8 m 픽셀·30 m 원본이라 이보다 짧으면 픽셀 경계 차이가 경사로 튐
export const CLASSES = [[10, '#16a34a', '완만'], [20, '#ca8a04', '보통'], [30, '#ea580c', '가파름'], [Infinity, '#dc2626', '급경사']]; // [미만 %, 색, 이름]

// 좌표 배열 → STEP m 이상씩 묶은 조각들 (원래 꼭짓점은 그대로 둬 모양 유지). 끝에 STEP/2 미만이 남으면 앞 조각에 붙임
export function chunks(coords, step = STEP) {
  const out = [];
  let cur = [coords[0]], len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += dist({ lon: coords[i - 1][0], lat: coords[i - 1][1] }, { lon: coords[i][0], lat: coords[i][1] });
    cur.push(coords[i]);
    if (len >= step) { out.push({ coords: cur, len }); cur = [coords[i]]; len = 0; }
  }
  if (cur.length > 1) {
    if (out.length && len < step / 2) { const last = out.at(-1); last.coords.push(...cur.slice(1)); last.len += len; }
    else out.push({ coords: cur, len });
  }
  return out;
}

export function setupSlope(map, { say, profile, trails }) {
  let data = null, on = false;
  const legend = document.getElementById('slope-legend');

  async function build() {
    const lines = (await (await fetch(trails)).json()).features.map((f) => f.geometry.coordinates);
    const parts = lines.flatMap((cs) => chunks(cs));
    const ends = parts.flatMap((p) => [p.coords[0], p.coords.at(-1)]).map(([lon, lat]) => ({ lon, lat }));
    const eles = await profile.elevations(ends);
    if (!eles) return null;
    return {
      type: 'FeatureCollection',
      features: parts.map((p, i) => ({ type: 'Feature', properties: { slope: Math.round(Math.abs(eles[2 * i + 1] - eles[2 * i]) / p.len * 100) },
        geometry: { type: 'LineString', coordinates: p.coords } })),
    };
  }

  async function toggle() {
    on = !on;
    btn.classList.toggle('on', on);
    if (on && !data) {
      say('경사를 계산하는 중…');
      data = await build();
      if (!data) { on = false; btn.classList.remove('on'); return say('고도 타일을 받지 못해 경사를 계산할 수 없습니다.'); }
    }
    map.getSource('slope').setData(on ? data : { type: 'FeatureCollection', features: [] });
    legend.style.display = on ? 'block' : 'none';
    if (on) {
      const n = CLASSES.map(([max], k) => data.features.filter((f) => f.properties.slope < max && (k === 0 || f.properties.slope >= CLASSES[k - 1][0])).length);
      legend.innerHTML = '<b>등산로 경사</b> ' + CLASSES.map(([max, color, name], k) =>
        `<span><i style="background:${color}"></i>${name} ${k ? `${CLASSES[k - 1][0]}` : '0'}${max < Infinity ? `~${max}` : '+'}% (${Math.round(n[k] / data.features.length * 100)}%)</span>`).join('');
    }
  }

  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'txt small', textContent: '경사', title: '등산로 경사도 색칠' });
  btn.setAttribute('aria-label', '등산로 경사도 색칠');
  btn.onclick = toggle;
  map.addControl({
    onAdd() {
      const div = Object.assign(document.createElement('div'), { className: 'maplibregl-ctrl maplibregl-ctrl-group' });
      div.append(btn);
      return div;
    },
    onRemove() {},
  });
}
