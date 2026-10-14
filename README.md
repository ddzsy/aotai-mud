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

## 沟口检查站（拦截问询）

- 每次进入检查站只抽 **1** 道安全题（`game-data.json` → `intercept.questionCount` / `minCorrect`）。
- **答错**：一律依法劝返（官方结局）。
- **答对**：仍可能因抽检被劝返。概率只看玩家**点击提交答案那一刻**的系统时钟秒数：`new Date().getSeconds() < 9`（秒数为 0–8 时遣返，共 9/60≈**15%**）。不再叠加负重、节假日、`slipThrough` 等旧随机因子。
- 被劝返时日志与结局文案会显示：「既然这么懂事就快回去吧。」

## 部署

根目录含 `.nojekyll`，推送到 `main` 即可 GitHub Pages 托管。运行时仅需：`index.html`、`map3d.js`、`points.json`、`game-data.json`、`bgm.mp3`（由 `bgm.mid` 离线渲染；旧版 BGM 保留为 `bgm-backup.mp3`）。

## 隐藏彩蛋：检查站「溜走」

沟口检查站的安全问询弹窗中，有一条**不会写在教程里**的出路：

1. **前提**：你曾在某一局里被工作人员**依法劝返**（答错、抽检命中等，触发「劝返成功 · 官方结局」）。游戏会把这一经历记在浏览器 `localStorage` 键 `aotai_prior_turnback` 中；点「再来一局」刷新页面后仍然有效。
2. **触发**：在**之后任意一局**再次来到沟口检查站、问询弹窗打开时，若你**连续约 5 秒不点任何选项**，选项列表底部会出现 **「溜走」**（首次被劝返之前的玩家不会出现）。
3. **效果**：选择「溜走」等同于混过检查站：设置 `checkpointPassed` 并进入正常上山流程（与问询过关后相同的 `afterInterceptPassed`），并解锁成就 **「脚底抹油」**。
4. **计时**：一旦点击任一正常选项，5 秒计时会清除；弹窗关闭时也会清除，避免残留按钮影响手机端布局。

现实里请守法穿越；彩蛋仅供熟手会心一笑。
