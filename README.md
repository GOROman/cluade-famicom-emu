# claude-famicom-emu

A Famicom (NES) emulator that runs in the browser. The core is written in C++ and compiled to WebAssembly with Emscripten — with a hardware playground on top: a live 60-pin cartridge connector you can break, a cartridge you can tilt to simulate a half-inserted cart, and an oscilloscope you can probe any pin with.

**▶ Play: https://goroman.github.io/cluade-famicom-emu/**

Open any .NES file (iNES format) with "Open ROM". Works on desktop and Android Chrome.

🌐 [日本語](README.ja.md) · [中文](README.zh.md)

## Features

### Emulation core (C++ / WASM)
- **6502 CPU** — all official opcodes plus the common unofficial ones. Verified against nestest.nes: all 8991 steps match the reference log down to cycle counts.
- **PPU** — cycle-accurate scanline rendering, Loopy scrolling, sprite 0 hit, sprite overflow.
- **APU** — 2 pulse + triangle + noise + DPCM, played through an AudioWorklet (falls back to ScriptProcessor on non-HTTPS origins).
- **Mappers** — 0 (NROM), 1 (MMC1), 2 (UxROM), 3 (CNROM, including oversize 64 KB CHR), 4 (MMC3 with scanline IRQ).
- Archaic iNES headers (the ones with `DiskDude!` garbage in the tail) are handled.
- Battery-backed SRAM is saved to localStorage automatically.

### Cartridge connector simulation ("PINS" mode, on by default)
- The **60-pin card edge** is drawn to the real pinout. Click a pin to break its contact.
- Breakage is modeled physically: missing address lines send the CPU to the wrong place, missing data lines return open-bus garbage, CIRAM faults wreck the nametables, a broken SOUND pin mutes the console (Famicom audio loops through the cartridge), and power is redundant across pins 1/16 (GND) and 30/31 (+5V).
- **Tilt the cartridge** with the slider (±6°, 0.1° steps) or by dragging it — the lifted side of the connector goes intermittent, then dead, exactly like a half-inserted cart.
- **Blow 💨** — clears a bad contact 65 % of the time, but each good PPU-side pin has a 10 % chance of going bad from the moisture. Comes with a sound effect and a reset, as tradition demands.
- **Re-insert** restores every pin, straightens the cart and resets.

### Hot cartridge swap (bug techniques)
The **RESET** button behaves like the real one — work RAM survives. **Swap Cart** loads a new ROM *without any reset at all*, so the classic swap-carts-with-the-power-on tricks work (Super Mario → Tennis → Super Mario for the minus/9-1 world). The dialog can also take the PRG-ROM and the CHR-ROM from **different cartridges** to build a franken-cart, or fetch a ROM straight **from a URL**.

### Debugging (DEBUG button / D key)
- **CHR (CGROM) viewer** — pattern tables colorized with the live PPU palette; click to cycle BG/sprite palettes. Connector faults show up here too.
- **Oscilloscope** — hover any connector pin (or the /NMI, APU /IRQ, MAPPER /IRQ test points) to attach a probe. The core samples that signal every CPU cycle; below 60 kHz the scope switches to a real-time strip chart.
- **CPU registers + disassembly** — PC/A/X/Y/SP/P with flags and a frame counter, over a live 12-instruction disassembly from PC.
- **APU** — six waveform scopes (SQ1/SQ2/TRI/NOI/DMC/MIX, click a label to mute that channel) and a register dump of $4000–$4017.
- **WRAM dump** — double-click a byte to edit it. Changed bytes glow; bytes that change constantly (timers, RNG) are grayed out. With Super Mario Bros. loaded, hovering a byte shows its variable name and comment from [SMBDIS.ASM](https://gist.github.com/1wErt3r/4048722).

### Variable clock
Slider and Hz input under the connector, spanning **1 Hz to the stock 1.789773 MHz** (logarithmic). The main loop paces by CPU cycles, so single-digit-Hz clocks really do step — you can watch the raster crawl across a frame. Audio pitch follows the clock.

### TAS playback
Load an FCEUX **.fm2** movie with the TAS button. Playback power-cycles with the FCEUX RAM pattern and then steps frame by frame with the movie's inputs; soft-reset and power commands in the movie are honored.

### Also
- USB gamepads (Gamepad API), a touch pad for Android, fullscreen (F).
- UI in English, Japanese and Chinese; follows the browser locale by default.
- **XEVIOUS dump check** — a hidden diagnostic that compares PRG/CHR CRC32s against a known-good dump and, when the CHR doesn't match, works out which address or data line the dumper had miswired.

## URL parameters

`https://goroman.github.io/cluade-famicom-emu/?rom=<URL>&debug=1&pin=0`

| Parameter | Effect |
|-----------|--------|
| `rom=<URL>` | Fetch and boot a .NES file from a URL (the host must allow CORS — GitHub raw does) |
| `debug=1` | Start with the debug panel open |
| `pin=0` / `pin=1` | Hide / show the connector panel (shown by default) |
| `clock=<Hz>` | Clock frequency, 1–1789773 |
| `tilt=<deg>` | Cartridge tilt, ±6 |
| `break=25,29` | Start with these pins disconnected |
| `mute=1` | Start muted |
| `lang=en/ja/zh/auto` | UI language |

## Controls

| NES | Keyboard | Touch | Gamepad |
|-----|----------|-------|---------|
| D-pad | Arrow keys | on-screen pad | D-pad / left stick |
| A | X | A | right face button |
| B | Z | B | bottom face button |
| Start | Enter | START | Start |
| Select | Shift | SELECT | Select |

Hotkeys: **F** fullscreen · **R** reset (held = held in reset) · **D** debug panel

## Build

Requires Emscripten (`emcc`).

```sh
./build.sh   # → web/nes.js + web/nes.wasm, stamps a cache-busting version into index.html
```

## Run locally

```sh
cd web
python3 -m http.server 8765 --bind 0.0.0.0
```

- Desktop: http://localhost:8765/
- Android: `http://<host IP>:8765/` from the same network

## Deploy (GitHub Pages)

`web/` is published as the `gh-pages` branch.

```sh
./build.sh
git add -A && git commit -m "..."
git push
git subtree push --prefix web origin gh-pages
```

## Layout

```
core/    C++ emulator core
  cpu.cpp        6502
  ppu.cpp        PPU (palette, connector faults, NMI line)
  apu.cpp        APU + per-channel scope buffers
  cartridge.cpp  iNES loader + mappers 0-4
  nes.cpp        bus, 60-pin fault model, oscilloscope probe, WASM C API
web/     frontend (index.html / main.js / i18n.js / audio-worklet.js) + WASM output
build.sh Emscripten build + version stamping
```

## Tests

- **CPU**: a native harness runs nestest.nes against the reference log.
- **Mappers, headers, connector faults**: unit tests with synthetic ROMs (native build).

No ROMs are included in this repository — bring your own .NES files.
