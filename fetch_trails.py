"""승학산 주변 등산로를 OSM(Overpass)에서 받아 trails.geojson으로 저장한다.

브라우저에서 매번 Overpass를 부르면 5~35초 걸리거나 502가 나서, 미리 받아 파일로 둔다.
실행: python3 fetch_trails.py
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

CENTER = (128.9798, 35.1168)  # index.html의 START와 같게 유지
R = 0.03  # 약 ±3 km
S, W, N, E = CENTER[1] - R, CENTER[0] - R, CENTER[1] + R, CENTER[0] + R
# footway의 절반 이상이 시내 보도·횡단보도라서 제외
QUERY = (f'[out:json][timeout:60];way["highway"~"^(path|footway|steps)$"]'
         f'["footway"!~"^(sidewalk|crossing)$"]({S},{W},{N},{E});out geom;')
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


def to_geojson(osm):
    # 소수 5자리 ≈ 1 m: 30 m DEM 위에 그리기엔 충분하고 파일이 1/3로 줄어듦
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": {
            "type": "LineString",
            "coordinates": [[round(p["lon"], 5), round(p["lat"], 5)] for p in w["geometry"]]}}
        for w in osm["elements"]]}


if __name__ == "__main__":
    osm = fetch()
    gj = to_geojson(osm)
    assert gj["features"], "등산로 0개: 범위나 쿼리를 확인"
    out = Path(__file__).with_name("trails.geojson")
    out.write_text(json.dumps(gj, separators=(",", ":")))
    print(f"{len(gj['features'])}개 길, {out.stat().st_size:,} B 저장 (OSM 기준 {osm['osm3s']['timestamp_osm_base']})")
