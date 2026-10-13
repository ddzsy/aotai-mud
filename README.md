# 鳌太穿越 · 极限省钱

静态 GitHub Pages 文字冒险：左侧为 **MapLibre GL JS** 卫星 3D 跟拍地图，右侧为游戏日志与操作。

## 地图与瓦片（无需 API Key）

| 用途 | 来源 | URL 模式 |
|------|------|----------|
| 卫星影像 | Esri World Imagery | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` |
| 地形 DEM | AWS Terrarium（Mapzen 遗产） | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` |
| 字体（标注） | MapLibre 演示字体 | `https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf` |

实现见 `map3d.js`：地形 `setTerrain` + 贴地路线 GeoJSON（红/白）、POI 圆点与中文标注、绿标玩家与累计公里数、随进度跟拍相机（pitch/bearing/zoom 由滑条控制）。

### 坐标

`points.json` 中各节点含 `lon`/`lat`（沿 schematic `x` 在真实锚点间插值，见 `scripts/fix-point-coords.py`）。旧版 Three.js 用的 `terrain-heightmap.png` / `terrain-meta.json` 仍保留在仓库中，但运行时不再加载。

### 离线 / 瓦片不可用时的备选

若 Esri 或 AWS 被网络策略拦截，可在 `map3d.js` 顶部替换为自托管瓦片，或改用需 Token 的 MapTiler / Mapbox 地形与影像（需在 `index.html` 中引入并配置 access token）。游戏逻辑不依赖地图即可继续（日志区照常）。

## 本地预览

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 部署

根目录含 `.nojekyll`，推送到 `main` 即可 GitHub Pages 托管。
