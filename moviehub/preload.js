'use strict';
/** 预加载脚本：向网页暴露最小化的桌面环境标识（contextIsolation 安全模式） */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
});
