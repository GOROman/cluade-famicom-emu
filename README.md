# claude-famicom-emu

Webブラウザで動くファミコン(NES)エミュレータ。コアは C++ で実装し、Emscripten で WebAssembly にコンパイルしています。

**▶ 遊ぶ: https://goroman.github.io/cluade-famicom-emu/**

「ROMを開く」で手持ちの .NES ファイル(iNES形式)を読み込むと起動します。PC・Android Chrome 対応。

## 特徴

### エミュレーションコア (C++/WASM)
- 6502 CPU — 全公式命令+主要非公式命令。nestest 全8991ステップをサイクル数まで完全一致
- PPU — サイクル精度のスキャンライン処理、Loopyスクロール、スプライト0ヒット
- APU — 矩形波×2 / 三角波 / ノイズ / DPCM。AudioWorklet 再生(非HTTPS環境では ScriptProcessor に自動フォールバック)
- マッパー: 0 (NROM) / 1 (MMC1) / 2 (UxROM) / 3 (CNROM, 64KBオーバーサイズ対応) / 4 (MMC3, スキャンラインIRQ)
- 旧形式 iNES ヘッダ("DiskDude!" 等のゴミ入り)対応
- バッテリーバックアップ (SRAM) を localStorage に自動保存

### カートリッジ端子シミュレーション(「端子」モード・起動時オン)
- **60ピンのカードエッジを表示**(実機ピンアサイン準拠)。ピンをクリックすると接触不良をトグル
- 断線の影響を物理的に再現: アドレス線欠落→暴走、データ線欠落→化け、CIRAM系→ネームテーブル破壊、SOUND断→無音、電源は 1/16(GND)・30/31(+5V) の冗長構成
- **カートリッジ正面図**(実機形状トレースのSVG)を傾けて**半挿しをシミュレート**: スライダー±6°(0.1°刻み)。浮いた側の端子から接触がフレーム毎に不安定になる
- **息(フーフー)💨** — 接触不良が65%で復活、ただしPPU側端子が10%で新たにダメになる(湿気)。SE付き、リセット同時押下
- **挿し直す** — 全ピン復旧+傾き0°+リセット

### デバッグ機能(DEBUGボタン / Dキー)
- 左: CGROM(CHRパターンテーブル)ビューア — 現在のPPUパレットで着色、クリックでBG/SPパレット切替。端子の接触不良も描画に反映
- 右: APU 6ch 波形スコープ(SQ1/SQ2/TRI/NOI/DMC/MIX)、APUレジスタダンプ($4000-$4017)、WRAMダンプ($0000-$07FF)

### XEVIOUS判定(ダンプ診断ツール)
読み込んだROMの PRG/CHR CRC32 を正規ダンプ(PRG=EEB16683 / CHR=668B4EE6)と照合。
CGROM が NG の場合、**ダンパーの結線ミスを自動診断**:
- アドレス線の固定/断線検出(鏡像重複解析)
- アドレス線 A0-A12・データ線 D0-D7 の1本入れ替え全パターン照合(「A3↔A5 を入れ替えると一致」のように特定)

## 操作

| NES | キーボード | タッチ | ゲームパッド |
|-----|-----------|--------|------------|
| 十字キー | 矢印キー | 左下パッド | 十字キー / 左スティック |
| A | X | A | 右ボタン |
| B | Z | B | 下ボタン |
| Start | Enter | START | Start |
| Select | Shift | SELECT | Select |

ホットキー: **F**=フルスクリーン / **R**=リセット / **D**=デバッグパネル

USBゲームパッドは Gamepad API 対応(接続するとステータス欄に名前表示)。

## ビルド

Emscripten (emcc) が必要です。

```sh
./build.sh   # → web/nes.js + web/nes.wasm 生成、index.html にキャッシュバスト版数を刻印
```

## ローカル実行

```sh
cd web
python3 -m http.server 8765 --bind 0.0.0.0
```

- PC: http://localhost:8765/
- Android: 同一LANから `http://<ホストのIP>:8765/`

## デプロイ (GitHub Pages)

`web/` を `gh-pages` ブランチとして配信しています。

```sh
./build.sh
git add -A && git commit -m "..."
git push
git subtree push --prefix web origin gh-pages
```

## 構成

```
core/    C++ エミュレータコア
  cpu.cpp        6502
  ppu.cpp        PPU (パレット、端子故障の反映含む)
  apu.cpp        APU + チャンネル別スコープ用バッファ
  cartridge.cpp  iNESローダ + マッパー 0-4
  nes.cpp        バス統合、60ピン端子故障モデル、WASM C API
web/     フロントエンド (index.html / main.js / audio-worklet.js) + WASM出力
build.sh Emscripten ビルド + バージョン刻印
```

## テスト

- CPU: nestest.nes をリファレンスログと突き合わせるネイティブハーネスで検証
- マッパー/ヘッダ/端子故障: 合成ROMによるユニットテスト(ネイティブビルド)

※ ROMファイルはリポジトリに含まれません。手持ちの .NES ファイルをご利用ください。
