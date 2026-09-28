/**
 * Pond Ripple Wallpaper — 桌面水波纹壁纸
 *
 * 只做一件事：把一块透明的水面铺在 Windows 桌面上，
 *   · 鼠标划过 → 带起一串尾迹涟漪
 *   · 鼠标左键点击 → 从点击处一圈一圈向外扩散
 *
 * 三条关键实现（缺一不可）：
 *   1. 窗口嵌入桌面 WorkerW（且位于 SHELLDLL_DefView 之下）→ 桌面图标依然可见可点
 *   2. 窗口点击穿透（setIgnoreMouseEvents(true, {forward:true})）→ 不挡任何桌面操作
 *   3. 因为点击穿透，渲染进程收不到鼠标事件 → 主进程每 40ms 轮询全局光标/左键，
 *      再把坐标下发给渲染进程（wallpaper:mouse / wallpaper:click）
 *
 * 依赖：electron、koffi（Win32 API）
 * 许可：MIT
 */
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

// 隐藏默认菜单栏，保持纯净
Menu.setApplicationMenu(null);

const ICON_PNG = path.join(__dirname, 'resources', 'icon.png');
const APP_NAME = 'Pond Ripple Wallpaper';

// ========== Win32（koffi）：桌面层嵌入 ==========
let user32 = null;
let FindWindowW, SendMessageTimeoutW, EnumWindows, FindWindowExW, SetParent,
    ShowWindow, SetWindowPos, SetWindowLongW, GetWindowLongW, GetAsyncKeyState, GetClassNameW;
let enumCallback = null;
try {
  const koffi = require('koffi');
  user32 = koffi.load('user32.dll');
  FindWindowW = user32.func('__stdcall', 'FindWindowW', 'void*', ['str16', 'str16']);
  SendMessageTimeoutW = user32.func('__stdcall', 'SendMessageTimeoutW', 'int64', ['void*', 'uint32', 'int64', 'int64', 'uint32', 'uint32', 'int64*']);
  const EnumWindowsProc = koffi.proto('int32 __stdcall EnumWindowsProc(void* hwnd, int64 lParam)');
  EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int32', [koffi.pointer(EnumWindowsProc), 'int64']);
  FindWindowExW = user32.func('__stdcall', 'FindWindowExW', 'void*', ['void*', 'void*', 'str16', 'str16']);
  SetParent = user32.func('__stdcall', 'SetParent', 'void*', ['void*', 'void*']);
  ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int32', ['void*', 'int32']);
  SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int32', ['void*', 'void*', 'int32', 'int32', 'int32', 'int32', 'uint32']);
  SetWindowLongW = user32.func('__stdcall', 'SetWindowLongW', 'int32', ['void*', 'int32', 'int32']);
  GetWindowLongW = user32.func('__stdcall', 'GetWindowLongW', 'int32', ['void*', 'int32']);
  GetAsyncKeyState = user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int32']);
  GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int32', ['void*', 'void*', 'int32']);
  enumCallback = koffi.register((hwnd) => {
    if (FindWindowExW(hwnd, null, 'SHELLDLL_DefView', null) !== null) {
      defViewParent = hwnd;
      return 0; // 找到图标层即停止枚举
    }
    return 1;
  }, koffi.pointer(EnumWindowsProc));
} catch (e) {
  console.error('[Desktop] 未加载到 koffi / user32，窗口将作为普通透明窗口显示（仅 Windows 支持桌面嵌入）:', e.message);
}

// HWND_BOTTOM = (HWND)1，必须传数值：koffi 传 Buffer 会变成「缓冲区地址」而非句柄值
const HWND_BOTTOM = 1;
const SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010;
const GWL_STYLE = -16;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;

// 同步等待（等 Explorer 异步重排桌面层级，仅启动时用一次）
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 承载桌面图标（SHELLDLL_DefView）的窗口句柄
let defViewParent = null;

/**
 * 把窗口嵌入桌面壁纸层，且必须位于图标层（SHELLDLL_DefView）之下。
 *   1. 向 Progman 发送 0x052C，触发 Windows 创建承载壁纸的 WorkerW
 *   2. 找到含 SHELLDLL_DefView 的窗口（图标层）
 *   3. 取「图标层之后」的那个顶层 WorkerW 作为父窗口（Z-order 更低，位于图标之下）
 *   4. 再置底兜底，确保绝不遮挡图标
 */
function embedIntoDesktop(win) {
  if (!user32) return false;
  try {
    const progman = FindWindowW('Progman', null);
    if (!progman) { console.error('[Desktop] 未找到 Progman'); return false; }
    const result = [0n];
    // 两种参数都发一次，兼容不同系统版本（只发 (0,0) 时部分系统不会重排桌面层级）
    SendMessageTimeoutW(progman, 0x052C, 0n, 0n, 0, 1000, result);
    SendMessageTimeoutW(progman, 0x052C, 0xDn, 0x1n, 0, 1000, result);

    defViewParent = null;
    EnumWindows(enumCallback, 0n);
    let workerw = null;
    if (defViewParent) workerw = FindWindowExW(null, defViewParent, 'WorkerW', null);
    if (!workerw) {
      // Explorer 重排桌面层级是异步的，等一会儿再找一次
      sleep(350);
      defViewParent = null;
      EnumWindows(enumCallback, 0n);
      if (defViewParent) workerw = FindWindowExW(null, defViewParent, 'WorkerW', null);
    }

    const target = workerw || defViewParent || progman;
    // Electron 返回的是缓冲区，必须取其中的句柄数值再传给 Win32，否则句柄无效
    const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));

    // 跨进程嵌入前必须先把窗口样式从 WS_POPUP 改成 WS_CHILD，否则 SetParent 不会生效
    const style = GetWindowLongW(hwnd, GWL_STYLE);
    SetWindowLongW(hwnd, GWL_STYLE, (style & ~WS_POPUP) | WS_CHILD);

    SetParent(hwnd, target);
    // 置于父窗口 Z-order 最底部，确保位于桌面图标层之下
    SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    ShowWindow(hwnd, 5);
    const cbuf = Buffer.alloc(256);
    const cn = GetClassNameW(target, cbuf, 128);
    console.log('[Desktop] 已嵌入桌面壁纸层，宿主:', cn ? cbuf.toString('utf16le', 0, cn * 2) : '?');
    return true;
  } catch (e) {
    console.error('[Desktop] 嵌入失败:', e.message);
    return false;
  }
}

// ========== 全局鼠标监听 ==========
// 壁纸窗口是点击穿透的，本身收不到 mousemove / mousedown，因此轮询真实的鼠标状态：
//   · 光标位置 → 下发给水面，形成「尾迹涟漪」
//   · 左键按下 → 把坐标下发给水面，触发「一圈一圈向外扩散」的涟漪
const VK_LBUTTON = 0x01;
let wallpaperWin = null;
function watchGlobalMouse() {
  if (!user32) return;
  let wasDown = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
  setInterval(() => {
    if (!wallpaperWin || wallpaperWin.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    const b = wallpaperWin.getBounds();
    const x = pt.x - b.x, y = pt.y - b.y;
    const inside = (x >= 0 && y >= 0 && x < b.width && y < b.height);
    if (inside) wallpaperWin.webContents.send('wallpaper:mouse', { x, y });
    const down = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
    if (down && !wasDown && inside) wallpaperWin.webContents.send('wallpaper:click', { x, y });
    wasDown = down;
  }, 40);
}

// ========== 壁纸窗口（铺满主屏，嵌入桌面） ==========
function createWallpaperWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;
  wallpaperWin = new BrowserWindow({
    width, height, x: display.bounds.x, y: display.bounds.y,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, closable: true,
    skipTaskbar: true, focusable: false, alwaysOnTop: false,
    show: false, backgroundColor: '#00000000', icon: ICON_PNG,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  wallpaperWin.loadFile(path.join(__dirname, 'renderer', 'wallpaper.html'));
  wallpaperWin.webContents.on('console-message', (e, level, msg) => console.log('[Wallpaper]', msg));
  wallpaperWin.once('ready-to-show', () => {
    wallpaperWin.show();
    // 点击穿透：鼠标事件透传给桌面图标，同时用 forward 保留事件转发
    wallpaperWin.setIgnoreMouseEvents(true, { forward: true });
    embedIntoDesktop(wallpaperWin);
    console.log('[Wallpaper] 壁纸窗口已启动');
  });
  wallpaperWin.on('closed', () => { wallpaperWin = null; });
}

// 暂停 / 恢复：停止渲染循环，桌面回到完全透明
let paused = false;
function setPaused(v) {
  paused = !!v;
  if (wallpaperWin && !wallpaperWin.isDestroyed()) {
    wallpaperWin.webContents.send(paused ? 'wallpaper:pause' : 'wallpaper:resume');
  }
}

// ========== 托盘（程序没有窗口、也没有界面菜单，靠托盘退出） ==========
let tray = null;
function createTray() {
  const icon = nativeImage.createFromPath(ICON_PNG).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      { label: paused ? '恢复水波纹' : '暂停水波纹', click: () => { setPaused(!paused); rebuild(); } },
      { type: 'separator' },
      { label: '退出', click: () => { app.quit(); } },
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();
  tray.on('click', () => setPaused(!paused));
}

// ========== IPC ==========
ipcMain.handle('app:quit', () => { app.quit(); });
ipcMain.handle('wallpaper:pause', () => { setPaused(true); return true; });
ipcMain.handle('wallpaper:resume', () => { setPaused(false); return true; });

// ========== 启动 ==========
app.whenReady().then(() => {
  createWallpaperWindow();
  watchGlobalMouse();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWallpaperWindow();
  });
});

// 关掉壁纸窗口不退出，托盘常驻；只有「退出」才真正退出
app.on('window-all-closed', () => {});
app.on('before-quit', () => { if (tray) { tray.destroy(); tray = null; } });