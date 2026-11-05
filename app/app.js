// app.js — 应用层：状态、目录载入、渲染循环（依赖 paperdoll.js 的 PaperDoll 与 codetable.js）
(function () {
  'use strict';
  const PD = globalThis.PaperDoll;
  const sjis = new TextDecoder('shift-jis');

  const state = {
    sets: new Map(),      // setName -> { folders: Map<folder, Map<decodedName, File-like>>, size, parts, colors, accDefault, readme }
    current: null,
    parts: { hair_front: '', hair_back: '', head: '', face: '', eye: '', body: '' },
    accessories: [],      // 解码名，索引 0 = 最前
    colors: { hairRgb: 0, hairContrast: 3, eyeRgb: 0, eyeContrast: 3, skinRgb: 0, skinContrast: 3, bodyRgb: 0, bodyContrast: 3 },
    bg: [255, 255, 255],
    status: '',
    loaded: false,
  };

  function intOr(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

  // entries: [{ webkitRelativePath: 'root/set/folder/name.png', arrayBuffer(): Promise<ArrayBuffer> }]
  // 支持两种选择：data 文件夹（root/set/folder/file）或项目根目录（root/data/set/folder/file、root/profile/x.dat）
  async function loadFromEntries(entries, onProgress) {
    const sets = new Map();
    const profiles = new Map(); // setName -> profile text (cp932)
    let pngCount = 0, iniCount = 0, rootName = '';
    for (const f of entries) {
      const rel = f.webkitRelativePath || f.name || '';
      const seg = rel.split('/');
      if (!rootName) rootName = seg[0];
      if (/(^|\/)profile\/[^/]+\.dat$/i.test(rel)) {
        // 存档：<...>/profile/<set>.dat
        const setName = seg[seg.length - 1].replace(/\.dat$/i, '');
        try { profiles.set(setName, sjis.decode(await f.arrayBuffer())); } catch (err) {}
        continue;
      }
      // 归一化到 [setName, folder|null, fileName]
      // 两种模式：data 文件夹直选（set/folder/file，3-4 段）或项目根目录（data/set/folder/file，5 段）
      let setName, folder, fileName;
      if (seg.length >= 5 && seg[1] === 'data') { setName = seg[2]; folder = seg[3]; fileName = seg[4]; }
      else if (seg.length === 4) { setName = seg[1]; folder = seg[2]; fileName = seg[3]; }
      else if (seg.length === 3) { setName = seg[1]; folder = null; fileName = seg[2]; }
      else continue;
      if (folder === null && !/^(character\.ini|readme\.txt)$/i.test(fileName)) continue;
      if (!sets.has(setName)) {
        sets.set(setName, { folders: new Map(), size: [300, 400], parts: {}, colors: {}, accDefault: [], readme: '', profile: null });
      }
      const set = sets.get(setName);
      if (/^character\.ini$/i.test(fileName)) {
        try {
          const ini = PD.parseIni(sjis.decode(await f.arrayBuffer()));
          const sx = parseInt(ini['Size.size_x']), sy = parseInt(ini['Size.size_y']);
          if (sx > 0 && sy > 0) set.size = [sx, sy];
          set.parts = {
            hair_front: ini['Parts.hair_front'] || '', hair_back: ini['Parts.hair_back'] || '',
            head: ini['Parts.head'] || '', face: ini['Parts.face'] || '',
            eye: ini['Parts.eye'] || '', body: ini['Parts.body'] || '',
          };
          set.accDefault = (ini['Parts.accessory'] || '').split(',').filter(s => s);
          set.colors = {
            hairRgb: intOr(ini['Color.hair_rgb'], 0), hairContrast: intOr(ini['Color.hair_gray'], 3),
            eyeRgb: intOr(ini['Color.eye_rgb'], 0), eyeContrast: intOr(ini['Color.eye_gray'], 3),
            skinRgb: intOr(ini['Color.skin_rgb'], 0), skinContrast: intOr(ini['Color.skin_gray'], 3),
            bodyRgb: intOr(ini['Color.body_rgb'], 0), bodyContrast: intOr(ini['Color.body_gray'], 3),
          };
          iniCount++;
        } catch (err) { /* ini 解析失败不致命 */ }
        continue;
      }
      if (/^readme\.txt$/i.test(fileName)) {
        try { set.readme = sjis.decode(await f.arrayBuffer()); } catch (err) {}
        continue;
      }
      if (!/\.png$/i.test(fileName)) continue;
      if (!PD.COMPOSITE_PLAN.some(p => p.layer === folder)) continue;
      const decoded = PD.decodeName(fileName.replace(/\.png$/i, ''));
      if (!set.folders.has(folder)) set.folders.set(folder, new Map());
      set.folders.get(folder).set(decoded, f);
      pngCount++;
    }
    // 应用存档（原程序启动时自动加载 profile\<set>.dat）
    for (const [setName, set] of sets) {
      const text = profiles.get(setName);
      if (!text) continue;
      try {
        const prof = PD.parseIni(text);
        const p = {
          hair_front: prof['Parts.hair_front'] || set.parts.hair_front || '',
          hair_back: prof['Parts.hair_back'] || set.parts.hair_back || '',
          head: prof['Parts.head'] || set.parts.head || '',
          face: prof['Parts.face'] || set.parts.face || '',
          eye: prof['Parts.eye'] || set.parts.eye || '',
          body: prof['Parts.body'] || set.parts.body || '',
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
        set.profile = setName;
      } catch (err) { /* 存档解析失败回退 ini 默认 */ }
    }
    state.sets = sets;
    state.loaded = sets.size > 0;
    const msg = `已载入 ${sets.size} 个角色集，${pngCount} 个部件，${iniCount} 个 character.ini，${profiles.size} 个存档（根目录：${rootName}）`;
    state.status = msg;
    if (onProgress) onProgress(msg);
    return sets;
  }

  // ---------- 解码缓存（纯 JS PNG 解码，避免画布预乘与色彩管理） ----------
  const bitmapCache = new Map(); // File-like -> {image:{data,width,height}, hasAlpha}

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

  // ---------- 渲染 ----------
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
    // 合成画布：普通模式以背景色打底（对应原程序对 buffer 10 填 bg），透明模式全零打底
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
      if (!hasAlpha) return;
      // 直接在解码数据上做换色（无预乘往返，逐字节与 imgctl 一致）
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

  globalThis.PaperDollApp = {
    state, loadFromEntries, renderTo, selectSet,
    getBitmap,
  };
})();
