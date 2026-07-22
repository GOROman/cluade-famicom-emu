# claude-famicom-emu

Webブラウザで動くファミコン(NES)エミュレータ。コアは C++ で実装し、Emscripten で WebAssembly にコンパイルしています。Android Chrome 対応(タッチ仮想パッド付き)。

## 機能

- .NES ファイル (iNES形式) の読み込み
- 6502 CPU(全公式命令 + 主要非公式命令、nestest 全8991行一致)
- PPU(サイクル精度、スクロール、スプライト0ヒット)
- APU(矩形波×2 / 三角波 / ノイズ / DPCM)— AudioWorklet 再生(非HTTPSでは ScriptProcessor にフォールバック)
- マッパー: 0 (NROM) / 1 (MMC1) / 2 (UxROM) / 3 (CNROM) / 4 (MMC3, スキャンラインIRQ)
- バッテリーバックアップ(SRAM)を localStorage に自動保存
- タッチ仮想パッド(マルチタッチ・スライド対応、Android Chrome 用)

## ビルド

Emscripten (emcc) が必要です。

```sh
./build.sh   # → web/nes.js + web/nes.wasm を生成
```

## 実行

```sh
cd web
python3 -m http.server 8765 --bind 0.0.0.0
```

- PC: http://localhost:8765/
- Android: 同じLAN内から `http://<MacのIP>:8765/` を開く

「ROMを開く」で手持ちの .NES ファイルを選択すると起動します。

## 操作

| NES | キーボード | タッチ |
|-----|-----------|--------|
| 十字キー | 矢印キー | 左下パッド |
| A | X | 右下 A |
| B | Z | 右下 B |
| Start | Enter | START |
| Select | Shift | SELECT |

## 構成

```
core/    C++ エミュレータコア (cpu/ppu/apu/cartridge/nes)
web/     フロントエンド (index.html / main.js / audio-worklet.js) + WASM出力
build.sh Emscripten ビルドスクリプト
```

## テスト

nestest.nes によるCPU検証(ネイティブビルド):

```sh
# scratchpad等に nestest.nes / nestest.log を置いて
c++ -O2 -std=c++17 -I core nestest_main.cpp core/*.cpp -o nestest_run
./nestest_run nestest.nes nestest.log
```
