// 산 정상 날씨: Open-Meteo(무료·키 없음)에서 정상 높이 기준 시간별 예보. 보내는 건 정상 좌표뿐(내 위치 아님)
const RAIN = 60; // %. 강수확률이 이 이상이면 경고
const GUST = 15; // m/s. 돌풍이 이 이상이면 능선에서 몸이 휘청이는 수준(기상청 강풍주의보 기준 순간풍속 20 m/s보다 낮게 잡음)
const HOURS = 12;

// WMO 날씨 코드 → 기호·말
export function sky(code) {
  if (code === 0) return '☀️ 맑음';
  if (code <= 2) return '🌤️ 구름 조금';
  if (code === 3) return '☁️ 흐림';
  if (code <= 48) return '🌫️ 안개';
  if (code <= 57) return '🌦️ 이슬비';
  if (code <= 67) return '🌧️ 비';
  if (code <= 77) return '❄️ 눈';
  if (code <= 82) return '🌦️ 소나기';
  if (code <= 86) return '🌨️ 눈 소나기';
  return '⛈️ 뇌우';
}

// 예보 → 지금 시각부터 HOURS시간 줄과 경고 문구
export function rows(hourly, now) {
  const start = hourly.time.findIndex((t) => new Date(`${t}:00+09:00`).getTime() > now - 3600e3); // 지금이 든 시간부터
  const out = [];
  if (start < 0) return out; // 저장본이 오래돼 지난 시간뿐 → 지난 예보를 지금 것처럼 보여주지 않음
  for (let i = start; i < hourly.time.length && out.length < HOURS; i++) {
    const r = { hour: hourly.time[i].slice(11, 13), sky: sky(hourly.weather_code[i]), temp: hourly.temperature_2m[i],
      feel: hourly.apparent_temperature[i], rain: hourly.precipitation_probability[i], wind: hourly.wind_speed_10m[i], gust: hourly.wind_gusts_10m[i] };
    r.warn = [r.rain >= RAIN && `${r.hour}시 비 ${r.rain}%`, r.gust >= GUST && `${r.hour}시 돌풍 ${Math.round(r.gust)} m/s`,
      hourly.weather_code[i] >= 95 && `${r.hour}시 뇌우: 정상·능선 피하기`].filter(Boolean);
    out.push(r);
  }
  return out;
}

export function setupWeather(map, { M, say }) {
  const el = document.getElementById('weather');
  const key = `hiking-3d:weather:${M.id}`;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${M.summit[1]}&longitude=${M.summit[0]}&elevation=${M.ele}`
    + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m,wind_gusts_10m,weather_code'
    + '&wind_speed_unit=ms&timezone=Asia%2FSeoul&forecast_days=2';

  function render({ at, hourly }, saved) {
    const rs = rows(hourly, Date.now());
    if (!rs.length) return say('저장된 날씨가 너무 오래돼 보여줄 수 없습니다. 신호가 있는 곳에서 다시 열어 주세요.');
    const warns = rs.flatMap((r) => r.warn);
    const time = new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    el.innerHTML = `<div class="ph"><b>${M.name} 정상(${M.ele} m) 날씨</b>`
      + '<button type="button" aria-label="날씨 닫기" title="날씨 닫기">✕</button></div>'
      + (warns.length ? `<div class="warn">${warns.slice(0, 3).join(' · ')}</div>` : '<div>앞으로 12시간 비·강풍 경고 없음</div>')
      + '<table><thead><tr><th>시</th><th>날씨</th><th>기온(체감)</th><th>비</th><th>바람(돌풍)</th></tr></thead><tbody>'
      + rs.map((r) => `<tr${r.warn.length ? ' class="warn"' : ''}><td>${r.hour}</td><td>${r.sky}</td>`
        + `<td>${Math.round(r.temp)}° (${Math.round(r.feel)}°)</td><td>${r.rain}%</td><td>${r.wind.toFixed(1)} (${r.gust.toFixed(1)}) m/s</td></tr>`).join('')
      + `</tbody></table><div class="src">${saved ? `오프라인: ${time}에 받은 예보` : `${time} 기준`} · `
      + '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0)</div>';
    el.querySelector('button').onclick = () => (el.style.display = 'none');
    el.style.display = 'block';
  }

  async function show() {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const data = { at: Date.now(), hourly: (await res.json()).hourly };
      localStorage.setItem(key, JSON.stringify(data)); // 산에서 신호가 끊겨도 마지막 예보는 보이게
      render(data, false);
    } catch {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (saved) render(saved, true);
      else say('날씨를 받지 못했습니다. 신호가 있는 곳에서 한 번 열어 두면 오프라인에서도 볼 수 있어요.');
    }
  }

  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'txt', textContent: '☁', title: '정상 날씨' });
  btn.setAttribute('aria-label', '정상 날씨');
  btn.onclick = () => (el.style.display === 'block' ? (el.style.display = 'none') : show());
  map.addControl({
    onAdd() {
      const div = Object.assign(document.createElement('div'), { className: 'maplibregl-ctrl maplibregl-ctrl-group' });
      div.append(btn);
      return div;
    },
    onRemove() {},
  });
}
