// 托盘右键菜单小窗的渲染桥:只暴露数据接收/画完回执/点击/关闭四个口
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('trayapi', {
  onData: (cb) => ipcRenderer.on('tray-menu:data', (e, p) => cb(p)),
  ready: () => ipcRenderer.send('tray-menu:ready'),
  click: (id) => ipcRenderer.send('tray-menu:click', id),
  hide: () => ipcRenderer.send('tray-menu:hide'),
});
