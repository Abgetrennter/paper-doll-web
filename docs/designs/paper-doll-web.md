# 设计稿：纸娃娃换装工具 Web 重写版（paper-doll-web）

- 日期：2026-11-06
- 状态：待用户确认
- 前置研究：`E:\Code\paper_doll_v2\research\`（解密 ax、反编译源码、imgctl 手册与反汇编结论）

## 1. 目标 / 非目标 / 收口判据（需求肖像终稿）

**目标**：浏览器网页版换装纸娃娃工具，1:1 复刻「キャラクターなんとか機」v2.10（character.exe）全部功能，界面为中文；直接读取现有 `E:\Code\paper_doll_fixed\data\` 三套素材，部件名还原为正常日文显示，磁盘文件不动。

**非目标**：素材编辑器、在线分享、多人、移动端、素材批量管理器、复刻之外的新功能。

**收口判据**：
1. 三套角色集（kaoruset / kaoru_set_male00 / remiria）全部加载，部件列表完整；
2. 换色（发/瞳/肤/服）、饰品增删与排序（上限 6）、存档读写、图片导出全部可用；
3. 同配置下渲染结果与原程序像素级一致（验收方法见 §7）；
4. 界面全中文、零乱码，部件名为正常日文。

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 形态 | 纯静态单页，**单个 index.html**（CSS/JS 全部内联） | 双击即用，file:// 下 ES module 与 fetch 均受限，单文件内联脚本绕开全部限制；零构建、零依赖 |
| 语言 | 原生 JavaScript（ES2017+）+ Canvas 2D | 规模小（预计 1~2 千行），不值得引入框架与工具链 |
| 数据载入 | `<input type="file" webkitdirectory>` 选目录 + 目录拖拽 | file:// 可用；数据不出本机 |
| 状态持久化 | localStorage 自动保存 + 手动导出/导入 JSON | file:// 下 localStorage 可用 |
| 浏览器要求 | Chrome / Edge（webkitdirectory、createImageBitmap） | 用户环境默认满足 |

备选（本轮不做）：本地 HTTP 小服务器模式（若日后需要更大的缓存或 PWA）。

## 3. 逆向规格（重写的唯一依据，已全部核实）

来源：start.ax 解密（另一条线成果，密钥 add=0x3e xor=0xdf）→ HSPdecom 反编译（3278 行，`research\decompiled.txt`）→ imgctl.dll 反汇编（随包 2007 年版，与 1.27 手册逐函数核对）。

### 3.1 数据布局

- `data\<角色集>\`：16 个图层文件夹 + `character.ini`（Shift_JIS）+ `readme.txt`（角色集说明）。
- 图层合成顺序（先→后，即底→顶）：
  `accessory_back → hair_back → hair_back_accessory → body_back → accessory_underwear → body_front → body_front_color → accessory_middle_back → head → accessory_middle_front → face_back → hair_front → hair_front_accessory → face_front → eye → accessory_front`
- 部件 = 32 位 PNG（alpha 透明）；文件名 = 部件名。菜单可见性：accessory_back / hair_front / hair_back / face_front / body_back 有文件才在界面出现，其余层可缺省。
- `character.ini`：`[Size] size_x/size_y`（画布尺寸）、`[Parts]` 各层默认选择、`[Color]` 各默认色。
- 饰品：用户列表，序号 0 在最前；上限 `accessory_max`（默认 6）；文件名含 `（髪）（瞳）（肌）（服）` 时套用对应换色。

### 3.2 文件名乱码还原

磁盘名是「Shift_JIS 字节按 GBK 解释」的乱码名。解码：`乱码字符串 → 按 GBK 编码回字节 → 按 CP932 解码`。例如 `偍忟條 → お嬢様`。
规则：先按 GBK 编码，成功且 CP932 解码成功则用解码结果；纯 ASCII 或任一步失败则原样使用（兼容未来正常日文命名的角色集）。
INI/存档内容（cp932）用同一套解码。

### 3.3 换色管线（逐图层、自上而下应用）

每个图层 PNG 解码为 RGBA 后，按图层类型依次施加：

| 图层 | 处理序列 |
|---|---|
| hair_front / hair_back / 饰品(髪) | ChannelSwap(hair) → Gamma(hair_gr,gg,gb) → Gray(hair_c) → Tone(2,2,2) |
| eye / 饰品(瞳) | ChannelSwap(eye) → Gray(eye_c) → Tone(2,2,2) |
| body_back / 饰品(肌) | Shade(skin_r,g,b) → Gamma(skin_c,skin_c,skin_c) → Tone(2,2,2) |
| body_front_color / 饰品(服) | ChannelSwap(body) → Gray(body_c) → Tone(2,2,2) |
| head / face / hair_*_accessory / body_front / 其余饰品 | Tone(2,2,2) |

四个原语（均为对每个不透明像素的 RGB 三通道独立运算，**不碰 alpha**；全部整数/查表实现，公式与随包 imgctl.dll 反汇编结果一致）：

1. **ChannelSwap**（ReplaceDIB，参数先对 3 取模得通道选择器，0=R,1=G,2=B）：
   `newR = old[selR]`, `newG = old[selG]`, `newB = old[selB]`
2. **Gamma**（GammaDIB，参数为千分比）：`out = round255(pow(c/255, 1000/arg))`，arg=1000 即恒等
3. **Shade**（ShadeDIB，千分比乘法）：`out = min(255, (c·mul + 500) / 1000)`（整数除法）
4. **Gray**（GrayDIB，s=0..255 扺色化强度）：
   `gray = (306·R + 601·G + 117·B + 512) >> 10`
   `out = ((255-s)·c + s·gray + 127) / 255`（整数除法）
5. **Tone**（ToneDIB）：`out = clamp(c + move, 0, 255)`；本程序固定 move=2

### 3.4 色表（反编译所得，逐桶核实）

**发色 hair_rgb 0–10**（ChannelSwap 选择器 + 附加 Gamma）：

| 桶 | memo 名称 | (selR,selG,selB) | Gamma(千分之一) |
|---|---|---|---|
| 0 | 青 | (R,R,B) 恒等 | (1000,1000,1000) |
| 1 | 紫 | (B,R,B) | 同上 |
| 2 | 赤 | (B,R,R) | 同上 |
| 3 | 黄 | (B,B,R) | 同上 |
| 4 | 緑 | (R,B,R) | 同上 |
| 5 | 水色 | (R,B,B) | 同上 |
| 6 | 黒 | (R,R,R) | 同上 |
| 7 | 白 | (B,B,B) | 同上 |
| 8 | 茶色 | (B,R,R) | (700,1000,1000) |
| 9 | 橙 | (B,R,R) | (2000,1500,1000) |
| 10 | 桃色 | (B,R,R) | (3000,1200,1200) |

（原始参数值：0=(255,255,128)、1=(128,255,128)、2=(128,255,255)、3=(128,128,255)、4=(255,128,255)、5=(255,128,128)、6=(0,0,0)、7=(128,128,128)、8/9/10 同 2。）

**瞳色 eye_rgb 0–7**：同上表 0–7 的选择器，无 Gamma。
**服色 body_rgb 0–7**：同上表 0–7，无 Gamma。

**明るさ滑杆（hair/eye/body 的 contrast，0–6）→ Gray 强度 s**：`0,32,64,128,192,224,255`。

**肤色 skin_rgb 0–4**（Shade 千分比乘数）：
| 桶 | memo 名称 | (mulR,mulG,mulB) |
|---|---|---|
| 0 | 標準 | (1000,1000,1000) |
| 1 | 褐色 | (900,700,700) |
| 2 | 黄色 | (1050,1050,1000) |
| 3 | 日焼け | (1200,950,950) |
| 4 | 不健康 | (1200,1050,1200) |

**肤色明るさ（skin_contrast 0–6）→ Gamma (c,c,c)**：`1600,1400,1200,1000,900,800,700`。

### 3.5 存档与配置

- `config.ini`（cp932）：`[Option] character/profile_save/jpeg_quality/no_antialiasing/window_resize`；`[System] preview_wait/accessory_max`。
- `profile\<角色集>.dat` 与 `.cpd`（cp932 INI）：`[Character] name`；`[Parts] hair_front/hair_back/head/face/eye/body/accessory(逗号分隔)`；`[Color] hair_rgb/hair_gray/eye_rgb/eye_gray/skin_rgb/skin_gray/body_rgb/body_gray/bg_rgb`。
  注意：键名 `*_gray` 实际语义是 Gray 强度（明るさ）。
- 新版：JSON 存档为主，**兼容导入原 .dat/.cpd**（解析 + 乱码名还原）；导出 JSON 不必兼容回 .dat。

### 3.6 导出

- 预览图：PNG / BMP / JPG（质量默认 80）/ GIF（新版拟只保留 PNG/JPG，GIF 列为待定）
- 透明背景 PNG（RGBA）
- 伺か用：`surface.png`（RGBA）+ `surface.pna`（alpha 转灰度 PNG）
- 背景色可改（默认白）

### 3.7 原版 UI 参考（新中文版的布局依据）

窗口 640×480 客户区：左侧 320px 控制区（两个 90px 宽列表框一排），右侧为画布尺寸的预览区；标签页：パーツ選択 / カラー選択 / キャラクター選択；菜单：文件(打开/保存设定、预览保存、透明保存、伺か保存、退出)、编辑(卸下全部饰品)、帮助(关于)。

新 UI（中文）：
- 左栏标签页：**部件 / 颜色 / 角色**
  - 部件页：髪(前)/髪(后)/头/表情/眼/身体 六个列表框（原布局两列三排），饰品管理（已装备列表 + 添加/移除/上移/下移）
  - 颜色页：髪の毛→头发、瞳→眼睛、肌→皮肤、服→服装 四组「色相 + 明暗」选择器（色相为色块下拉或色块行，明暗为 7 档滑杆），背景色选择
  - 角色页：角色集列表 + readme 说明显示
- 右侧：预览画布（按 character.ini 原尺寸，窗口缩放显示）
- 顶栏按钮：打开设定 / 保存设定 / 导出图像 / 透明导出 / 伺か导出

## 4. 模块划分（单文件内的逻辑分区）

1. `loader`：目录枚举、cp932/乱码解码、character.ini 解析
2. `state`：当前角色集/部件/颜色/背景，localStorage 同步
3. `pipeline`：§3.3-3.4 的像素运算（ImageData 上原地操作）
4. `renderer`：按层序合成（source-over），缩放显示
5. `exporter`：PNG/JPG/透明 PNG/PNA
6. `ui`：标签页、列表、滑杆、按钮、菜单

## 5. 性能与缓存

- 换色结果按 `(部件, 颜色状态)` 缓存 ImageData/Canvas，颜色滑杆拖动仅重算受影响图层；
- 首次加载用 createImageBitmap 解码 PNG，原始位图缓存一份（换色基底）。

## 6. 里程碑

- **M1 核心闭环**：目录加载 + 全图层合成 + 完整换色管线，与原程序逐像素比对通过
- **M2 完整 UI**：三标签页、饰品管理、角色切换、背景色
- **M3 存档与导出**：JSON 存档、.dat 导入、PNG/JPG/透明/PNA 导出
- **M4 收尾**：单文件打包、使用说明、验收清单过一遍

## 7. 验收方法（收口判据 3 的落地）

1. 在原程序中按固定配置矩阵（3 角色集 × 若干色相/明暗组合）导出 PNG 作基准图；
2. 新程序加载同一数据、同一配置导出 PNG；
3. Python 脚本逐像素比对：要求非抗锯齿区域通道差 ≤ 1（查表运算应完全一致），全图不一致像素占比 = 0%（JPEG 对比另行按感知阈值）；
4. 有差异时按层二分定位（单层导出比对）。

## 8. 风险与备注

- **版权**：反编译产物仅作个人研究与互操作，不随新程序分发；新程序代码为独立实现；素材沿用原作。
- HSP 的 gmode 合成细节未逐指令核对，以「标准 alpha source-over + 验收比对」兜底；若比对出现系统性差异再回到反编译源码核对 label_81/82。
- GIF 导出与 no_antialiasing（GIF 调色板抖动相关）列为待定，M3 时决定是否补。
- `preview_wait`、`window_resize` 等 HSP 特有参数无对应物，不迁移。
