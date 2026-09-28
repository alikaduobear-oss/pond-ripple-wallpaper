/**
 * 预加载脚本 — 通过 contextBridge 向渲染进程暴露受限 IPC 接口
 * 壁纸窗口只需要两件事：主进程轮询到的鼠标位置 / 左键点击。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ripple', {
  // 主进程全局鼠标位置（壁纸窗口点击穿透，收不到 mousemove）→ 尾迹涟漪
  onMouse: (cb) => ipcRenderer.on('wallpaper:mouse', (_, p) => cb(p)),
  // 主进程全局左键点击 → 一圈一圈向外扩散的涟漪
  onClick: (cb) => ipcRenderer.on('wallpaper:click', (_, p) => cb(p)),
  // 暂停 / 恢复
  onPause: (cb) => ipcRenderer.on('wallpaper:pause', () => cb()),
  onResume: (cb) => ipcRenderer.on('wallpaper:resume', () => cb()),
});