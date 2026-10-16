'use strict';
/**
 * 桌面端入口：启动本地服务并打开应用窗口。
 * 运行：npx electron .   （或双击 桌面版启动.bat）
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');

function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.end(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

async function freePort(start) {
  let p = start;
  for (let i = 0; i < 20; i += 1, p += 1) {
    if (!(await probe(p))) return p;
  }
  return p;
}

let win = null;

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: '观影中心',
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  win.loadURL('http://127.0.0.1:' + port + '/');
  // 加载失败时明确告知，而不是白屏
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[桌面端] 页面加载失败 ' + code + ' ' + desc + ' ' + url);
    if (win && !win.isDestroyed()) {
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        '<body style="font-family:system-ui;background:#0b0e14;color:#e8ecf4;display:flex;' +
        'align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">' +
        '<div><h2>页面加载失败</h2><p style="color:#9aa4b8">' + desc + '</p>' +
        '<p style="color:#9aa4b8">本地服务端口：' + port + '</p></div></body>'));
    }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  const base = Number(process.env.PORT || 7000);
  const port = await freePort(base);
  process.env.PORT = String(port);
  const server = require('./server.js');
  await server.start(port);
  createWindow(port);
  console.log('[桌面端] 窗口已打开，端口 ' + port);
});

app.on('window-all-closed', () => {
  app.quit();
});
