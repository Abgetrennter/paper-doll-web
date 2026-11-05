// paperdoll.js — 纸娃娃换装工具核心逻辑（无 DOM 依赖，可在 Node 中单元测试）
// 规格来源：キャラクターなんとか機 v2.10 反编译源码 + imgctl.dll 反汇编（见 research/）
(function () {
  'use strict';

  // ============ 常量表（逆向所得） ============

  // 合成顺序（自底向上）。$ACC 表示在此位置按饰品列表（从末项到首项）插入对应饰品文件夹
  const COMPOSITE_PLAN = [
    { layer: 'accessory_back', acc: true },
    { layer: 'hair_back' },
    { layer: 'hair_back_accessory', of: 'hair_back' },
    { layer: 'body_back', of: 'body' },
    { layer: 'accessory_underwear', acc: true },
    { layer: 'body_front', of: 'body' },
    { layer: 'body_front_color', of: 'body' },
    { layer: 'accessory_middle_back', acc: true },
    { layer: 'head' },
    { layer: 'accessory_middle_front', acc: true },
    { layer: 'face_back', of: 'face' },
    { layer: 'hair_front' },
    { layer: 'hair_front_accessory', of: 'hair_front' },
    { layer: 'face_front', of: 'face' },
    { layer: 'eye' },
    { layer: 'accessory_front', acc: true },
  ];

  // 每个选择键覆盖的图层文件夹（同键同名文件配对）
  const KEY_FOLDERS = {
    hair_front: ['hair_front', 'hair_front_accessory'],
    hair_back: ['hair_back', 'hair_back_accessory'],
    head: ['head'],
    face: ['face_back', 'face_front'],
    eye: ['eye'],
    body: ['body_back', 'body_front', 'body_front_color'],
  };

  // 菜单可见性的基准层（该层文件夹有文件，对应键才出现在部件页）
  const BASE_LAYERS = {
    hair_front: 'hair_front', hair_back: 'hair_back', head: 'head',
    face: 'face_front', eye: 'eye', body: 'body_back',
  };

  // 图层文件夹的处理类型
  const LAYER_OP_KIND = {
    hair_front: 'hair', hair_back: 'hair',
    body_back: 'skin', head: 'skin',
    body_front_color: 'body',
    eye: 'eye',
    // 其余（*_accessory、body_front、face_*）为 plain，仅 Tone
  };

  // 饰品文件名后缀 → 处理类型（文件名含该子串时套用）
  const ACC_SUFFIX_OPS = ['(髪)', '(瞳)', '(肌)', '(服)'];

  // 发色桶 0-10：通道交换选择器（newC = old[sel]，0=R 1=G 2=B）
  // 原始 ReplaceDIB 参数对 3 取模所得
  const HAIR_SWAP = [
    [0, 0, 2], [2, 0, 2], [2, 0, 0], [2, 2, 0], [0, 2, 0], [0, 2, 2],
    [0, 0, 0], [2, 2, 2], [2, 0, 0], [2, 0, 0], [2, 0, 0],
  ];
  // 发色桶附加 Gamma（千分之一）
  const HAIR_GAMMA = [
    [1000, 1000, 1000], [1000, 1000, 1000], [1000, 1000, 1000], [1000, 1000, 1000],
    [1000, 1000, 1000], [1000, 1000, 1000], [1000, 1000, 1000], [1000, 1000, 1000],
    [700, 1000, 1000], [2000, 1500, 1000], [3000, 1200, 1200],
  ];
  // 明暗滑杆 0-6 → Gray 扺色化强度
  const GRAY_STRENGTH = [0, 32, 64, 128, 192, 224, 255];
  // 肤色桶 0-4：Shade 千分比乘数
  const SKIN_MUL = [
    [1000, 1000, 1000], [900, 700, 700], [1050, 1050, 1000],
    [1200, 950, 950], [1200, 1050, 1200],
  ];
  // 肤色明暗 0-6 → Gamma（三通道同值，千分之一）
  const SKIN_GAMMA = [1600, 1400, 1200, 1000, 900, 800, 700];
  // 全图层统一 Tone 偏移
  const TONE_MOVE = 2;
  const ACCESSORY_MAX = 6;

  // ============ 乱码名解码 ============

  // 依赖 codetable.js 提供的 globalThis.PAPERDOLL_CODEC（Node 测试时可注入桩）
  const codec = (typeof globalThis !== 'undefined' && globalThis.PAPERDOLL_CODEC) || null;

  // 名字解码：全部非 ASCII 字符均在表中才整体解码（乱码名），否则原样保留（正常日文名）
  function decodeName(name) {
    if (!codec || !name) return name;
    let allMapped = false;
    let hasNonAscii = false;
    for (const ch of name) {
      if (ch.charCodeAt(0) >= 0x80) {
        hasNonAscii = true;
        if (!codec.map.has(ch)) return name; // 含表外字符 → 视为正常日文名
        allMapped = true;
      }
    }
    if (!hasNonAscii || !allMapped) return name;
    return codec.decode(name);
  }

  // ============ 像素原语（与 imgctl.dll 逐指令一致） ============

  const gammaCache = new Map();
  function gammaLut(arg) {
    let lut = gammaCache.get(arg);
    if (lut) return lut;
    lut = new Uint8Array(256);
    const e = 1000 / arg;
    for (let i = 0; i < 256; i++) {
      lut[i] = Math.floor(Math.pow(i / 255, e) * 255 + 0.5) & 0xFF;
    }
    gammaCache.set(arg, lut);
    return lut;
  }

  // ChannelSwap（ReplaceDIB）：newC = old[sel[c]]，sel 取值 0=R 1=G 2=B
  function applySwap(data, sel) {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const ch = sel[0] === 0 ? r : sel[0] === 1 ? g : b;
      const cg = sel[1] === 0 ? r : sel[1] === 1 ? g : b;
      const cb = sel[2] === 0 ? r : sel[2] === 1 ? g : b;
      data[i] = ch; data[i + 1] = cg; data[i + 2] = cb;
    }
  }

  // Gamma（GammaDIB）：out = round((c/255)^(1000/arg) * 255)
  function applyGamma(data, args) {
    const lr = gammaLut(args[0]), lg = gammaLut(args[1]), lb = gammaLut(args[2]);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lr[data[i]]; data[i + 1] = lg[data[i + 1]]; data[i + 2] = lb[data[i + 2]];
    }
  }

  // Shade（ShadeDIB）：out = min(255, (c*mul + 500) / 1000)
  function applyShade(data, muls) {
    for (let i = 0; i < data.length; i += 4) {
      let r = (data[i] * muls[0] + 500) / 1000 | 0;
      if (r > 255) r = 255;
      let g = (data[i + 1] * muls[1] + 500) / 1000 | 0;
      if (g > 255) g = 255;
      let b = (data[i + 2] * muls[2] + 500) / 1000 | 0;
      if (b > 255) b = 255;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }

  // Gray（GrayDIB）：gray=(306R+601G+117B+512)>>10；out=((255-s)c + s*gray + 127)/255
  function applyGray(data, s) {
    if (s <= 0) return;
    if (s > 255) s = 255;
    const inv = 255 - s;
    for (let i = 0; i < data.length; i += 4) {
      const gray = (306 * data[i] + 601 * data[i + 1] + 117 * data[i + 2] + 512) >> 10;
      data[i] = (inv * data[i] + s * gray + 127) / 255 | 0;
      data[i + 1] = (inv * data[i + 1] + s * gray + 127) / 255 | 0;
      data[i + 2] = (inv * data[i + 2] + s * gray + 127) / 255 | 0;
    }
  }

  // Tone（ToneDIB）：out = clamp(c + move, 0, 255)
  function applyTone(data, move) {
    for (let i = 0; i < data.length; i += 4) {
      let v = data[i] + move; data[i] = v > 255 ? 255 : v < 0 ? 0 : v;
      v = data[i + 1] + move; data[i + 1] = v > 255 ? 255 : v < 0 ? 0 : v;
      v = data[i + 2] + move; data[i + 2] = v > 255 ? 255 : v < 0 ? 0 : v;
    }
  }

  // 依据状态生成某图层的处理序列
  // kind: 'hair'|'skin'|'body'|'eye'|'plain'；colorState: {hairRgb,hairContrast,eyeRgb,eyeContrast,skinRgb,skinContrast,bodyRgb,bodyContrast}
  function opsForKind(kind, colorState) {
    switch (kind) {
      case 'hair': return [
        { fn: 'swap', sel: HAIR_SWAP[colorState.hairRgb] },
        { fn: 'gamma', args: HAIR_GAMMA[colorState.hairRgb] },
        { fn: 'gray', s: GRAY_STRENGTH[colorState.hairContrast] },
        { fn: 'tone', move: TONE_MOVE },
      ];
      case 'eye': return [
        { fn: 'swap', sel: HAIR_SWAP[colorState.eyeRgb] },
        { fn: 'gray', s: GRAY_STRENGTH[colorState.eyeContrast] },
        { fn: 'tone', move: TONE_MOVE },
      ];
      case 'skin': return [
        { fn: 'shade', muls: SKIN_MUL[colorState.skinRgb] },
        { fn: 'gamma', args: [SKIN_GAMMA[colorState.skinContrast], SKIN_GAMMA[colorState.skinContrast], SKIN_GAMMA[colorState.skinContrast]] },
        { fn: 'tone', move: TONE_MOVE },
      ];
      case 'body': return [
        { fn: 'swap', sel: HAIR_SWAP[colorState.bodyRgb] },
        { fn: 'gray', s: GRAY_STRENGTH[colorState.bodyContrast] },
        { fn: 'tone', move: TONE_MOVE },
      ];
      default: return [{ fn: 'tone', move: TONE_MOVE }];
    }
  }

  // 饰品文件名 → 处理序列（按后缀匹配，均不匹配则仅 Tone）
  function opsForAccessory(decodedName, colorState) {
    for (let i = 0; i < ACC_SUFFIX_OPS.length; i++) {
      if (decodedName.indexOf(ACC_SUFFIX_OPS[i]) >= 0) {
        return opsForKind(['hair', 'eye', 'skin', 'body'][i], colorState);
      }
    }
    return [{ fn: 'tone', move: TONE_MOVE }];
  }

  function applyOps(data, ops) {
    for (const op of ops) {
      if (op.fn === 'swap') applySwap(data, op.sel);
      else if (op.fn === 'gamma') applyGamma(data, op.args);
      else if (op.fn === 'shade') applyShade(data, op.muls);
      else if (op.fn === 'gray') applyGray(data, op.s);
      else if (op.fn === 'tone') applyTone(data, op.move);
    }
  }

  // ============ 合成（HSP3 gmode 7 逐字节一致） ============

  // dst/src: {data,width,height} RGBA；src 的 alpha 为蒙版（0-255）
  // 公式（OpenHSP hspwnd_win.cpp case 7）：
  //   a==0 → 不变；a==255 → 直拷；否则 dst = (dst*(255-a)>>8) + (src*a>>8)
  // 支持源与目标尺寸不同（部件小于画布时按 0,0 对齐，越界裁掉）
  function blendOnto(dst, src) {
    const w = Math.min(dst.width, src.width);
    const h = Math.min(dst.height, src.height);
    const d = dst.data, s = src.data;
    const dStride = dst.width * 4, sStride = src.width * 4;
    for (let y = 0; y < h; y++) {
      let di = y * dStride, si = y * sStride;
      for (let x = 0; x < w; x++, di += 4, si += 4) {
        const a = s[si + 3];
        if (a === 0) continue;
        if (a === 255) {
          d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2];
        } else {
          const ia = 255 - a;
          d[di] = ((d[di] * ia >> 8) + (s[si] * a >> 8));
          d[di + 1] = ((d[di + 1] * ia >> 8) + (s[si + 1] * a >> 8));
          d[di + 2] = ((d[di + 2] * ia >> 8) + (s[si + 2] * a >> 8));
        }
        // 目标 alpha 不参与（HSP 24bpp 缓冲无 alpha 通道）
        d[di + 3] = 255;
      }
    }
  }

  // ============ INI 解析（cp932 文本） ============

  function parseIni(text) {
    const result = {};
    let section = '';
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith(';') || line.startsWith('#')) continue;
      const sm = line.match(/^\[(.+)\]$/);
      if (sm) { section = sm[1]; continue; }
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      result[section + '.' + key] = val;
    }
    return result;
  }

  // ============ 导出 ============

  const spec = {
    COMPOSITE_PLAN, KEY_FOLDERS, BASE_LAYERS, LAYER_OP_KIND, ACC_SUFFIX_OPS,
    HAIR_SWAP, HAIR_GAMMA, GRAY_STRENGTH, SKIN_MUL, SKIN_GAMMA, TONE_MOVE, ACCESSORY_MAX,
    decodeName, applySwap, applyGamma, applyShade, applyGray, applyTone,
    opsForKind, opsForAccessory, applyOps, blendOnto, parseIni, gammaLut,
  };

  if (typeof globalThis !== 'undefined') globalThis.PaperDoll = spec;
  if (typeof module !== 'undefined' && module.exports) module.exports = spec;
})();
