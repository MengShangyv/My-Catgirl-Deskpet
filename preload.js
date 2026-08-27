'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nyaPet', {
  onAgentsUpdate: (fn) => {
    ipcRenderer.on('agents-update', (_e, agents) => fn(agents));
  },
  // 主进程（托盘菜单）切换点击穿透时同步状态到渲染层
  onClickThroughChanged: (fn) => {
    ipcRenderer.on('click-through-changed', (_e, enabled) => fn(enabled));
  },
  openDetail: () => ipcRenderer.send('open-detail'),
  toggleClickThrough: (enabled) => ipcRenderer.send('toggle-click-through', enabled),
});
