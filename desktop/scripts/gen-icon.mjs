// VoCat 桌面端 · 品牌图标生成器（零依赖）
//
// 把 build/icon.svg 用纯代码栅格化并编码为 PNG（node 内置 zlib），
// 避免在构建环境引入 SVG 渲染 / 原生图像库。
// 用法：node scripts/gen-icon.mjs [输出路径] [尺寸]
// 输出：默认 build/icon.png（1024×1024，RGB）。

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'build', 'icon.png'));
const SIZE = Number.parseInt(process.argv[3], 10) || 1024;

// ---------------------------------------------------------------------------
// 图形定义（与 build/icon.svg 逐一对应）
// ---------------------------------------------------------------------------

// 圆角矩形半径（24% 近似 SVG 的 rx=224 @1024）
const RADIUS = Math.round(SIZE * 0.219);

// 背景渐变端点（SVG linearGradient 对角方向）
const GRAD_START = [0x5b, 0x4d, 0xf0]; // #5B4DF0
const GRAD_END = [0x37, 0x29, 0xc4];   // #3729C4

// V 形多边形顶点（SVG path 等比缩放）
const vPolygon = [
  [240, 300], [512, 724], [784, 300], [784, 252], [512, 676], [240, 252],
].map(([x, y]) => [Math.round((x / 1024) * SIZE), Math.round((y / 1024) * SIZE)]);

// 底部信号圆点（SVG circle，r=58@1024）
const CIR = { x: (512 / 1024) * SIZE, y: (790 / 1024) * SIZE, r: (58 / 1024) * SIZE };

// ---------------------------------------------------------------------------
// 几何判定
// ---------------------------------------------------------------------------

function insideRoundedRect(x, y) {
  const r = RADIUS;
  const max = SIZE - 1;
  if (x < 0 || y < 0 || x > max || y > max) return false;
  const xr = Math.min(x, max - x);
  const yr = Math.min(y, max - y);
  if (xr >= r || yr >= r) return true; // 中心矩形区域
  // 角落圆弧：到圆心的距离
  const cx = x < SIZE / 2 ? r : max - r;
  const cy = y < SIZE / 2 ? r : max - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function insideCircle(x, y) {
  return (x - CIR.x) ** 2 + (y - CIR.y) ** 2 <= CIR.r * CIR.r;
}

// ---------------------------------------------------------------------------
// 渲染（2×2 超采样抗锯齿）
// ---------------------------------------------------------------------------

function sample(x, y) {
  if (!insideRoundedRect(x, y)) return null; // 透明 → 输出前跳过
  if (insidePolygon(x, y, vPolygon) || insideCircle(x, y)) return [255, 255, 255];
  const t = Math.min(1, Math.max(0, (x + y) / (2 * (SIZE - 1))));
  return [
    Math.round(GRAD_START[0] + (GRAD_END[0] - GRAD_START[0]) * t),
    Math.round(GRAD_START[1] + (GRAD_END[1] - GRAD_START[1]) * t),
    Math.round(GRAD_START[2] + (GRAD_END[2] - GRAD_START[2]) * t),
  ];
}

function renderPixels() {
  // 超采样 2×2：单个像素取 4 个子样本平均（含透明背景需混合）
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  const SS = 2;
  let offset = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const color = sample(px, py);
          if (color) {
            r += color[0]; g += color[1]; b += color[2]; hits++;
          }
        }
      }
      if (hits > 0) {
        rgb[offset] = Math.round(r / hits);
        rgb[offset + 1] = Math.round(g / hits);
        rgb[offset + 2] = Math.round(b / hits);
      }
      // 全透明子样本 → 黑色占位（图标实际为不透明设计，仅角外区域）
      offset += 3;
    }
  }
  return rgb;
}

// ---------------------------------------------------------------------------
// PNG 编码（RGBA 字节流 → 文件）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function encodePNG(rgb, size) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

const pixels = renderPixels();
const png = encodePNG(pixels, SIZE);
writeFileSync(output, png);
console.log(`icon written: ${output} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KiB)`);