# claude-famicom-emu

在浏览器中运行的红白机(NES / Famicom)模拟器。核心用 C++ 编写,通过 Emscripten 编译为 WebAssembly。在此之上还有一层"玩硬件"的功能——可以点击弄断的60针卡边连接器、可以倾斜以模拟卡带没插到底的卡带、以及可以探测任意引脚的示波器。

**▶ 试玩: https://goroman.github.io/cluade-famicom-emu/**

用"打开ROM"载入你自己的 .NES 文件(iNES格式)即可启动。支持桌面端与 Android Chrome。

🌐 [English](README.md) · [日本語](README.ja.md)

## 功能

### 模拟核心 (C++ / WASM)
- **6502 CPU** — 全部官方指令加上常用的非官方指令。已用 nestest.nes 验证:全部 8991 步与参考日志完全一致,精确到周期数。
- **PPU** — 周期精确的扫描线处理、Loopy 滚动、精灵0命中、精灵溢出。
- **APU** — 2个方波 + 三角波 + 噪声 + DPCM,通过 AudioWorklet 播放(非 HTTPS 环境自动回退到 ScriptProcessor)。
- **Mapper** — 0 (NROM)、1 (MMC1)、2 (UxROM)、3 (CNROM,含 64KB 超大 CHR)、4 (MMC3,含扫描线 IRQ)。
- 支持古老的 iNES 文件头(尾部带有 `DiskDude!` 等垃圾数据的那种)。
- 电池备份 SRAM 自动保存到 localStorage。

### 卡带端子模拟("端子"模式,默认开启)
- 按真实针脚定义绘制的 **60针卡边连接器**。点击引脚即可切换接触不良。
- 断线效果按物理原理模拟:地址线缺失会让 CPU 读到错误位置而跑飞,数据线缺失会读到开路总线的乱码,CIRAM 相关引脚断线会摧毁名称表,SOUND 引脚断线会导致完全无声(红白机的音频要经过卡带),电源则由 1/16 号(GND)与 30/31 号(+5V)冗余供给。
- **倾斜卡带** — 用滑块(±6°,0.1°步进)或直接拖动。翘起一侧的引脚会先变得时断时续,然后彻底断开,和卡带没插到底时一模一样。
- **吹气(呼呼)💨** — 接触不良有 65% 的概率恢复,但每个正常的 PPU 侧引脚有 10% 的概率因潮气而变坏。附带音效并自动复位(遵循传统)。
- **重新插入** — 恢复所有引脚、摆正卡带并复位。

### 带电热插拔卡带(Bug技)
**复位**按钮和真机一样保留工作 RAM。**更换卡带**则*完全不触发复位*就载入新 ROM,因此经典的"开着机换卡带"技巧可以正常成立(超级马里奥 → 网球 → 超级马里奥,进入 9-1)。对话框还支持把 **PRG-ROM 和 CHR-ROM 取自不同卡带**组成"拼装卡带",或者直接**从 URL** 获取 ROM。

### 调试功能(DEBUG 按钮 / D 键)
- **CHR (CGROM) 查看器** — 用当前 PPU 调色板着色显示图案表,点击可切换 BG/精灵调色板。端子接触不良也会体现在这里。
- **示波器** — 悬停任意连接器引脚(或 /NMI、APU /IRQ、MAPPER /IRQ 测试点)即可接上探针。核心每个 CPU 周期采样一次;低于 60 kHz 时会切换为实时滚动图。
- **CPU 寄存器 + 反汇编** — PC/A/X/Y/SP/P 与标志位、帧计数器,以及从 PC 开始的 12 条实时反汇编。
- **APU** — 六路波形示波器(SQ1/SQ2/TRI/NOI/DMC/MIX,点击标签可静音该通道)与 $4000–$4017 寄存器转储。
- **WRAM 转储** — 双击字节即可修改。变化的字节会发光,持续变化的字节(定时器、随机数)显示为灰色。载入超级马里奥时,悬停字节会显示来自 [SMBDIS.ASM](https://gist.github.com/1wErt3r/4048722) 的变量名与注释。

### 可变时钟
连接器下方的滑块与 Hz 输入框,范围从 **1 Hz 到标准的 1.789773 MHz**(对数刻度)。主循环按 CPU 周期推进,所以个位数 Hz 也能真正逐周期运行——你可以看到光栅缓慢扫过整个画面。音高也会跟随时钟变化。

### TAS 回放
用 TAS 按钮载入 FCEUX 的 **.fm2** 影片。回放会以 FCEUX 的 RAM 模式上电,然后按影片输入逐帧严格执行;影片中的软复位与电源指令也会被解释执行。

### 其他
- USB 手柄(Gamepad API)、Android 触摸手柄、全屏(F)。
- 界面支持英文、日文、中文,默认跟随浏览器语言。
- **XEVIOUS 检测** — 隐藏的诊断工具。将 PRG/CHR 的 CRC32 与正规转储比对,当 CHR 不匹配时,推断出转储器是哪根地址线或数据线接错了。

## URL 参数

`https://goroman.github.io/cluade-famicom-emu/?rom=<URL>&debug=1&pin=0`

| 参数 | 效果 |
|------|------|
| `rom=<URL>` | 从 URL 获取并启动 .NES 文件(需对方允许 CORS,GitHub raw 可以) |
| `debug=1` | 启动时打开调试面板 |
| `pin=0` / `pin=1` | 隐藏/显示端子面板(默认显示) |
| `clock=<Hz>` | 时钟频率(1–1789773) |
| `tilt=<度>` | 卡带倾斜角度(±6) |
| `break=25,29` | 启动时将这些引脚设为断线 |
| `mute=1` | 静音启动 |
| `lang=en/ja/zh/auto` | 界面语言 |

## 操作

| NES | 键盘 | 触摸 | 手柄 |
|-----|------|------|------|
| 十字键 | 方向键 | 屏幕下方手柄 | 十字键 / 左摇杆 |
| A | X | A | 右侧按键 |
| B | Z | B | 下方按键 |
| Start | Enter | START | Start |
| Select | Shift | SELECT | Select |

快捷键: **F** 全屏 · **R** 复位(按住则保持复位状态) · **D** 调试面板

## 构建

需要 Emscripten (`emcc`)。

```sh
./build.sh   # → 生成 web/nes.js + web/nes.wasm,并在 index.html 中刻入用于清除缓存的版本号
```

## 本地运行

```sh
cd web
python3 -m http.server 8765 --bind 0.0.0.0
```

- 桌面端: http://localhost:8765/
- Android: 同一网络下访问 `http://<主机IP>:8765/`

## 部署 (GitHub Pages)

`web/` 目录作为 `gh-pages` 分支发布。

```sh
./build.sh
git add -A && git commit -m "..."
git push
git subtree push --prefix web origin gh-pages
```

## 目录结构

```
core/    C++ 模拟器核心
  cpu.cpp        6502
  ppu.cpp        PPU(调色板、端子故障、NMI 线)
  apu.cpp        APU + 各通道示波器缓冲
  cartridge.cpp  iNES 载入器 + Mapper 0-4
  nes.cpp        总线、60针故障模型、示波器探针、WASM C API
web/     前端 (index.html / main.js / i18n.js / audio-worklet.js) + WASM 输出
build.sh Emscripten 构建 + 版本刻印
```

## 测试

- **CPU**: 用原生测试程序将 nestest.nes 与参考日志逐行比对。
- **Mapper、文件头、端子故障**: 使用合成 ROM 的单元测试(原生构建)。

本仓库不包含任何 ROM 文件,请使用你自己的 .NES 文件。
