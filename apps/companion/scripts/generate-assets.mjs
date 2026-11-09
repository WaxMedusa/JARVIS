#!/usr/bin/env node
/**
 * Generate the companion's visual identity with a tiny, dependency-free PNG
 * encoder. The app icon is a dark rounded square with a luminous arc reactor;
 * the tray icons are alpha-only templates that macOS tints automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'build');
fs.mkdirSync(outDir, {recursive: true});

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
function roundRectDistance(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}
function segmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const t = length ? clamp(((px - x1) * dx + (py - y1) * dy) / length) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function blend(base, color, alpha) {
  return [
    mix(base[0], color[0], alpha),
    mix(base[1], color[1], alpha),
    mix(base[2], color[2], alpha),
  ];
}

function drawAppIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const scale = size / 1024;
  const half = 476 * scale;
  const radius = 214 * scale;
  const outerRadius = 258 * scale;
  const innerRadius = 150 * scale;
  const coreRadius = 64 * scale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const shape = roundRectDistance(px, py, cx, cy, half, half, radius);
      const alpha = 1 - smooth(-1.1, 1.1, shape);
      if (alpha <= 0.001) continue;

      const t = clamp(py / size);
      let color = [mix(9, 3, t), mix(23, 8, t), mix(34, 13, t)];
      const dx = px - cx;
      const dy = py - cy;
      const distance = Math.hypot(dx, dy);

      // Soft teal bloom behind the reactor.
      const bloom = Math.exp(-((distance / (330 * scale)) ** 2)) * 0.3;
      color = [color[0] + 12 * bloom, color[1] + 54 * bloom, color[2] + 70 * bloom];

      // Hairline rim light.
      const rim = 1 - smooth(0, 2.4 * scale, Math.abs(shape + 1.2 * scale));
      color = blend(color, [93, 218, 244], rim * 0.2);

      // Outer halo and ring.
      const halo = 1 - smooth(0, 28 * scale, Math.abs(distance - outerRadius));
      color = blend(color, [35, 173, 203], halo * 0.12);
      const outerRing = 1 - smooth(0, 1.8 * scale, Math.abs(Math.abs(distance - outerRadius) - 15 * scale));
      color = blend(color, [118, 232, 255], outerRing * 0.9);

      // Eight reactor spokes.
      const spokeStart = 108 * scale;
      const spokeEnd = 218 * scale;
      for (let index = 0; index < 8; index += 1) {
        const angle = (Math.PI * 2 * index) / 8 + Math.PI / 8;
        const inner = Math.abs(distance - (spokeStart + spokeEnd) / 2) < (spokeEnd - spokeStart) / 2 + 2 * scale;
        if (!inner) continue;
        const d = segmentDistance(
          px,
          py,
          cx + Math.cos(angle) * spokeStart,
          cy + Math.sin(angle) * spokeStart,
          cx + Math.cos(angle) * spokeEnd,
          cy + Math.sin(angle) * spokeEnd,
        );
        const spoke = 1 - smooth(2.5 * scale, 5.5 * scale, d);
        color = blend(color, [91, 225, 251], spoke * 0.82);
      }

      // Inner ring and bright core.
      const innerRing = 1 - smooth(0, 1.5 * scale, Math.abs(distance - innerRadius));
      color = blend(color, [111, 230, 255], innerRing * 0.7);
      const coreGlow = 1 - smooth(0, 46 * scale, Math.abs(distance - coreRadius));
      color = blend(color, [72, 208, 238], coreGlow * 0.4);
      const core = 1 - smooth(0, 1.4 * scale, distance - coreRadius);
      color = blend(color, [242, 254, 255], core * 0.98);
      const hot = 1 - smooth(0, 20 * scale, distance);
      color = blend(color, [255, 255, 255], hot * 0.9);

      // Subtle inner vignette at the bottom.
      color = [
        color[0] * (1 - 0.12 * t),
        color[1] * (1 - 0.08 * t),
        color[2] * (1 - 0.04 * t),
      ];

      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(clamp(color[0], 0, 255));
      pixels[offset + 1] = Math.round(clamp(color[1], 0, 255));
      pixels[offset + 2] = Math.round(clamp(color[2], 0, 255));
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function drawTray(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const unit = size / 22;
  const ringRadius = 7.4 * unit;
  const width = 1.6 * unit;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const distance = Math.hypot(px - cx, py - cy);
      let alpha = 0;

      const ring = 1 - smooth(0, 0.9, Math.abs(Math.abs(distance - ringRadius) - width));
      alpha = Math.max(alpha, ring);
      for (let index = 0; index < 8; index += 1) {
        const angle = (Math.PI * 2 * index) / 8;
        const d = segmentDistance(
          px,
          py,
          cx + Math.cos(angle) * 2.4 * unit,
          cy + Math.sin(angle) * 2.4 * unit,
          cx + Math.cos(angle) * 5.2 * unit,
          cy + Math.sin(angle) * 5.2 * unit,
        );
        alpha = Math.max(alpha, 1 - smooth(0.5 * unit, 1.1 * unit, d));
      }
      const core = 1 - smooth(0, 1.4 * unit, distance - 1.5 * unit);
      alpha = Math.max(alpha, core);
      const offset = (y * size + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = Math.round(clamp(alpha) * 255);
    }
  }
  return {pixels, width: size, height: size};
}

fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(1024, 1024, drawAppIcon(1024)));
for (const [name, size] of [['trayTemplate.png', 22], ['trayTemplate@2x.png', 44]]) {
  const tray = drawTray(size);
  fs.writeFileSync(path.join(outDir, name), encodePng(tray.width, tray.height, tray.pixels));
}
console.log(`Generated ${path.relative(process.cwd(), path.join(outDir, 'icon.png'))}, trayTemplate.png and trayTemplate@2x.png`);
