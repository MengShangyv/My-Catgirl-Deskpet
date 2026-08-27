'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AgentWatcher } = require('./src/watcher');

const CONFIG_PATH = path.join(os.homedir(), '.nya-pet', 'config.json');
const IDLE_TIMEOUT_DEFAULT = 3 * 60 * 1000;

// Windows 通知依赖 AppUserModelId，必须在 ready 前设置
app.setAppUserModelId('com.nya-pet.app');

// 内置 16x16 猫头图标（兜底用，保证 tray.png 缺失时托盘也能创建成功）
const TRAY_ICON_FALLBACK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAa0lEQVR42mNgoBbwsnb6D8JkqQMJ/N9+FYzxGYJTHboENkNg4gQNQDYEHaOrwaqZFAw2BMUAYgFWA0gFuAyA+xcNYIjTzAC8mojxArJm5MDCaQBKVJIagFiTKTmaMZIrDkBshmPAlZSxqQUA9shWs1PdTe0AAAAASUVORK5CYII=';

const MOOD_TEXT = { working: '干活中', done: '已完成', idle: '休息中' };

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

let petWin = null;
let detailWin = null;
let tray = null;
let watcher = null;
let paused = false;
let clickThrough = false;
let lastSnapshot = [];
let lastDoneSet = new Set();

function createPetWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  petWin = new BrowserWindow({
    width: 320,
    height: 420,
    x: width - 360,
    y: height - 460,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  petWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.on('closed', () => { petWin = null; });
}

function createDetailWindow() {
  if (detailWin) { detailWin.focus(); return; }
  detailWin = new BrowserWindow({
    width: 520,
    height: 600,
    title: '猫娘情报站',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  detailWin.loadFile(path.join(__dirname, 'renderer', 'detail.html'));
  detailWin.on('closed', () => { detailWin = null; });
  detailWin.webContents.on('did-finish-load', () => {
    if (detailWin && lastSnapshot.length) {
      detailWin.webContents.send('agents-update', lastSnapshot);
    }
  });
}

function petMood(agents) {
  if (!agents.length) return 'idle';
  const active = agents.filter(a => a.status === 'working');
  if (active.length) return 'working';
  const done = agents.filter(a => a.status === 'done');
  if (done.length) return 'done';
  return 'idle';
}

function broadcast(agents) {
  lastSnapshot = agents;
  // 托盘 tooltip 同步整体情绪
  if (tray) tray.setToolTip(`猫娘桌宠：${MOOD_TEXT[petMood(agents)] || '待命中'}`);
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('agents-update', agents);
  if (detailWin && !detailWin.isDestroyed()) detailWin.webContents.send('agents-update', agents);
}

function checkDoneNotifications(agents) {
  if (!Notification.isSupported()) return;
  const nowDone = new Set(agents.filter(a => a.status === 'done').map(a => a.sessionId));
  for (const id of nowDone) {
    if (!lastDoneSet.has(id)) {
      const a = agents.find(x => x.sessionId === id);
      const name = `${a.originator || 'codex'} · ${a.project || ''}`;
      new Notification({
        title: '喵！任务完成了 nya~',
        body: `${name}\n${a.summary || ''}`,
      }).show();
    }
  }
  lastDoneSet = nowDone;
}

function startWatcher() {
  const cfg = loadConfig();
  watcher = new AgentWatcher({
    // sessionRoots 缺失/为空数组时传 undefined，让 watcher 回退到默认 ~/.codex/sessions
    roots: Array.isArray(cfg.sessionRoots) && cfg.sessionRoots.length ? cfg.sessionRoots : undefined,
    idleTimeoutMs: cfg.idleTimeoutMs || IDLE_TIMEOUT_DEFAULT,
  });
  watcher.onChange((agents) => {
    if (paused) return;
    broadcast(agents);
    checkDoneNotifications(agents);
  });
  watcher.start();
}

ipcMain.on('open-detail', () => createDetailWindow());
ipcMain.on('pet-mood', (_e, mood) => {
  if (tray) tray.setToolTip(`猫娘桌宠：${MOOD_TEXT[mood] || mood}`);
});
ipcMain.on('toggle-click-through', (_e, enabled) => setClickThrough(!!enabled));

// 统一入口：穿透开启后宠物窗口收不到鼠标事件，只能从托盘恢复
function setClickThrough(enabled) {
  clickThrough = enabled;
  if (petWin && !petWin.isDestroyed()) {
    petWin.setIgnoreMouseEvents(enabled, { forward: true });
    // 同步渲染层状态（hint 文案），避免两边不一致
    petWin.webContents.send('click-through-changed', enabled);
  }
  if (tray) rebuildTrayMenu();
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'cats', 'tray.png');
  let img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  // tray.png 缺失/无效时用内置猫头图标兜底，避免空 buffer 在 Windows 上抛异常
  if (img.isEmpty()) img = nativeImage.createFromDataURL(TRAY_ICON_FALLBACK);
  tray = new Tray(img);
  rebuildTrayMenu();
  tray.setToolTip('猫娘桌宠');
  tray.on('double-click', () => createDetailWindow());
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示猫娘', click: () => petWin && petWin.show() },
    { label: '打开详情面板', click: () => createDetailWindow() },
    { type: 'separator' },
    { label: clickThrough ? '关闭点击穿透' : '开启点击穿透', click: () => setClickThrough(!clickThrough) },
    { label: paused ? '恢复监控' : '暂停监控', click: () => { paused = !paused; rebuildTrayMenu(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

app.whenReady().then(() => {
  createPetWindow();
  createTray();
  startWatcher();
  app.on('activate', () => { if (!petWin) createPetWindow(); });
});

app.on('window-all-closed', () => {
  // 桌宠常驻，仅托盘退出
});
