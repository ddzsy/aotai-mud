#!/usr/bin/env python3
"""沿 schematic x 在锚点间线性插值，修正鳌太线各点 WGS84 坐标。"""
import json
from pathlib import Path

ANCHORS = [
    (49.5, 107.7683, 34.0265),
    (149.1, 107.761605, 34.014475),
    (195.5, 107.758, 34.008),
    (207.6, 107.761, 34.012),
    (271.4, 107.75575, 34.0015),
    (374.5, 107.754, 33.998),
    (481.1, 107.748, 33.992),
    (507.4, 107.7465, 33.988),
    (581.6, 107.805, 34.015),
    (656.8, 107.812, 34.008),
    (710.3, 107.779, 33.9517),
    (732.0, 107.769, 33.958),
    (761.8, 107.770, 33.942),
    (899.3, 107.65, 33.915),
    (1011.4, 107.597, 33.908),
]


def interp(x: float, anchors):
    if x <= anchors[0][0]:
        return anchors[0][1], anchors[0][2]
    if x >= anchors[-1][0]:
        return anchors[-1][1], anchors[-1][2]
    for i in range(len(anchors) - 1):
        x0, lon0, lat0 = anchors[i]
        x1, lon1, lat1 = anchors[i + 1]
        if x0 <= x <= x1:
            t = (x - x0) / (x1 - x0) if x1 != x0 else 0
            lon = lon0 + t * (lon1 - lon0)
            lat = lat0 + t * (lat1 - lat0)
            return round(lon, 6), round(lat, 6)
    return anchors[-1][1], anchors[-1][2]


def main():
    path = Path(__file__).resolve().parents[1] / "points.json"
    pts = json.loads(path.read_text(encoding="utf-8"))
    for p in pts:
        lon, lat = interp(float(p["x"]), ANCHORS)
        p["lon"] = lon
        p["lat"] = lat
    path.write_text(json.dumps(pts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("updated", len(pts), "points")


if __name__ == "__main__":
    main()
