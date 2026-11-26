"""승학산 주변 등산로를 OSM(Overpass)에서 받아 trails.geojson으로 저장한다.

브라우저에서 매번 Overpass를 부르면 5~35초 걸리거나 502가 나서, 미리 받아 파일로 둔다.
실행: python3 fetch_trails.py
"""
import json
import sys
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
# 메인 서버가 느리거나(35 s) 502를 내는 일이 잦아 미러를 먼저 시도
SERVERS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter",
           "https://overpass-api.de/api/interpreter"]


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
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


def to_geojson(ways):
    # 소수 5자리 ≈ 1 m: 30 m DEM 위에 그리기엔 충분하고 파일이 1/3로 줄어듦
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": {
            "type": "LineString",
            "coordinates": [[round(p["lon"], 5), round(p["lat"], 5)] for p in w["geometry"]]}}
        for w in ways]}


if __name__ == "__main__":
    osm = fetch()
    ways = [w for w in osm["elements"] if max(elevation(p["lon"], p["lat"]) for p in w["geometry"]) >= MIN_TOP]
    gj = to_geojson(ways)
    assert gj["features"], "등산로 0개: 범위나 쿼리를 확인"
    out = Path(__file__).with_name("trails.geojson")
    out.write_text(json.dumps(gj, separators=(",", ":")))
    print(f"받은 길 {len(osm['elements'])}개 중 저지대(최고 {MIN_TOP} m 미만) {len(osm['elements']) - len(ways)}개 제외 → "
          f"{len(ways)}개, {out.stat().st_size:,} B 저장 (OSM 기준 {osm['osm3s']['timestamp_osm_base']})")
