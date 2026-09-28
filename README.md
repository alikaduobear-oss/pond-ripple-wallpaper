# Pond Ripple Wallpaper · 桌面水波纹壁纸

> 桌面上只有水。鼠标划过带起一串尾迹，左键点击荡开一圈一圈向外扩散的涟漪。
> 没有金鱼、没有螃蟹、没有菜单 —— 只有水和你的鼠标。

主页：<https://pandyshop.top/wallpaper>

---

## 特性

- **真正的桌面壁纸层**：窗口嵌入 Windows 桌面的 `WorkerW`（且在 `SHELLDLL_DefView` 之下），
  桌面图标依旧可见、可点击、可框选。
- **完全点击穿透**：鼠标操作穿透到桌面，不挡开始菜单、不挡图标双击。
- **鼠标划过 → 尾迹涟漪**；**鼠标左键点击 → 一圈一圈向外扩散的涟漪**。
- **平静时完全透明**：水面 alpha 为 0，只有涟漪经过的地方才被绘制出来。
- **零外部资源**：水波由 WebGL 实时算出来，不加载任何图片 / 视频 / 音频。

## 环境要求

- Windows 10 / 11（桌面嵌入依赖 Win32 API，仅 Windows 可用）
- Node.js 18 及以上

## 快速开始

```bash
git clone https://github.com/alikaduobear-oss/pond-ripple-wallpaper.git
cd pond-ripple-wallpaper
npm install
npm start
```

启动后：

- 移动鼠标 → 桌面出现尾迹涟漪
- 点击桌面 → 从点击处扩散出一圈圈涟漪
- 右下角托盘图标 → 单击暂停 / 恢复，右键可退出

> 程序没有主窗口，退出请用托盘菜单的「退出」。

## 工作原理

壁纸窗口是透明、无边框、点击穿透的，也就是说它**收不到任何鼠标事件**。
所以整条链路是这样接起来的：

| 环节 | 做什么 |
| --- | --- |
| `main.js` → `embedIntoDesktop()` | 用 koffi 调 `user32.dll`：`SetParent` 到桌面 `WorkerW`，`SetWindowPos(HWND_BOTTOM)` 压到图标层之下 |
| `main.js` → `watchGlobalMouse()` | 每 40ms 轮询 `GetCursorScreenPoint()` 与 `GetAsyncKeyState(VK_LBUTTON)`，把坐标经 IPC 下发 |
| `preload.js` | 用 `contextBridge` 暴露 `onMouse` / `onClick` |
| `renderer/js/water.js` | WebGL2 高度场波浪模拟（2D 波动方程 GPU ping-pong），按坐标注入扰动并渲染 |

三个必须同时成立的细节，否则效果会「看不见」或「挡图标」：

1. 窗口样式要先从 `WS_POPUP` 改成 `WS_CHILD`，跨进程 `SetParent` 才生效；
2. 透明窗口必须 `premultipliedAlpha: true` 且 `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`，逐帧先清成透明；
3. alpha 不能掺入 Fresnel，否则整屏会蒙上一层灰；焦散只取正的拉普拉斯值，否则波谷会出现灰块。

## 目录结构

```
pond-ripple-wallpaper/
├─ main.js                 主进程：桌面层嵌入 + 全局鼠标轮询 + 托盘
├─ preload.js              IPC 桥（onMouse / onClick / onPause / onResume）
├─ renderer/
│  ├─ wallpaper.html       透明画布页面
│  └─ js/
│     ├─ boot.js           初始化水面并接上鼠标事件
│     └─ water.js          WebGL 水面与涟漪
├─ resources/icon.png      图标（窗口 / 托盘）
├─ package.json
├─ LICENSE
└─ README.md
```

## 调参

手感都在 [renderer/js/water.js](renderer/js/water.js) 顶部的常量里：

```js
const WAVE_HEIGHT = 0.014;      // 波高，调小更柔和
const DAMPING = 0.975;          // 阻尼，调小则涟漪衰减更快、停留更短
const TRAIL_STEP = 4;           // 光标移动多少像素才落一滴（尾迹密度）
const TRAIL_STRENGTH = 0.45;    // 尾迹强度
const RIPPLE = { waves: 3, waveGap: 0.42, life: 1.5, speed: 0.22, ... };  // 点击涟漪
```

改完 `renderer/js/*.js` 后记得把 `renderer/wallpaper.html` 里的 `?v=1` 提升一位，
避免 Chromium 磁盘缓存命中旧文件。

## 打包成 exe（可选）

仓库本身只带源码。想出一个绿色版 exe，可以自己加 `electron-builder`：

```bash
npm i -D electron-builder
npx electron-builder --win --dir
```

## 常见问题

- **桌面图标被盖住了？** 说明窗口没能嵌入 `WorkerW`（可能被安全软件拦了 `SetParent`）。
  看控制台是否打印了 `[Desktop] 已嵌入桌面壁纸层`。
- **鼠标划过没有反应？** 确认程序在运行（托盘有图标），并且鼠标确实在壁纸所在的显示器上 ——
  当前版本只铺主显示器。
- **多显示器？** 在 `main.js` 的 `createWallpaperWindow()` 里按 `screen.getAllDisplays()`
  逐屏建窗即可。

## 链接

- 项目主页：<https://pandyshop.top/wallpaper>
- 问题反馈：<https://github.com/alikaduobear-oss/pond-ripple-wallpaper/issues>

## License

[MIT](LICENSE)
