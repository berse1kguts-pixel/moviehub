'use strict';
/**
 * 生成应用图标（256×256 PNG 装入 ICO）并创建桌面快捷方式。
 * 纯 Node 实现：zlib 压 PNG，CRC32 手算，PNG-in-ICO（Vista+ 支持）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const S = 256;          // 图标尺寸
const SS = 3;           // 超采样抗锯齿

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y += 1) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function makeIco(png) {
  const dir = Buffer.alloc(22); // 6 字节头 + 16 字节目录项
  dir.writeUInt16LE(0, 0);   // reserved
  dir.writeUInt16LE(1, 2);   // type: 1 = icon
  dir.writeUInt16LE(1, 4);   // count
  dir[6] = 0;                // width 0 = 256
  dir[7] = 0;                // height 0 = 256
  dir[8] = 0;                // colorCount
  dir[9] = 0;                // reserved
  dir.writeUInt16LE(1, 10);  // planes
  dir.writeUInt16LE(32, 12); // bitCount
  dir.writeUInt32LE(png.length, 14); // bytesInRes
  dir.writeUInt32LE(22, 18);         // imageOffset
  return Buffer.concat([dir, png]);
}

/* ---------- 绘制 ---------- */
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/** 圆角矩形内的有符号距离（>0 在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const mx = Math.max(qx, 0); const my = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.sqrt(mx * mx + my * my) - r;
}
/** 点在三角形内（含边） */
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

const C1 = [0x6d, 0x7c, 0xff];   // --accent
const C2 = [0xa4, 0x5c, 0xff];   // --accent2
const DARK = [0x11, 0x15, 0x1f];

function sample(px, py) {
  const c = S / 2;
  const d = sdRoundRect(px, py, c, c, S / 2 - 10, S / 2 - 10, 58);
  if (d > 1.2) return [0, 0, 0, 0];

  // 对角渐变
  const t = Math.min(1, Math.max(0, ((px + py) / 2 - 12) / (S - 24)));
  let col = mix(C1, C2, t);

  // 左上柔光
  const glow = Math.max(0, 1 - Math.hypot(px - S * 0.3, py - S * 0.26) / (S * 0.72));
  col = mix(col, [255, 255, 255], glow * 0.22);

  // 底部压暗，增加立体感
  const shade = Math.max(0, (py - S * 0.62) / (S * 0.38));
  col = mix(col, DARK, shade * 0.28);

  // 播放三角形（带右下投影）
  const T = [
    [S * 0.355, S * 0.335],
    [S * 0.355, S * 0.665],
    [S * 0.645, S * 0.5],
  ];
  const sh = inTri(px - 5, py - 6, T[0][0], T[0][1], T[1][0], T[1][1], T[2][0], T[2][1]);
  const fg = inTri(px, py, T[0][0], T[0][1], T[1][0], T[1][1], T[2][0], T[2][1]);
  if (fg) col = [255, 255, 255];
  else if (sh) col = mix(col, DARK, 0.3);

  // 边缘抗锯齿：按到边缘距离混入透明
  const a = d > 0 ? Math.max(0, 1 - d / 1.2) : 1;
  return [col[0], col[1], col[2], Math.round(a * 255)];
}

const rgba = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y += 1) {
  for (let x = 0; x < S; x += 1) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += c[0]; g += c[1]; b += c[2]; a += c[3];
      }
    }
    const n = SS * SS;
    const i = (y * S + x) * 4;
    rgba[i] = Math.round(r / n); rgba[i + 1] = Math.round(g / n);
    rgba[i + 2] = Math.round(b / n); rgba[i + 3] = Math.round(a / n);
  }
}

const png = makePng(S, S, rgba);
const ico = makeIco(png);
const outIco = path.join(__dirname, 'icon.ico');
fs.writeFileSync(outIco, ico);
console.log('图标已生成: ' + outIco + ' (' + ico.length + ' bytes, PNG ' + png.length + ' bytes)');

/* ---------- 桌面快捷方式 ----------
 * 注意：不要用临时 .vbs + cscript 创建快捷方式——多数杀毒软件会把
 * 落盘的 VBS 当 HEUR:Trojan/VBS.StartPage.b 误杀，导致静默失败。
 * 直接用 PowerShell 的 WScript.Shell COM 对象，不落任何脚本文件。
 */
const appDir = __dirname;
const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const batFile = path.join(appDir, '桌面版启动.bat');
const useBat = !fs.existsSync(electronExe);
const target = useBat ? batFile : electronExe;
// PowerShell 单引号字符串：反斜杠是字面量，只需把内部单引号双写
const psStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const ps = [
  '$sh = New-Object -ComObject WScript.Shell',
  '$desk = $sh.SpecialFolders("Desktop")',
  '$lnk = $sh.CreateShortcut((Join-Path $desk "观影中心.lnk"))',
  '$lnk.TargetPath = ' + psStr(target),
  useBat ? '' : '$lnk.Arguments = "."',
  '$lnk.WorkingDirectory = ' + psStr(appDir),
  '$lnk.IconLocation = ' + psStr(outIco + ',0'),
  '$lnk.Description = "观影中心 - 本地影视聚合播放器"',
  '$lnk.WindowStyle = 1',
  '$lnk.Save()',
  'Write-Output $lnk.FullName',
].filter(Boolean).join('; ');

const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
console.log('快捷方式: ' + out.trim());
console.log('启动目标: ' + target + (useBat ? '（electron 未安装，走 bat 兜底）' : ' .'));
