# 鳌太穿越 · 极限省钱

静态 GitHub Pages 文字冒险：左侧为 **MapLibre GL JS** 卫星示意地图，右侧为游戏日志与操作。

## 地图与瓦片（无需 API Key）

| 用途 | 来源 | URL 模式 |
|------|------|----------|
| 卫星影像 | Esri World Imagery | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` |

实现见 `map3d.js`：倾斜跟拍 + 贴地路线（红/白）、POI 圆点、绿点玩家；**不再**拉 Terrarium DEM 或 MapLibre 演示字体（减轻首屏与瓦片请求）。MapLibre 在点「出发上山」后才从 jsDelivr 加载。

### 坐标

`points.json` 中各节点含 `lon`/`lat`（沿 schematic `x` 在真实锚点间插值，见 `scripts/fix-point-coords.py`）。

可选：旧版 Three.js 高度图可由 `scripts/build-terrain.py` 生成到 `scripts/legacy/`，**不会**发布到 Pages。

## 本地预览

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 部署

根目录含 `.nojekyll`，推送到 `main` 即可 GitHub Pages 托管。运行时仅需：`index.html`、`map3d.js`、`points.json`、`game-data.json`、`bgm.mp3`。
