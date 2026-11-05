"""Python 参考渲染器：独立实现反编译规格，用于交叉验证 JS 版渲染。"""
from PIL import Image
import os, sys

BASE = r'E:\Code\paper_doll_fixed\data'
PROFILE = r'E:\Code\paper_doll_fixed\profile'

LAYER_ORDER = [
    ('accessory_back', 'acc'), ('hair_back', None), ('hair_back_accessory', 'hair_back'),
    ('body_back', 'body'), ('accessory_underwear', 'acc'), ('body_front', 'body'),
    ('body_front_color', 'body'), ('accessory_middle_back', 'acc'), ('head', None),
    ('accessory_middle_front', 'acc'), ('face_back', 'face'), ('hair_front', None),
    ('hair_front_accessory', 'hair_front'), ('face_front', 'face'), ('eye', None),
    ('accessory_front', 'acc'),
]
LAYER_KIND = {
    'hair_front': 'hair', 'hair_back': 'hair',
    'body_back': 'skin', 'head': 'skin',
    'body_front_color': 'body', 'eye': 'eye',
}
SUFFIX = ['(髪)', '(瞳)', '(肌)', '(服)']
SUFFIX_KIND = ['hair', 'eye', 'skin', 'body']

HAIR_SWAP = [(0,0,2),(2,0,2),(2,0,0),(2,2,0),(0,2,0),(0,2,2),(0,0,0),(2,2,2),(2,0,0),(2,0,0),(2,0,0)]
HAIR_GAMMA = [(1000,1000,1000)]*8 + [(700,1000,1000),(2000,1500,1000),(3000,1200,1200)]
GRAY = [0,32,64,128,192,224,255]
SKIN_MUL = [(1000,1000,1000),(900,700,700),(1050,1050,1000),(1200,950,950),(1200,1050,1200)]
SKIN_GAMMA = [1600,1400,1200,1000,900,800,700]
TONE = 2

def decode_name(raw):
    """乱码名还原：GBK 字节 -> CP932。带守卫：全部非 ASCII 字符的 GBK 编码
    都必须落在 Shift_JIS 双字节范围内且 cp932 可解码，否则视为正常日文原样返回。"""
    if not raw:
        return raw
    leads = set(range(0x81, 0xA0)) | set(range(0xE0, 0xF0))
    for ch in raw:
        if ord(ch) < 0x80:
            continue
        try:
            b = ch.encode('gbk')
        except Exception:
            return raw
        if len(b) != 2 or b[0] not in leads or not (0x40 <= b[1] <= 0xFC and b[1] != 0x7F):
            return raw
        try:
            b.decode('cp932')
        except Exception:
            return raw
    try:
        return raw.encode('gbk').decode('cp932')
    except Exception:
        return raw

def load_set(set_name):
    """返回 {folder: {decoded_name: PIL.Image(RGBA)}}, size, ini"""
    root = os.path.join(BASE, set_name)
    folders = {}
    for folder in os.listdir(root):
        p = os.path.join(root, folder)
        if not os.path.isdir(p):
            continue
        m = {}
        for n in os.listdir(p):
            if n.lower().endswith('.png'):
                decoded = decode_name(n[:-4])
                img = Image.open(os.path.join(p, n)).convert('RGBA')
                m[decoded] = img
        folders[folder] = m
    size = (300, 400)
    ini_p = os.path.join(root, 'character.ini')
    ini = {}
    if os.path.exists(ini_p):
        sec = ''
        for line in open(ini_p, 'rb').read().decode('cp932').splitlines():
            line = line.strip()
            if line.startswith('[') and line.endswith(']'):
                sec = line[1:-1]; continue
            if '=' in line:
                k, v = line.split('=', 1)
                ini[sec + '.' + k.strip()] = v.strip()
        size = (int(ini.get('Size.size_x', 300)), int(ini.get('Size.size_y', 400)))
    return folders, size, ini

def gamma_lut(arg):
    e = 1000.0 / arg
    return [int(pow(i / 255.0, e) * 255.0 + 0.5) for i in range(256)]

_lut_cache = {}
def lut(arg):
    if arg not in _lut_cache:
        _lut_cache[arg] = gamma_lut(arg)
    return _lut_cache[arg]

def apply_ops(img, kind, colors, decoded_name=None, is_acc=False):
    """按规格对 RGBA 图施加换色序列（in-place）。"""
    if is_acc:
        for i, suf in enumerate(SUFFIX):
            if suf in decoded_name:
                kind = SUFFIX_KIND[i]
                break
        else:
            kind = 'plain'
    px = img.load()
    w, h = img.size
    if kind == 'hair':
        sel = HAIR_SWAP[colors['hairRgb']]
        g = HAIR_GAMMA[colors['hairRgb']]
        s = GRAY[colors['hairContrast']]
    elif kind == 'eye':
        sel = HAIR_SWAP[colors['eyeRgb']]
        g = (1000, 1000, 1000)
        s = GRAY[colors['eyeContrast']]
    elif kind == 'skin':
        sel = None
        g = (SKIN_GAMMA[colors['skinContrast']],) * 3
        s = None
    elif kind == 'body':
        sel = HAIR_SWAP[colors['bodyRgb']]
        g = (1000, 1000, 1000)
        s = GRAY[colors['bodyContrast']]
    else:
        sel = None
        g = None
        s = None
    for y in range(h):
        for x in range(w):
            r, gr, b, a = px[x, y]
            if sel:
                src = (r, gr, b)
                r, gr, b = src[sel[0]], src[sel[1]], src[sel[2]]
            if kind == 'skin':
                # 原程序顺序：Shade 先、Gamma 后（非交换，顺序不能错）
                mul = SKIN_MUL[colors['skinRgb']]
                r = min(255, (r * mul[0] + 500) // 1000)
                gr = min(255, (gr * mul[1] + 500) // 1000)
                b = min(255, (b * mul[2] + 500) // 1000)
            if g:
                lr, lg, lb = lut(g[0]), lut(g[1]), lut(g[2])
                r, gr, b = lr[r], lg[gr], lb[b]
            if s is not None and s > 0:
                gray = (306 * r + 601 * gr + 117 * b + 512) >> 10
                inv = 255 - s
                r = (inv * r + s * gray + 127) // 255
                gr = (inv * gr + s * gray + 127) // 255
                b = (inv * b + s * gray + 127) // 255
            r = min(255, max(0, r + TONE))
            gr = min(255, max(0, gr + TONE))
            b = min(255, max(0, b + TONE))
            px[x, y] = (r, gr, b, a)
    return img

def blend(dst, src):
    """HSP gmode 7 公式。dst/src 均为 RGBA Image。"""
    dp, sp = dst.load(), src.load()
    w, h = dst.size
    for y in range(h):
        for x in range(w):
            sr, sg, sb, a = sp[x, y]
            if a == 0:
                continue
            if a == 255:
                dp[x, y] = (sr, sg, sb, 255)
            else:
                dr, dg, db, _ = dp[x, y]
                ia = 255 - a
                nr = ((dr * ia) >> 8) + ((sr * a) >> 8)
                ng = ((dg * ia) >> 8) + ((sg * a) >> 8)
                nb = ((db * ia) >> 8) + ((sb * a) >> 8)
                dp[x, y] = (nr, ng, nb, 255)

def render(set_name, parts, accessories, colors, bg=(255, 255, 255)):
    folders, size, ini = load_set(set_name)
    w, h = size
    canvas = Image.new('RGBA', (w, h), tuple(bg) + (255,))
    for layer, key in LAYER_ORDER:
        if key == 'acc':
            pool = folders.get(layer, {})
            for name in reversed(accessories):
                img = pool.get(name)
                if img is None:
                    continue
                img2 = img.copy()
                apply_ops(img2, None, colors, decoded_name=name, is_acc=True)
                blend(canvas, img2)
        else:
            part_name = parts[key or layer]
            if not part_name:
                continue
            img = folders.get(layer, {}).get(part_name)
            if img is None:
                continue
            img2 = img.copy()
            apply_ops(img2, LAYER_KIND.get(layer, 'plain'), colors)
            blend(canvas, img2)
    return canvas

def ini_colors(ini):
    def i(k, d):
        try: return int(ini.get(k, d))
        except Exception: return d
    return {
        'hairRgb': i('Color.hair_rgb', 0), 'hairContrast': i('Color.hair_gray', 3),
        'eyeRgb': i('Color.eye_rgb', 0), 'eyeContrast': i('Color.eye_gray', 3),
        'skinRgb': i('Color.skin_rgb', 0), 'skinContrast': i('Color.skin_gray', 3),
        'bodyRgb': i('Color.body_rgb', 0), 'bodyContrast': i('Color.body_gray', 3),
    }

def profile_overrides(set_name, parts, colors, accessories, bg):
    """应用 profile\<set>.dat（若存在），与原程序启动行为一致。"""
    p = os.path.join(PROFILE, set_name + '.dat')
    if not os.path.exists(p):
        return parts, colors, accessories, bg
    sec = ''
    prof = {}
    for line in open(p, 'rb').read().decode('cp932').splitlines():
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            sec = line[1:-1]; continue
        if '=' in line:
            k, v = line.split('=', 1)
            prof[sec + '.' + k.strip()] = v.strip()
    for k in ('hair_front', 'hair_back', 'head', 'face', 'eye', 'body'):
        if prof.get('Parts.' + k):
            parts[k] = prof['Parts.' + k]
    acc = [a for a in (prof.get('Parts.accessory', '') or '').split(',') if a]
    if acc:
        accessories = [decode_name(a) for a in acc]
    if prof.get('Color.hair_rgb'):
        colors['hairRgb'] = int(prof['Color.hair_rgb'])
    if prof.get('Color.hair_gray'):
        colors['hairContrast'] = int(prof['Color.hair_gray'])
    if prof.get('Color.eye_rgb'):
        colors['eyeRgb'] = int(prof['Color.eye_rgb'])
    if prof.get('Color.eye_gray'):
        colors['eyeContrast'] = int(prof['Color.eye_gray'])
    if prof.get('Color.skin_rgb'):
        colors['skinRgb'] = int(prof['Color.skin_rgb'])
    if prof.get('Color.skin_gray'):
        colors['skinContrast'] = int(prof['Color.skin_gray'])
    if prof.get('Color.body_rgb'):
        colors['bodyRgb'] = int(prof['Color.body_rgb'])
    if prof.get('Color.body_gray'):
        colors['bodyContrast'] = int(prof['Color.body_gray'])
    if prof.get('Color.bg_rgb'):
        bg = tuple(int(x) for x in prof['Color.bg_rgb'].split(','))
    return parts, colors, accessories, bg
