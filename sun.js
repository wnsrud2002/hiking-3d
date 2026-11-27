// 일몰 시각. 위키백과 'Sunrise equation'(NOAA 근사식) — 오차 약 1분, 라이브러리 없이 오프라인에서도 계산됨
const rad = Math.PI / 180;

// date에서 가장 가까운 태양 정오가 속한 날의 일몰 (Date). 백야·극야는 null
export function sunset(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = Math.round(jd - 2451545 + lon / 360); // 2000-01-01 정오 이후 날수 (이 경도의 태양일 기준)
  const j = n - lon / 360; // 평균 태양 정오
  const M = (357.5291 + 0.98560028 * j) % 360; // 평균 근점 이각
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360; // 황경
  const transit = 2451545 + j + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.4397 * rad));
  // -0.833°: 대기 굴절 + 해 반지름 (해 윗가장자리가 지평선에 닿는 순간)
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  if (Math.abs(cosH) > 1) return null;
  return new Date((transit + Math.acos(cosH) / rad / 360 - 2440587.5) * 86400000);
}
