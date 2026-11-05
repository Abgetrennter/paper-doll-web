"""比对测试矩阵：Python 参考 vs JS 渲染。"""
import os, json
from PIL import Image

OUT = r'E:\Code\paper_doll_v2\test\matrix'
labels = ["kaoruset-profile","kaoruset-hair-yellow-noacc","kaoruset-body-black-dark",
          "male-ini-default","male-hair-pink-acc","remiria-profile",
          "remiria-tanned-white-eye","remiria-red-darkbg-2acc"]

summary = []
for label in labels:
    ref_p = os.path.join(OUT, label + '_ref.png')
    js_p = os.path.join(OUT, label + '_js.png')
    ref = Image.open(ref_p).convert('RGB')
    js = Image.open(js_p).convert('RGB')
    if ref.size != js.size:
        summary.append(f'{label}: SIZE MISMATCH {ref.size} vs {js.size}')
        continue
    W, H = ref.size
    o, m = ref.load(), js.load()
    diff = 0; maxd = 0
    for y in range(H):
        for x in range(W):
            a = o[x, y]; b = m[x, y]
            d = max(abs(a[0]-b[0]), abs(a[1]-b[1]), abs(a[2]-b[2]))
            if d > 0:
                diff += 1
                if d > maxd: maxd = d
    pct = 100.0 * diff / (W * H)
    summary.append(f'{label}: diff {diff}/{W*H} ({pct:.3f}%), max {maxd}')

print('\n'.join(summary))
