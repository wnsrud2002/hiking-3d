"""산 주변 고도 타일로 등고선을 계산해 data/<산>/contours.geojson으로 저장한다 (표준 라이브러리만).

실행: python3 make_contours.py [산 id]   (mountains.json의 id, 기본 seunghak)
자체 검사: python3 make_contours.py --test
"""
import json
import math
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

# 산 목록은 앱(index.html)과 같은 mountains.json에서 읽음. fetch_trails.py도 이 값을 가져다 씀
MOUNTAINS = json.loads(Path(__file__).with_name("mountains.json").read_text())
MOUNTAIN = next(m for m in MOUNTAINS if m["id"] == next((a for a in sys.argv[1:] if not a.startswith("-")), "seunghak"))
CENTER, R = tuple(MOUNTAIN["center"]), MOUNTAIN["r"]  # R: 중심에서 위경도 ± 범위 (0.03 ≈ 3 km)
OUT = Path(__file__).with_name("data") / MOUNTAIN["id"]
Z = 14  # 원본이 30 m DEM이라 z14(약 7.8 m/px)면 충분. z15는 계산량만 4배
STEP = 10  # m, 등고선 간격
MIN_LEN = 100  # m. 평지·시가지의 고도 노이즈가 만드는 작은 고리 제거
TOL = 2.0  # m. 선 단순화 허용 오차 (Douglas-Peucker)
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"


def decode_terrarium(png):
    """PNG(8비트 RGB/RGBA)를 풀어 고도(m) 2차원 리스트로."""
    p, idat = 8, b""
    while p < len(png):
        n, kind = struct.unpack(">I4s", png[p:p + 8])
        chunk = png[p + 8:p + 8 + n]
        if kind == b"IHDR":
            w, h, depth, color = struct.unpack(">IIBB", chunk[:10])
            assert depth == 8 and color in (2, 6), "지원 안 하는 PNG 형식"
        elif kind == b"IDAT":
            idat += chunk
        p += 12 + n
    raw, bpp = zlib.decompress(idat), 3 if color == 2 else 4
    stride, prev, rows, i = w * bpp, bytearray(w * bpp), [], 0
    for _ in range(h):
        f, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):  # PNG 필터 복원
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append([line[k * bpp] * 256 + line[k * bpp + 1] + line[k * bpp + 2] / 256 - 32768 for k in range(w)])
        prev = line
    return rows


# 칸 네 모서리(왼위 a, 오위 b, 오아래 c, 왼아래 d) 중 기준 이상인 것의 비트 → 선이 지나는 변 쌍
# 변: T(위) R(오른쪽) B(아래) L(왼쪽). 5·10은 안장점이라 칸 중앙값으로 따로 처리
CASES = {1: [("L", "B")], 2: [("B", "R")], 3: [("L", "R")], 4: [("T", "R")], 6: [("T", "B")],
         7: [("T", "L")], 8: [("T", "L")], 9: [("T", "B")], 11: [("T", "R")], 12: [("L", "R")],
         13: [("B", "R")], 14: [("L", "B")]}


def contours(g, step):
    """marching squares. g[y][x] 고도 격자 → {높이: [[(x, y), ...], ...]} (픽셀 좌표)."""
    segs = {}
    for j in range(len(g) - 1):
        r0, r1 = g[j], g[j + 1]
        for i in range(len(r0) - 1):
            a, b, c, d = r0[i], r0[i + 1], r1[i + 1], r1[i]
            lo, hi = min(a, b, c, d), max(a, b, c, d)
            level = (math.floor(lo / step) + 1) * step
            while level <= hi:
                k = (a >= level) << 3 | (b >= level) << 2 | (c >= level) << 1 | (d >= level)
                if k in (5, 10):
                    up = (a + b + c + d) / 4 >= level
                    pairs = [("T", "L"), ("B", "R")] if (k == 5) == up else [("T", "R"), ("L", "B")]
                else:
                    pairs = CASES[k]
                # 변을 이웃 칸과 공유하는 이름으로 → 나중에 선분을 정확히 이어 붙일 수 있음
                edge = {"T": ("h", i, j), "B": ("h", i, j + 1), "L": ("v", i, j), "R": ("v", i + 1, j)}
                segs.setdefault(level, []).extend((edge[p], edge[q]) for p, q in pairs)
                level += step
    out = {}
    for level, ss in segs.items():
        def point(e):
            kind, i, j = e
            v0, v1 = (g[j][i], g[j][i + 1]) if kind == "h" else (g[j][i], g[j + 1][i])
            t = (level - v0) / (v1 - v0)
            return (i + t, j) if kind == "h" else (i, j + t)
        out[level] = [[point(e) for e in chain] for chain in stitch(ss)]
    return out


def stitch(segs):
    """같은 변을 공유하는 선분들을 이어 긴 선으로."""
    adj = {}
    for n, (e1, e2) in enumerate(segs):
        adj.setdefault(e1, []).append(n)
        adj.setdefault(e2, []).append(n)
    used, chains = set(), []
    for n, s in enumerate(segs):
        if n in used:
            continue
        used.add(n)
        chain = list(s)
        for _ in range(2):  # 한쪽 끝으로 늘리고, 뒤집어서 반대쪽으로
            while (m := next((m for m in adj[chain[-1]] if m not in used), None)) is not None:
                used.add(m)
                e1, e2 = segs[m]
                chain.append(e2 if e1 == chain[-1] else e1)
            chain.reverse()
        chains.append(chain)
    return chains


def simplify(pts, tol):
    """Douglas-Peucker (반복문 버전: 긴 선에서 재귀 깊이 초과 방지)."""
    if len(pts) < 3:
        return pts
    keep, stack = {0, len(pts) - 1}, [(0, len(pts) - 1)]
    while stack:
        s, e = stack.pop()
        (x1, y1), (x2, y2) = pts[s], pts[e]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy)
        best, idx = 0, None
        for k in range(s + 1, e):
            x, y = pts[k]
            dist = abs(dy * (x - x1) - dx * (y - y1)) / norm if norm else math.hypot(x - x1, y - y1)
            if dist > best:
                best, idx = dist, k
        if idx is not None and best > tol:
            keep.add(idx)
            stack += [(s, idx), (idx, e)]
    return [pts[k] for k in sorted(keep)]


def tile_xy(lon, lat):
    n = 2 ** Z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


def lonlat(px, py):
    n = 2 ** Z * 256
    return px / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / n))))


def main():
    W, S, E, N = CENTER[0] - R, CENTER[1] - R, CENTER[0] + R, CENTER[1] + R
    (x0, y0), (x1, y1) = tile_xy(W, N), tile_xy(E, S)
    gx0, gy0, gx1, gy1 = int(x0 * 256), int(y0 * 256), int(x1 * 256) + 1, int(y1 * 256) + 1
    grid = [[0.0] * (gx1 - gx0) for _ in range(gy1 - gy0)]
    tiles = [(tx, ty) for ty in range(int(y0), int(y1) + 1) for tx in range(int(x0), int(x1) + 1)]
    for tx, ty in tiles:
        req = urllib.request.Request(URL.format(z=Z, x=tx, y=ty), headers={"User-Agent": "hiking-3d"})
        rows = decode_terrarium(urllib.request.urlopen(req, timeout=30).read())
        for py in range(max(gy0, ty * 256), min(gy1, ty * 256 + 256)):
            for px in range(max(gx0, tx * 256), min(gx1, tx * 256 + 256)):
                grid[py - gy0][px - gx0] = rows[py - ty * 256][px - tx * 256]
    # 낙동강변에 -1000 m대로 튀는 외톨이 픽셀(타일 결측)이 수백 개 있음 → 주변 8칸 중앙값으로 메움
    fixed = 0
    for y, row in enumerate(grid):
        for x, v in enumerate(row):
            if v < -100:
                nb = sorted(grid[y + dy][x + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                            if (dy or dx) and 0 <= y + dy < len(grid) and 0 <= x + dx < len(row) and grid[y + dy][x + dx] >= -100)
                row[x] = nb[len(nb) // 2] if nb else 0.0
                fixed += 1
    print(f"타일 {len(tiles)}개 → 격자 {gx1 - gx0}x{gy1 - gy0}, 튀는 픽셀 {fixed}개 보정, "
          f"고도 {min(map(min, grid)):.0f}~{max(map(max, grid)):.0f} m")

    m_per_px = 40075016.686 * math.cos(math.radians(CENTER[1])) / (2 ** Z * 256)
    features, dropped = [], 0
    for level, lines in sorted(contours(grid, STEP).items()):
        if level <= 0:  # 강·바다 높이 노이즈
            continue
        for line in lines:
            length = sum(math.dist(p, q) for p, q in zip(line, line[1:])) * m_per_px
            if length < MIN_LEN:
                dropped += 1
                continue
            # 픽셀 값은 칸 중심 기준이라 +0.5
            coords = [[round(v, 5) for v in lonlat(gx0 + x + 0.5, gy0 + y + 0.5)] for x, y in simplify(line, TOL / m_per_px)]
            features.append({"type": "Feature", "properties": {"ele": level}, "geometry": {"type": "LineString", "coordinates": coords}})
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / "contours.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    print(f"등고선 {len(features)}개 (짧은 선 {dropped}개 제거), {out.stat().st_size:,} B 저장")


def test():
    # 원뿔: 높이 = 100 - 중심까지 거리 → 50 m 등고선은 반지름 50 px 닫힌 원이어야 함
    g = [[100 - math.hypot(x - 60, y - 60) for x in range(121)] for y in range(121)]
    rings = contours(g, 50)[50]
    assert len(rings) == 1 and rings[0][0] == rings[0][-1], "닫힌 고리 1개여야 함"
    err = max(abs(math.hypot(x - 60, y - 60) - 50) for x, y in rings[0])
    assert err < 0.3, err
    # 안장점: 대각선 봉우리 a·c(100 m), 골 b·d(0 m), 칸 중앙 평균 50 m
    g2 = [[100.0, 0.0], [0.0, 100.0]]
    rnd = lambda lines: sorted(sorted((round(x, 3), round(y, 3)) for x, y in ln) for ln in lines)
    assert [(0, 0.45), (0.45, 0)] in rnd(contours(g2, 55)[55])  # 55 > 50 → 봉우리 a가 따로 떨어짐
    assert [(0.55, 0), (1, 0.45)] in rnd(contours(g2, 45)[45])  # 45 < 50 → 골 b가 따로 떨어짐
    print(f"자체 검사 통과 (원 반지름 최대 오차 {err:.3f} px)")


if __name__ == "__main__":
    test() if "--test" in sys.argv else main()
