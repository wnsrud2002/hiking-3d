"""승학산 주변 등산로를 OSM(Overpass)에서 받아 trails.geojson으로 저장한다.

브라우저에서 매번 Overpass를 부르면 5~35초 걸리거나 502가 나서, 미리 받아 파일로 둔다.
실행: python3 fetch_trails.py
"""
import json
import math
import sys
from collections import defaultdict
import urllib.parse
import urllib.request
from pathlib import Path

from make_contours import CENTER, R, URL, Z, decode_terrarium, tile_xy  # 범위·고도 타일 처리를 한곳에서 관리

S, W, N, E = CENTER[1] - R, CENTER[0] - R, CENTER[1] + R, CENTER[0] + R
# footway의 절반 이상이 시내 보도·횡단보도, 감천문화마을 등 마을 골목은 path=alley로 붙어 있어 제외
QUERY = (f'[out:json][timeout:60];way["highway"~"^(path|footway|steps)$"]'
         f'["footway"!~"^(sidewalk|crossing|alley)$"]["path"!="alley"]({S},{W},{N},{E});out geom;')
# 낙동강 둔치 산책로는 최고 고도가 10 m 미만이고, 10→15 m로 올려도 걸리는 길 수가 같음 → 여유 있게 15 m
MIN_TOP = 15
BUILDINGS = f'[out:json][timeout:90];way["building"]({S},{W},{N},{E});out center;'
# 태그가 그냥 path인 마을 골목은 건물 사이로 지나감. 길의 80% 이상이 건물 중심 25 m 안이면 제외.
# 실측 분포가 0~10%(233개)와 90~100%(19개)로 갈리고 80~90%는 0개라 경계가 뚜렷함
BUILDING_R, BUILDING_FRAC = 25, 0.8
BOX = f"({S},{W},{N},{E})"
POIS = (f'[out:json][timeout:60];(node["natural"~"^(peak|spring)$"]{BOX};node["tourism"="viewpoint"]{BOX};'
        f'nwr["amenity"~"^(shelter|drinking_water|toilets)$"]{BOX};node["information"="guidepost"]{BOX};);out center tags;')
KINDS = [("natural", "peak", "peak"), ("tourism", "viewpoint", "view"), ("natural", "spring", "water"),
         ("amenity", "drinking_water", "water"), ("amenity", "shelter", "shelter"), ("amenity", "toilets", "toilets"),
         ("information", "guidepost", "guide")]  # 위에 있을수록 우선 (전망대이면서 바위인 곳 → 전망대)
POI_R = 30  # m
MX, MY = 111320 * math.cos(math.radians(CENTER[1])), 111320  # 위경도 1°당 m (범위가 좁아 평면 근사)
# 메인 서버가 느리거나(35 s) 502를 내는 일이 잦아 미러를 먼저 시도
SERVERS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter",
           "https://overpass-api.de/api/interpreter"]


def fetch(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    for url in SERVERS:
        try:
            req = urllib.request.Request(url, body, {"User-Agent": "hiking-3d"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except Exception as e:
            print(f"{url} 실패: {e}", file=sys.stderr)
    sys.exit("모든 Overpass 서버 실패")


_tiles = {}


def elevation(lon, lat):
    x, y = tile_xy(lon, lat)
    t = (int(x), int(y))
    if t not in _tiles:
        req = urllib.request.Request(URL.format(z=Z, x=t[0], y=t[1]), headers={"User-Agent": "hiking-3d"})
        _tiles[t] = decode_terrarium(urllib.request.urlopen(req, timeout=30).read())
    v = _tiles[t][int((y - t[1]) * 256)][int((x - t[0]) * 256)]
    return v if v > -100 else 0  # 고도 타일의 -1000 m대 결측 픽셀


def near_any(points, r):
    """점들 → (x, y)가 그중 하나에서 r m 안인지 답하는 함수. r 크기 격자로 주변 9칸만 봄."""
    cell = lambda x, y: (int(x * MX / r), int(y * MY / r))
    grid = defaultdict(list)
    for x, y in points:
        grid[cell(x, y)].append((x, y))

    def near(x, y):
        cx, cy = cell(x, y)
        return any(math.hypot((bx - x) * MX, (by - y) * MY) < r
                   for dx in (-1, 0, 1) for dy in (-1, 0, 1) for bx, by in grid.get((cx + dx, cy + dy), ()))
    return near


def samples(way):
    """길의 10 m 간격 점. 꼭짓점만 보면 긴 직선 구간이 빠짐."""
    pts = [(p["lon"], p["lat"]) for p in way["geometry"]]
    out = [pts[0]]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        n = max(1, int(math.hypot((x2 - x1) * MX, (y2 - y1) * MY) // 10))
        out += [(x1 + (x2 - x1) * k / n, y1 + (y2 - y1) * k / n) for k in range(1, n + 1)]
    return out


def building_fraction(buildings):
    """건물 중심점들 → (길 → 표본 중 건물 BUILDING_R 안에 든 비율) 함수."""
    near = near_any(buildings, BUILDING_R)

    def fraction(way):
        pts = samples(way)
        return sum(near(x, y) for x, y in pts) / len(pts)
    return fraction


def to_pois(elements, ways):
    """정상·전망대 등 → GeoJSON 점. 봉우리 말고는 등산로 POI_R 안의 것만 (아파트 약수터·마을 화장실 제외)."""
    near = near_any([p for w in ways for p in samples(w)], POI_R)
    feats = []
    for e in elements:
        t, c = e["tags"], e.get("center", e)
        kind = next((k for key, val, k in KINDS if t.get(key) == val), None)
        if not kind or kind != "peak" and not near(c["lon"], c["lat"]):
            continue
        try:
            ele = float(t["ele"])
        except (KeyError, ValueError):  # 태그가 없거나 "497m"처럼 숫자가 아님
            ele = elevation(c["lon"], c["lat"])
        props = {"kind": kind, "ele": round(ele)}
        if t.get("name"):
            props["name"] = t["name"]
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "Point", "coordinates": [round(c["lon"], 5), round(c["lat"], 5)]}})
    return {"type": "FeatureCollection", "features": feats}


def save(name, gj):
    out = Path(__file__).with_name(name)
    out.write_text(json.dumps(gj, separators=(",", ":"), ensure_ascii=False))
    return out.stat().st_size


def to_geojson(ways):
    # 소수 5자리 ≈ 1 m: 30 m DEM 위에 그리기엔 충분하고 파일이 1/3로 줄어듦
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": {
            "type": "LineString",
            "coordinates": [[round(p["lon"], 5), round(p["lat"], 5)] for p in w["geometry"]]}}
        for w in ways]}


if __name__ == "__main__":
    osm = fetch(QUERY)
    high = [w for w in osm["elements"] if max(elevation(p["lon"], p["lat"]) for p in w["geometry"]) >= MIN_TOP]
    buildings = [(b["center"]["lon"], b["center"]["lat"]) for b in fetch(BUILDINGS)["elements"] if "center" in b]
    fraction = building_fraction(buildings)
    ways = [w for w in high if fraction(w) < BUILDING_FRAC]
    gj = to_geojson(ways)
    assert gj["features"], "등산로 0개: 범위나 쿼리를 확인"
    size = save("trails.geojson", gj)
    print(f"받은 길 {len(osm['elements'])}개 → 저지대(최고 {MIN_TOP} m 미만) {len(osm['elements']) - len(high)}개 제외 → "
          f"건물 사이(건물 {len(buildings)}개 기준) {len(high) - len(ways)}개 제외 → "
          f"{len(ways)}개, {size:,} B 저장 (OSM 기준 {osm['osm3s']['timestamp_osm_base']})")
    poi = fetch(POIS)["elements"]
    pois = to_pois(poi, ways)
    print(f"지점 {len(poi)}개 → 등산로 {POI_R} m 밖 {len(poi) - len(pois['features'])}개 제외 → "
          f"{len(pois['features'])}개, {save('pois.geojson', pois):,} B 저장")
