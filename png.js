// png.js — 最小 PNG 解码器：直接输出未预乘的 RGBA 像素
// 目的：绕开 createImageBitmap/canvas 的预乘往返与色彩管理，保证与 imgctl 解码逐字节一致
// 支持：8/16 位深度，colorType 0/2/3/4/6，非隔行；tRNS 透明色/调色板透明
(function () {
  'use strict';

  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  async function inflate(data) {
    // PNG IDAT = zlib 流（deflate + adler32），DecompressionStream('deflate') 即 zlib
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  // 返回 { width, height, data:Uint8ClampedArray(RGBA), hasAlpha }
  async function decode(buffer) {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    for (let i = 0; i < 8; i++) {
      if (u8[i] !== SIG[i]) throw new Error('not a PNG');
    }
    let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0;
    const idatChunks = [];
    let palette = null, trns = null;
    let pos = 8;
    while (pos + 8 <= u8.length) {
      const len = (u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3];
      const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
      const dataStart = pos + 8;
      if (type === 'IHDR') {
        width = (u8[dataStart] << 24) | (u8[dataStart + 1] << 16) | (u8[dataStart + 2] << 8) | u8[dataStart + 3];
        height = (u8[dataStart + 4] << 24) | (u8[dataStart + 5] << 16) | (u8[dataStart + 6] << 8) | u8[dataStart + 7];
        bitDepth = u8[dataStart + 8];
        colorType = u8[dataStart + 9];
        interlace = u8[dataStart + 12];
      } else if (type === 'PLTE') {
        palette = u8.slice(dataStart, dataStart + len);
      } else if (type === 'tRNS') {
        trns = u8.slice(dataStart, dataStart + len);
      } else if (type === 'IDAT') {
        idatChunks.push(u8.slice(dataStart, dataStart + len));
      } else if (type === 'IEND') {
        break;
      }
      pos = dataStart + len + 4; // 跳过 CRC
    }
    if (!width || !height) throw new Error('bad IHDR');
    if (interlace) throw new Error('interlaced PNG unsupported');
    if (bitDepth !== 8 && bitDepth !== 16) throw new Error('bitDepth ' + bitDepth + ' unsupported');

    const raw = await inflate(concat(idatChunks));
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error('colorType ' + colorType + ' unsupported');
    const bytesPerSample = bitDepth === 16 ? 2 : 1;
    const stride = width * channels * bytesPerSample;

    // 反滤波（left/ul 必须回退一个完整像素的字节数 bpp = channels * bytesPerSample）
    const bpp = channels * bytesPerSample;
    const out = new Uint8Array(stride * height);
    let rp = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[rp++];
      const row = y * stride;
      for (let x = 0; x < stride; x++) {
        const rawv = raw[rp + x];
        const left = x >= bpp ? out[row + x - bpp] : 0;
        const up = y > 0 ? out[row - stride + x] : 0;
        const ul = (y > 0 && x >= bpp) ? out[row - stride + x - bpp] : 0;
        let v;
        switch (filter) {
          case 0: v = rawv; break;
          case 1: v = rawv + left; break;
          case 2: v = rawv + up; break;
          case 3: v = rawv + ((left + up) >> 1); break;
          case 4: v = rawv + paeth(left, up, ul); break;
          default: throw new Error('filter ' + filter);
        }
        out[row + x] = v & 0xFF;
      }
      rp += stride;
    }

    // 组装 RGBA（16 位取高字节）
    const rgba = new Uint8ClampedArray(width * height * 4);
    const hasAlpha = colorType === 4 || colorType === 6;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const si = y * stride + x * channels * bytesPerSample;
        const di = (y * width + x) * 4;
        let r, g, b, a;
        if (colorType === 0) {
          const v = bitDepth === 16 ? (out[si] << 8 | out[si + 1]) >> 8 : out[si];
          r = g = b = v; a = 255;
        } else if (colorType === 2) {
          r = bitDepth === 16 ? (out[si] << 8 | out[si + 1]) >> 8 : out[si];
          g = bitDepth === 16 ? (out[si + 2] << 8 | out[si + 3]) >> 8 : out[si + 1];
          b = bitDepth === 16 ? (out[si + 4] << 8 | out[si + 5]) >> 8 : out[si + 2];
          a = 255;
        } else if (colorType === 3) {
          const idx = out[si];
          r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
          a = trns && idx < trns.length ? trns[idx] : 255;
        } else if (colorType === 4) {
          const v = bitDepth === 16 ? (out[si] << 8 | out[si + 1]) >> 8 : out[si];
          const av = bitDepth === 16 ? (out[si + 2] << 8 | out[si + 3]) >> 8 : out[si + 1];
          r = g = b = v; a = av;
        } else {
          r = bitDepth === 16 ? (out[si] << 8 | out[si + 1]) >> 8 : out[si];
          g = bitDepth === 16 ? (out[si + 2] << 8 | out[si + 3]) >> 8 : out[si + 1];
          b = bitDepth === 16 ? (out[si + 4] << 8 | out[si + 5]) >> 8 : out[si + 2];
          a = bitDepth === 16 ? (out[si + 6] << 8 | out[si + 7]) >> 8 : out[si + 3];
        }
        rgba[di] = r; rgba[di + 1] = g; rgba[di + 2] = b; rgba[di + 3] = a;
      }
    }
    return { width, height, data: rgba, hasAlpha };
  }

  function concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  const api = { decode };
  if (typeof globalThis !== 'undefined') globalThis.PngDecoder = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
