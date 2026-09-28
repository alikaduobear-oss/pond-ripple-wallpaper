/**
 * 壁纸窗口启动脚本 —— 初始化水面，并把主进程下发的鼠标事件接上去。
 * 注意：壁纸窗口是全屏点击穿透的，页面自己收不到 mousemove / mousedown，
 *      所以鼠标事件统一由主进程轮询后经 IPC 下发（见 preload.js）。
 */
(function () {
  const canvas = document.getElementById('water-canvas');
  if (!canvas) return;

  const water = window.initWater(canvas);
  if (!water) return;

  if (window.ripple) {
    // 光标位置 → 尾迹涟漪
    window.ripple.onMouse((p) => water.setPointer(p.x, p.y));
    // 左键点击 → 一圈一圈向外扩散的涟漪
    window.ripple.onClick((p) => water.clickAt(p.x, p.y));
    // 托盘「暂停 / 恢复」
    window.ripple.onPause(() => water.pause());
    window.ripple.onResume(() => water.resume());
  }

  console.log('[Ripple] 水面就绪');
})();