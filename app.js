// app.js — 应用层：状态、目录载入、渲染循环、导出与设定 IO
// 依赖 paperdoll.js（PaperDoll）、png.js（PngDecoder）、codetable.js
(function () {
  'use strict';
  const PD = globalThis.PaperDoll;
  const sjis = new TextDecoder('shift-jis');

  const state = {
    sets: new Map(),      // setName -> { folders, size, parts, colors, accDefault, readme, bg }
    current: null,
    parts: { hair_front: '', hair_back: '', head: '', face: '', eye: '', body: '' },
    accessories: [],      // 解码名，索引 0 = 最前
    colors: { hairRgb: 0, hairContrast: 3, eyeRgb: 0, eyeContrast: 3, skinRgb: 0, skinContrast: 3, bodyRgb: 0, bodyContrast: 3 },
    bg: [255, 255, 255],
    status: '',
    loaded: false,
  };

  function intOr(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

  // ============ 载入 ============

  // entries: [{ webkitRelativePath, arrayBuffer() }]
  // 路径归一化：从任意深度的目录树中发现角色集。
  // 倒序寻找第一个「已知图层文件夹」段，其上一段即角色集名；无图层段时视作
  // set 根下的元文件（character.ini / readme.txt / character.xml / profile/*.dat）。
  // 因此：选整个 ThCRP、选 data、选单个角色集文件夹，都能正确识别。
  async function loadFromEntries(entries, onProgress, opts) {
    const merge = opts && opts.merge;
    const sets = merge ? state.sets : new Map();
    const profiles = new Map();
    let pngCount = 0, iniCount = 0, xmlCount = 0, rootName = '';
    for (const f of entries) {
      const rel = f.webkitRelativePath || f.name || '';
      const seg = rel.split('/');
      if (!rootName) rootName = seg[0];
      if (/(^|\/)profile\/[^/]+\.dat$/i.test(rel)) {
        const setName = seg[seg.length - 1].replace(/\.dat$/i, '');
        try { profiles.set(setName, sjis.decode(await f.arrayBuffer())); } catch (err) {}
        continue;
      }
      const fileName = seg[seg.length - 1];
      if (!/\.png$/i.test(fileName) && !/^(character\.ini|readme\.txt|character\.xml)$/i.test(fileName)) continue;
      let folderIdx = -1;
      for (let i = seg.length - 2; i >= 0; i--) {
        if (PD.COMPOSITE_PLAN.some(p => p.layer === seg[i])) { folderIdx = i; break; }
      }
      let setName, folder;
      if (folderIdx > 0) {
        setName = seg[folderIdx - 1];
        folder = seg[folderIdx];
      } else {
        folder = null;
        if (seg.length < 2) continue;
        setName = seg[seg.length - 2];
      }
      if (!sets.has(setName)) {
        sets.set(setName, { folders: new Map(), size: [300, 400], parts: {}, colors: {}, accDefault: [], readme: '', profile: null });
      }
      const set = sets.get(setName);
      if (/^character\.ini$/i.test(fileName)) {
        try {
          applyIniToSet(set, sjis.decode(await f.arrayBuffer()));
          set.sizeFromIni = true;
          iniCount++;
        } catch (err) { /* ini 解析失败不致命 */ }
        continue;
      }
      if (/^readme\.txt$/i.test(fileName)) {
        try { set.readme = sjis.decode(await f.arrayBuffer()); } catch (err) {}
        continue;
      }
      if (/^character\.xml$/i.test(fileName)) {
        // CharacterManaJ 格式：画布尺寸、说明、默认预设（部件/饰品/背景色）
        try {
          const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(await f.arrayBuffer()), 'application/xml');
          const sz = doc.getElementsByTagName('image-size')[0];
          if (sz) {
            const w = parseInt(sz.getElementsByTagName('width')[0].textContent, 10);
            const h = parseInt(sz.getElementsByTagName('height')[0].textContent, 10);
            if (w > 0 && h > 0) { set.size = [w, h]; set.sizeFromXml = true; }
          }
          const desc = doc.getElementsByTagName('description')[0];
          if (desc) set.readme = desc.textContent;
          // 默认预设：category refid 与我们的部件键同名，accessory 转饰品列表
          const presets = doc.getElementsByTagName('preset');
          const defId = doc.getElementsByTagName('presets')[0]?.getAttribute('default-preset');
          for (const p of presets) {
            if (p.getAttribute('id') !== defId) continue;
            const bgEl = p.getElementsByTagName('background-color')[0];
            if (bgEl) {
              const hex = (bgEl.getAttribute('color') || '').replace('#', '');
              if (/^[0-9a-f]{6}$/i.test(hex)) {
                set.bg = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
              }
            }
            for (const cat of p.getElementsByTagName('category')) {
              const ref = cat.getAttribute('refid');
              const names = [...cat.getElementsByTagName('parts')].map(el => el.getAttribute('name')).filter(Boolean);
              if (!names.length) continue;
              if (ref === 'accessory') {
                set.accDefault = names.map(n => PD.decodeName(n));
              } else if (['hair_front', 'hair_back', 'head', 'face', 'eye', 'body'].includes(ref)) {
                set.parts[ref] = PD.decodeName(names[0]);
              }
            }
            break;
          }
          set.xmlRead = true;
          xmlCount++;
        } catch (err) { /* xml 解析失败不致命 */ }
        continue;
      }
      if (!/\.png$/i.test(fileName)) continue;
      if (!PD.COMPOSITE_PLAN.some(p => p.layer === folder)) continue;
      const decoded = PD.decodeName(fileName.replace(/\.png$/i, ''));
      if (!set.folders.has(folder)) set.folders.set(folder, new Map());
      set.folders.get(folder).set(decoded, f);
      if (!set.firstPng) set.firstPng = f;
      pngCount++;
    }
    // 无 character.ini 的角色集（如 CharacterManaJ 格式）：从首个部件 PNG 的 IHDR 推画布尺寸
    for (const [, set] of sets) {
      if (!set.sizeFromIni && !set.sizeFromXml && set.firstPng) {
        try {
          const u8 = new Uint8Array(await set.firstPng.arrayBuffer());
          const w = (u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19];
          const h = (u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23];
          if (w > 0 && h > 0) set.size = [w, h];
        } catch (err) { /* 保持默认 */ }
      }
      delete set.firstPng;
      delete set.sizeFromIni;
      delete set.sizeFromXml;
    }
    // 应用存档（原程序启动时自动加载 profile\<set>.dat）
    for (const [setName, set] of sets) {
      const text = profiles.get(setName);
      if (!text) continue;
      try { applyProfileToSet(set, PD.parseIni(text)); } catch (err) { /* 回退 ini 默认 */ }
    }
    state.sets = sets;
    state.loaded = sets.size > 0;
    const msg = `已载入 ${sets.size} 个角色集（${pngCount} 个部件，${iniCount} 个 character.ini，${xmlCount} 个 character.xml，${profiles.size} 个存档）。本次扫描根：${rootName}。可继续选择其他文件夹追加载入。`;
    state.status = msg;
    if (onProgress) onProgress(msg);
    return sets;
  }

  function applyIniToSet(set, text) {
    const ini = PD.parseIni(text);
    const sx = parseInt(ini['Size.size_x']), sy = parseInt(ini['Size.size_y']);
    if (sx > 0 && sy > 0) set.size = [sx, sy];
    set.parts = {
      hair_front: PD.decodeName(ini['Parts.hair_front'] || ''), hair_back: PD.decodeName(ini['Parts.hair_back'] || ''),
      head: PD.decodeName(ini['Parts.head'] || ''), face: PD.decodeName(ini['Parts.face'] || ''),
      eye: PD.decodeName(ini['Parts.eye'] || ''), body: PD.decodeName(ini['Parts.body'] || ''),
    };
    set.accDefault = (ini['Parts.accessory'] || '').split(',').filter(s => s).map(n => PD.decodeName(n));
    set.colors = {
      hairRgb: intOr(ini['Color.hair_rgb'], 0), hairContrast: intOr(ini['Color.hair_gray'], 3),
      eyeRgb: intOr(ini['Color.eye_rgb'], 0), eyeContrast: intOr(ini['Color.eye_gray'], 3),
      skinRgb: intOr(ini['Color.skin_rgb'], 0), skinContrast: intOr(ini['Color.skin_gray'], 3),
      bodyRgb: intOr(ini['Color.body_rgb'], 0), bodyContrast: intOr(ini['Color.body_gray'], 3),
    };
  }

  function applyProfileToSet(set, prof) {
    const p = {
      hair_front: PD.decodeName(prof['Parts.hair_front'] || '') || set.parts.hair_front || '',
      hair_back: PD.decodeName(prof['Parts.hair_back'] || '') || set.parts.hair_back || '',
      head: PD.decodeName(prof['Parts.head'] || '') || set.parts.head || '',
      face: PD.decodeName(prof['Parts.face'] || '') || set.parts.face || '',
      eye: PD.decodeName(prof['Parts.eye'] || '') || set.parts.eye || '',
      body: PD.decodeName(prof['Parts.body'] || '') || set.parts.body || '',
    };
    const acc = (prof['Parts.accessory'] || '').split(',').filter(s => s).map(n => PD.decodeName(n));
    const bg = (prof['Color.bg_rgb'] || '').split(',').map(v => intOr(v.trim(), -1));
    set.parts = p;
    set.accDefault = acc;
    set.colors = {
      hairRgb: intOr(prof['Color.hair_rgb'], set.colors.hairRgb ?? 0),
      hairContrast: intOr(prof['Color.hair_gray'], set.colors.hairContrast ?? 3),
      eyeRgb: intOr(prof['Color.eye_rgb'], set.colors.eyeRgb ?? 0),
      eyeContrast: intOr(prof['Color.eye_gray'], set.colors.eyeContrast ?? 3),
      skinRgb: intOr(prof['Color.skin_rgb'], set.colors.skinRgb ?? 0),
      skinContrast: intOr(prof['Color.skin_gray'], set.colors.skinContrast ?? 3),
      bodyRgb: intOr(prof['Color.body_rgb'], set.colors.bodyRgb ?? 0),
      bodyContrast: intOr(prof['Color.body_gray'], set.colors.bodyContrast ?? 3),
    };
    if (bg.length === 3 && bg.every(v => v >= 0)) set.bg = bg;
    set.profile = set.profile; // 保留字段语义
  }

  // ============ 解码缓存（纯 JS PNG 解码，无预乘、无色彩管理） ============

  const bitmapCache = new Map();

  async function getBitmap(file) {
    let entry = bitmapCache.get(file);
    if (!entry) {
      const buf = await file.arrayBuffer();
      const image = await globalThis.PngDecoder.decode(buf);
      entry = { image, hasAlpha: image.hasAlpha };
      bitmapCache.set(file, entry);
    }
    return entry;
  }

  // ============ 渲染 ============

  let workCanvas = null, workCtx = null;
  let renderSeq = 0;

  async function renderTo(canvas, opts) {
    const set = state.sets.get(state.current);
    if (!set) return;
    const seq = ++renderSeq;
    const [w, h] = set.size;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const transparent = opts && opts.transparent;
    if (!workCanvas || workCanvas.width !== w || workCanvas.height !== h) {
      workCanvas = document.createElement('canvas');
      workCanvas.width = w; workCanvas.height = h;
      workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    }
    // 普通模式以背景色打底（对应原程序对画布填 bg），透明模式全零打底
    const work = workCtx.createImageData(w, h);
    if (!transparent) {
      for (let i = 0; i < work.data.length; i += 4) {
        work.data[i] = state.bg[0]; work.data[i + 1] = state.bg[1]; work.data[i + 2] = state.bg[2]; work.data[i + 3] = 255;
      }
    }

    const drawInto = async (folder, partName, ops) => {
      const file = set.folders.get(folder)?.get(partName);
      if (!file) return;
      const { image, hasAlpha } = await getBitmap(file);
      if (!hasAlpha) return; // 原程序行为：无 alpha 通道的部件不可见（PNGMAtoDIB 返回 NULL）
      const layerData = new Uint8ClampedArray(image.data);
      PD.applyOps(layerData, ops);
      PD.blendOnto(work, { data: layerData, width: image.width, height: image.height });
    };

    for (const step of PD.COMPOSITE_PLAN) {
      if (seq !== renderSeq) return false; // 过期渲染
      if (step.acc) {
        for (let i = state.accessories.length - 1; i >= 0; i--) {
          const name = state.accessories[i];
          await drawInto(step.layer, name, PD.opsForAccessory(name, state.colors));
        }
      } else {
        const key = step.of || step.layer;
        const partName = state.parts[key];
        if (!partName) continue;
        const kind = PD.LAYER_OP_KIND[step.layer] || 'plain';
        await drawInto(step.layer, partName, PD.opsForKind(kind, state.colors));
      }
    }
    ctx.putImageData(work, 0, 0);
    persistState();
    return true;
  }

  function selectSet(name) {
    state.current = name;
    const set = state.sets.get(name);
    if (!set) return;
    state.parts = { ...set.parts };
    state.colors = { ...state.colors, ...set.colors };
    state.accessories = [...(set.accDefault || [])].map(n => PD.decodeName(n));
    if (set.bg) state.bg = [...set.bg];
  }

  // ============ 导出 ============

  async function renderOffscreen(opts) {
    const c = document.createElement('canvas');
    await renderTo(c, opts);
    return c;
  }

  function dataUrlToBytes(url) {
    const b64 = url.split(',')[1];
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // 24 位 BMP：BGR 自底向上，行 4 字节对齐
  function canvasToBmpBlob(canvas) {
    const w = canvas.width, h = canvas.height;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const rowSize = (w * 3 + 3) & ~3;
    const dataSize = rowSize * h;
    const buf = new ArrayBuffer(54 + dataSize);
    const v = new DataView(buf);
    v.setUint8(0, 0x42); v.setUint8(1, 0x4D);
    v.setUint32(2, 54 + dataSize, true);
    v.setUint32(10, 54, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, w, true);
    v.setInt32(22, h, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 24, true);
    v.setUint32(34, dataSize, true);
    let o = 54;
    for (let y = h - 1; y >= 0; y--) {
      let p = o;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        v.setUint8(p++, data[i + 2]);
        v.setUint8(p++, data[i + 1]);
        v.setUint8(p++, data[i]);
      }
      o += rowSize;
    }
    return new Blob([buf], { type: 'image/bmp' });
  }

  // 伺か PNA：alpha 通道转 8 位灰度 PNG
  function alphaToPnaBlob(srcCanvas) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const src = srcCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3];
      img.data[i] = a; img.data[i + 1] = a; img.data[i + 2] = a; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return new Blob([dataUrlToBytes(c.toDataURL('image/png'))], { type: 'image/png' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadDataUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function safeName() {
    return (state.current || 'character').replace(/[\\/:*?"<>|]/g, '_');
  }

  async function exportPreview(fmt) {
    if (!state.loaded) return '尚未载入素材。';
    const c = await renderOffscreen({});
    if (fmt === 'bmp') {
      downloadBlob(canvasToBmpBlob(c), safeName() + '.bmp');
    } else if (fmt === 'jpg') {
      downloadDataUrl(c.toDataURL('image/jpeg', 0.8), safeName() + '.jpg');
    } else {
      downloadBlob(new Blob([dataUrlToBytes(c.toDataURL('image/png'))], { type: 'image/png' }), safeName() + '.png');
    }
    return '已保存预览图（' + String(fmt).toUpperCase() + '）。';
  }

  async function exportTransparent() {
    if (!state.loaded) return '尚未载入素材。';
    const c = await renderOffscreen({ transparent: true });
    downloadBlob(new Blob([dataUrlToBytes(c.toDataURL('image/png'))], { type: 'image/png' }), safeName() + '_alpha.png');
    return '已保存透明背景 PNG。';
  }

  async function exportUkagaka() {
    if (!state.loaded) return '尚未载入素材。';
    const c = await renderOffscreen({ transparent: true });
    downloadBlob(new Blob([dataUrlToBytes(c.toDataURL('image/png'))], { type: 'image/png' }), 'surface.png');
    downloadBlob(alphaToPnaBlob(c), 'surface.pna');
    return '已保存伺か用 surface.png + surface.pna。';
  }

  // ============ 设定 IO（JSON 主格式，兼容导入原 .dat/.cpd） ============

  function serializeState() {
    return {
      app: 'paper-doll-web', version: 1,
      set: state.current,
      parts: { ...state.parts },
      accessories: state.accessories.slice(0, PD.ACCESSORY_MAX),
      colors: { ...state.colors },
      bg: state.bg.slice(),
    };
  }

  function applySettingsJson(obj) {
    if (!state.loaded) return '尚未载入素材。';
    if (!obj || obj.app !== 'paper-doll-web' || !obj.set || !state.sets.has(obj.set)) {
      return '设定文件中的角色集不存在：' + (obj && obj.set);
    }
    selectSet(obj.set);
    Object.assign(state.parts, obj.parts || {});
    state.colors = { ...state.colors, ...(obj.colors || {}) };
    state.accessories = (obj.accessories || []).slice(0, PD.ACCESSORY_MAX).map(n => String(n));
    if (Array.isArray(obj.bg) && obj.bg.length === 3) {
      state.bg = obj.bg.map(v => Math.max(0, Math.min(255, v | 0)));
    }
    return '已载入设定（' + obj.set + '）。';
  }

  function applySettingsIni(ini) {
    if (!state.loaded) return '尚未载入素材。';
    const setName = ini['Character.name'];
    if (!setName || !state.sets.has(setName)) return '设定文件中的角色集不存在：' + setName;
    selectSet(setName);
    const decode = PD.decodeName;
    for (const k of ['hair_front', 'hair_back', 'head', 'face', 'eye', 'body']) {
      const v = ini['Parts.' + k];
      if (v) state.parts[k] = decode(v);
    }
    const acc = (ini['Parts.accessory'] || '').split(',').filter(s => s).map(decode);
    if (acc.length) state.accessories = acc.slice(0, PD.ACCESSORY_MAX);
    const num = (key, def) => intOr(ini[key], def);
    state.colors = {
      hairRgb: num('Color.hair_rgb', state.colors.hairRgb),
      hairContrast: num('Color.hair_gray', state.colors.hairContrast),
      eyeRgb: num('Color.eye_rgb', state.colors.eyeRgb),
      eyeContrast: num('Color.eye_gray', state.colors.eyeContrast),
      skinRgb: num('Color.skin_rgb', state.colors.skinRgb),
      skinContrast: num('Color.skin_gray', state.colors.skinContrast),
      bodyRgb: num('Color.body_rgb', state.colors.bodyRgb),
      bodyContrast: num('Color.body_gray', state.colors.bodyContrast),
    };
    const bg = (ini['Color.bg_rgb'] || '').split(',').map(v => intOr(v.trim(), -1));
    if (bg.length === 3 && bg.every(n => n >= 0)) state.bg = bg;
    return '已载入设定（' + setName + '）。';
  }

  async function importSettingsFile(file) {
    const bytes = await file.arrayBuffer();
    const name = file.name.toLowerCase();
    if (name.endsWith('.json')) {
      try {
        return applySettingsJson(JSON.parse(new TextDecoder('utf-8').decode(bytes)));
      } catch (err) {
        return 'JSON 解析失败：' + err.message;
      }
    }
    if (name.endsWith('.dat') || name.endsWith('.cpd')) {
      return applySettingsIni(PD.parseIni(sjis.decode(bytes)));
    }
    return '不支持的设定文件类型：' + file.name;
  }

  // ============ 自动保存（localStorage） ============

  const LS_KEY = 'paper-doll-web-state';
  function persistState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(serializeState())); } catch (err) { /* 隐私模式等忽略 */ }
  }
  function restoreState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || obj.app !== 'paper-doll-web' || !state.sets.has(obj.set)) return null;
      applySettingsJson(obj);
      return obj.set;
    } catch (err) { return null; }
  }

  globalThis.PaperDollApp = {
    state, loadFromEntries, renderTo, selectSet, getBitmap,
    renderOffscreen, canvasToBmpBlob, alphaToPnaBlob,
    downloadBlob, downloadDataUrl,
    exportPreview, exportTransparent, exportUkagaka,
    serializeState, applySettingsJson, applySettingsIni, importSettingsFile,
    restoreState,
  };
})();
