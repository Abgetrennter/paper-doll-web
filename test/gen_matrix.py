"""测试矩阵：多配置下 Python 参考渲染 vs JS 应用渲染 逐像素比对。"""
import sys, os, io, json, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reference_renderer import render, load_set, ini_colors, profile_overrides
from PIL import Image

CONFIGS = [
    # (set, parts覆盖(None=ini默认+profile), accessories覆盖, colors覆盖, bg, 说明)
    ('kaoruset', None, None, None, None, 'kaoruset-profile'),
    ('kaoruset', None, [], {'hairRgb': 3, 'hairContrast': 0}, None, 'kaoruset-hair-yellow-noacc'),
    ('kaoruset', None, None, {'bodyRgb': 6, 'bodyContrast': 6}, None, 'kaoruset-body-black-dark'),
    ('kaoru_set_male00', None, None, None, None, 'male-ini-default'),
    ('kaoru_set_male00', None, ['アホ毛(髪)'], {'hairRgb': 10, 'hairContrast': 1}, None, 'male-hair-pink-acc'),
    ('remiria', None, None, None, None, 'remiria-profile'),
    ('remiria', None, None, {'skinRgb': 3, 'skinContrast': 0, 'eyeRgb': 7}, None, 'remiria-tanned-white-eye'),
    ('remiria', None, ['悪魔の羽', '襟飾り'], {'bodyRgb': 2}, (30, 30, 40), 'remiria-red-darkbg-2acc'),
]

OUT = r'E:\Code\paper_doll_v2\test\matrix'
os.makedirs(OUT, exist_ok=True)

results = []
for set_name, parts_ov, acc_ov, color_ov, bg_ov, label in CONFIGS:
    folders, size, ini = load_set(set_name)
    parts = {
        'hair_front': ini.get('Parts.hair_front', ''), 'hair_back': ini.get('Parts.hair_back', ''),
        'head': ini.get('Parts.head', ''), 'face': ini.get('Parts.face', ''),
        'eye': ini.get('Parts.eye', ''), 'body': ini.get('Parts.body', ''),
    }
    accessories = [a for a in (ini.get('Parts.accessory', '') or '').split(',') if a]
    colors = ini_colors(ini)
    bg = (255, 255, 255)
    parts, colors, accessories, bg = profile_overrides(set_name, parts, colors, accessories, bg)
    if parts_ov: parts.update(parts_ov)
    if acc_ov is not None: accessories = acc_ov
    if color_ov: colors.update(color_ov)
    if bg_ov: bg = bg_ov

    ref = render(set_name, parts, accessories, colors, bg)
    ref.save(os.path.join(OUT, label + '_ref.png'))

    # 传给浏览器的配置（JSON）
    cfg = {
        'set': set_name,
        'parts': parts,
        'accessories': accessories,
        'colors': colors,
        'bg': list(bg),
        'label': label,
    }
    with open(os.path.join(OUT, label + '.json'), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False)
    results.append(label)
    print('rendered ref:', label, size)

print('configs:', json.dumps(results))
