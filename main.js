'use strict';

(async () => {
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(256, 240);
  const statusEl = document.getElementById('status');

  const Module = await createNesModule({
    // cache-bust the .wasm fetch with the same version as the scripts
    locateFile: (path) => path + '?v=' + (window.NES_VER || '0'),
  });
  const api = {
    init: Module._nes_init,
    romBuffer: Module._nes_rom_buffer,
    loadRom: Module._nes_load_rom,
    reset: Module._nes_reset,
    frame: Module._nes_frame,
    framebuffer: Module._nes_framebuffer,
    setButtons: Module._nes_set_buttons,
    audioBuffer: Module._nes_audio_buffer,
    audioCount: Module._nes_audio_sample_count,
    audioClear: Module._nes_audio_clear,
    ram: Module._nes_ram,
    setPin: Module._nes_set_pin,
    getPin: Module._nes_get_pin,
    resetPins: Module._nes_reset_pins,
    renderChr: Module._nes_render_chr,
    chanBuffer: Module._nes_chan_buffer,
    apuRegs: Module._nes_apu_regs,
    sram: Module._nes_sram,
    sramSize: Module._nes_sram_size,
    hasBattery: Module._nes_has_battery,
  };
  window.__nes = { api, Module, frames: 0, getButtons: () => buttons };

  // ------------------------------------------------------------------ audio
  let audioCtx = null;
  let audioNode = null;
  let muted = false;

  // fallback ring buffer for ScriptProcessorNode (insecure contexts have no AudioWorklet)
  const fallbackRing = new Float32Array(16384);
  let fbRead = 0, fbWrite = 0, fbAvail = 0, fbLast = 0;
  let pushSamples = null;

  async function initAudio() {
    if (audioCtx) return;
    audioCtx = new AudioContext({ sampleRate: 44100 });
    if (audioCtx.audioWorklet) {
      await audioCtx.audioWorklet.addModule('audio-worklet.js');
      audioNode = new AudioWorkletNode(audioCtx, 'nes-audio', { outputChannelCount: [1] });
      audioNode.connect(audioCtx.destination);
      pushSamples = (s) => audioNode.port.postMessage(s);
    } else {
      // http:// on a LAN address etc. — fall back to ScriptProcessorNode
      const sp = audioCtx.createScriptProcessor(1024, 0, 1);
      sp.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < out.length; i++) {
          if (fbAvail > 0) {
            fbLast = fallbackRing[fbRead];
            fbRead = (fbRead + 1) % fallbackRing.length;
            fbAvail--;
          }
          out[i] = fbLast;
        }
      };
      sp.connect(audioCtx.destination);
      audioNode = sp;
      pushSamples = (s) => {
        for (let i = 0; i < s.length; i++) {
          if (fbAvail >= fallbackRing.length) break;
          fallbackRing[fbWrite] = s[i];
          fbWrite = (fbWrite + 1) % fallbackRing.length;
          fbAvail++;
        }
      };
    }
    api.init(audioCtx.sampleRate);
  }
  api.init(44100); // provisional rate until AudioContext exists

  // Android Chrome requires a user gesture before audio can start
  async function resumeAudio() {
    try {
      await initAudio();
      if (audioCtx.state !== 'running') await audioCtx.resume();
    } catch (e) {
      console.warn('audio unavailable:', e);
    }
  }
  ['touchstart', 'mousedown', 'keydown'].forEach((ev) =>
    document.addEventListener(ev, resumeAudio, { once: false, passive: true }));

  // ------------------------------------------------------------------ input
  let buttons = 0; // bit0:A 1:B 2:Select 3:Start 4:Up 5:Down 6:Left 7:Right

  const KEYMAP = {
    KeyX: 1, KeyZ: 2, ShiftRight: 4, ShiftLeft: 4, Enter: 8,
    ArrowUp: 16, ArrowDown: 32, ArrowLeft: 64, ArrowRight: 128,
  };
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.getElementById('app').requestFullscreen().catch(() => {});
  }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF' && !e.repeat) { toggleFullscreen(); e.preventDefault(); return; }
    if (e.code === 'KeyR' && !e.repeat) { if (running) api.reset(); e.preventDefault(); return; }
    if (e.code === 'KeyD' && !e.repeat) { document.getElementById('btn-debug').click(); e.preventDefault(); return; }
    const bit = KEYMAP[e.code];
    if (bit) { buttons |= bit; e.preventDefault(); }
  });
  document.addEventListener('keyup', (e) => {
    const bit = KEYMAP[e.code];
    if (bit) { buttons &= ~bit; e.preventDefault(); }
  });

  // virtual pad: multi-touch with slide support
  const pad = document.getElementById('pad');
  const padButtons = [...pad.querySelectorAll('.pbtn')];
  const touchBits = new Map(); // touch identifier -> bit

  function hitButton(x, y) {
    for (const el of padButtons) {
      const r = el.getBoundingClientRect();
      // generous hit margin for small screens
      if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8)
        return el;
    }
    return null;
  }
  function refreshPadState() {
    let bits = 0;
    for (const b of touchBits.values()) bits |= b;
    for (const el of padButtons) {
      const bit = +el.dataset.bit;
      el.classList.toggle('active', !!(bits & bit));
    }
    buttons = (buttons & 0) | bits; // touch pad owns state on touch devices
  }
  function onTouch(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (e.type === 'touchend' || e.type === 'touchcancel') {
        touchBits.delete(t.identifier);
      } else {
        const el = hitButton(t.clientX, t.clientY);
        if (el) touchBits.set(t.identifier, +el.dataset.bit);
        else touchBits.delete(t.identifier);
      }
    }
    refreshPadState();
  }
  ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((ev) =>
    pad.addEventListener(ev, onTouch, { passive: false }));

  // ------------------------------------------------------------------ SRAM save
  let romKey = null;
  let sramDirty = 0;

  function saveSram() {
    if (!romKey || !api.hasBattery()) return;
    const ptr = api.sram();
    const size = api.sramSize();
    const data = Module.HEAPU8.subarray(ptr, ptr + size);
    let bin = '';
    for (let i = 0; i < size; i++) bin += String.fromCharCode(data[i]);
    try { localStorage.setItem('sram:' + romKey, btoa(bin)); } catch (_) {}
  }
  function loadSram() {
    if (!romKey || !api.hasBattery()) return;
    const b64 = localStorage.getItem('sram:' + romKey);
    if (!b64) return;
    const bin = atob(b64);
    const ptr = api.sram();
    const size = Math.min(bin.length, api.sramSize());
    for (let i = 0; i < size; i++) Module.HEAPU8[ptr + i] = bin.charCodeAt(i);
  }
  window.addEventListener('pagehide', saveSram);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSram();
  });

  // ------------------------------------------------------------------ ROM load
  let running = false;

  document.getElementById('rom-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    saveSram();
    let buf;
    try {
      buf = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      console.error('[nes] rom read failed:', err);
      statusEl.textContent = 'ROMの読み込みに失敗しました';
      return;
    }
    const ptr = api.romBuffer();
    if (buf.length > 4 * 1024 * 1024) {
      statusEl.textContent = 'ROMが大きすぎます';
      return;
    }
    Module.HEAPU8.set(buf, ptr);
    if (!api.loadRom(buf.length)) {
      let info = '';
      if (buf.length >= 16 && buf[0] === 0x4E && buf[1] === 0x45 && buf[2] === 0x53 && buf[3] === 0x1A) {
        const dirty = buf[12] || buf[13] || buf[14] || buf[15];
        const mapper = (buf[6] >> 4) | (dirty ? 0 : (buf[7] & 0xF0));
        info = ` (mapper ${mapper}, PRG ${buf[4] * 16}KB, CHR ${buf[5] * 8}KB)`;
      } else {
        info = ' (iNESヘッダなし)';
      }
      statusEl.textContent = '未対応のROM形式/マッパーです' + info;
      return;
    }
    romKey = file.name + ':' + buf.length;
    { // keep PRG/CHR copies for dump diagnostics
      const trainer = buf[6] & 0x04;
      const off = 16 + (trainer ? 512 : 0);
      const prgLen = buf[4] * 16384, chrLen = buf[5] * 8192;
      lastRom = {
        prg: buf.slice(off, off + prgLen),
        chr: buf.slice(off + prgLen, off + prgLen + chrLen),
      };
    }
    loadSram();
    api.reset();
    resumeAudio(); // don't await: resume() only settles after a user gesture
    statusEl.textContent = file.name;
    document.getElementById('cart-label').textContent = file.name.replace(/\.nes$/i, '');
    running = true;
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (running) api.reset();
  });
  const muteBtn = document.getElementById('btn-mute');
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
  });

  // ------------------------------------------------------------------ dump check (XEVIOUS判定)
  // reference CRCs from a known-good Xevious (Japan) cartridge
  const XEV_REF = { name: 'XEVIOUS (J)', prgCrc: 0xEEB16683, prgKB: 32, chrCrc: 0x668B4EE6, chrKB: 8 };
  let lastRom = null;   // {prg, chr} Uint8Array copies of the loaded ROM

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const hex8 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

  // Detect a dead (stuck) address line: the dump then contains mirrored halves.
  function findStuckAddrLines(data, addrBits) {
    const stuck = [];
    for (let b = 0; b < addrBits; b++) {
      const m = 1 << b;
      let dup = true;
      for (let a = 0; a < data.length; a++) if (data[a] !== data[a ^ m]) { dup = false; break; }
      if (dup) stuck.push(b);
    }
    return stuck;
  }
  // If a single swapped address/data line reproduces the reference CRC,
  // the dumper's bus is miswired — report which lines.
  function findBusMiswire(data, refCrc, addrBits) {
    const buf = new Uint8Array(data.length);
    for (let i = 0; i < addrBits; i++) {
      for (let j = i + 1; j < addrBits; j++) {
        const mi = 1 << i, mj = 1 << j;
        for (let a = 0; a < data.length; a++) {
          let b2 = a & ~(mi | mj);
          if (a & mi) b2 |= mj;
          if (a & mj) b2 |= mi;
          buf[b2] = data[a];
        }
        if (crc32(buf) === refCrc) return { kind: 'addr', i, j };
      }
    }
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const mi = 1 << i, mj = 1 << j;
        for (let a = 0; a < data.length; a++) {
          const v = data[a];
          let w = v & ~(mi | mj);
          if (v & mi) w |= mj;
          if (v & mj) w |= mi;
          buf[a] = w;
        }
        if (crc32(buf) === refCrc) return { kind: 'data', i, j };
      }
    }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const progressBox = document.getElementById('check-progress');
  const progressLabel = document.getElementById('check-progress-label');
  const progressFill = document.getElementById('check-bar-fill');
  function setProgress(label, ratio) {
    progressLabel.textContent = `${label} ${Math.round(ratio * 100)}%`;
    progressFill.style.width = (ratio * 100) + '%';
  }

  // CRC32 computed over ~durationMs of wall-clock time, with retro progress
  // display. Paced by elapsed time (not per-step sleeps) so background-tab
  // timer throttling doesn't stretch the total duration.
  async function crc32Slow(u8, label, durationMs) {
    const t0 = performance.now();
    let c = 0xFFFFFFFF;
    let processed = 0;
    while (processed < u8.length) {
      const ratio = Math.min(1, (performance.now() - t0) / durationMs);
      const target = Math.floor(u8.length * ratio);
      for (; processed < target; processed++)
        c = CRC_TABLE[(c ^ u8[processed]) & 0xFF] ^ (c >>> 8);
      setProgress(label, processed / u8.length);
      if (processed >= u8.length) break;
      await sleep(40);
    }
    setProgress(label, 1);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function findBusMiswireSlow(data, refCrc, addrBits, label) {
    const combos = [];
    for (let i = 0; i < addrBits; i++)
      for (let j = i + 1; j < addrBits; j++) combos.push({ kind: 'addr', i, j });
    for (let i = 0; i < 8; i++)
      for (let j = i + 1; j < 8; j++) combos.push({ kind: 'data', i, j });
    const buf = new Uint8Array(data.length);
    const DIAG_MS = 1500;
    const t0 = performance.now();
    let k = 0;
    while (k < combos.length) {
      const ratio = Math.min(1, (performance.now() - t0) / DIAG_MS);
      const target = Math.max(k + 1, Math.floor(combos.length * ratio));
      for (; k < target; k++) {
        const { kind, i, j } = combos[k];
        const mi = 1 << i, mj = 1 << j;
        if (kind === 'addr') {
          for (let a = 0; a < data.length; a++) {
            let b2 = a & ~(mi | mj);
            if (a & mi) b2 |= mj;
            if (a & mj) b2 |= mi;
            buf[b2] = data[a];
          }
        } else {
          for (let a = 0; a < data.length; a++) {
            const v = data[a];
            let w = v & ~(mi | mj);
            if (v & mi) w |= mj;
            if (v & mj) w |= mi;
            buf[a] = w;
          }
        }
        if (crc32(buf) === refCrc) return combos[k];
      }
      setProgress(label, k / combos.length);
      if (k < combos.length) await sleep(40);
    }
    return null;
  }

  async function checkRegionSlow(label, data, refCrc, refKB, addrBits, crcMs) {
    if (!data || data.length === 0) return `${label} ...なし\n`;
    if (data.length !== refKB * 1024) {
      return `${label} CRC...<span class="ng">NG</span> (サイズ ${data.length / 1024}KB, 期待 ${refKB}KB)\n`;
    }
    const crc = await crc32Slow(data, `${label} CRC 計算中...`, crcMs);
    if (crc === refCrc) return `${label} CRC...<span class="ok">OK</span> (${hex8(crc)})\n`;
    let out = `${label} CRC...<span class="ng">NG</span> (${hex8(crc)}, 期待 ${hex8(refCrc)})\n`;
    const stuck = findStuckAddrLines(data, addrBits);
    if (stuck.length) {
      out += `  → アドレス線 ${stuck.map((b) => 'A' + b).join(', ')} が固定/断線したダンプの疑い(内容が鏡像重複)\n`;
    }
    const mis = await findBusMiswireSlow(data, refCrc, addrBits, `${label} バス結線診断中...`);
    if (mis) {
      const n = mis.kind === 'addr' ? 'アドレス' : 'データ';
      out += `  → ${n}線 ${mis.kind === 'addr' ? 'A' : 'D'}${mis.i} ↔ ${mis.kind === 'addr' ? 'A' : 'D'}${mis.j} を入れ替えると一致: `
           + `ダンパーの${label}${n}バス結線ミス\n`;
    } else if (!stuck.length) {
      out += `  → 単純な1本入れ替え/断線では説明できない差異(別リビジョン or 複合的な結線ミス)\n`;
    }
    return out;
  }

  const checkPanel = document.getElementById('check-panel');
  const checkText = document.getElementById('check-text');
  let checking = false;
  document.getElementById('check-close').addEventListener('click', () => {
    if (!checking) checkPanel.classList.remove('show');
  });
  document.getElementById('btn-xev').addEventListener('click', async () => {
    if (checking) return;
    checkPanel.classList.add('show');
    if (!lastRom) {
      checkText.innerHTML = 'ROMが読み込まれていません。.NESファイルを開いてから実行してください。';
      return;
    }
    checking = true;
    checkText.innerHTML = `${XEV_REF.name} ダンプ診断\n\n`;
    progressBox.classList.add('show');
    setProgress('準備中...', 0);
    checkText.innerHTML += await checkRegionSlow('PRGROM', lastRom.prg, XEV_REF.prgCrc, XEV_REF.prgKB, 15, 2000);
    checkText.innerHTML += await checkRegionSlow('CGROM ', lastRom.chr, XEV_REF.chrCrc, XEV_REF.chrKB, 13, 2000);
    checkText.innerHTML += '\n基準: 正規ダンプ PRG=EEB16683 / CHR=668B4EE6';
    progressBox.classList.remove('show');
    checking = false;
  });

  // ------------------------------------------------------------------ cartridge connector (60pin)
  const PIN_NAMES = [null,
    'GND', 'CPU A11', 'CPU A10', 'CPU A9', 'CPU A8', 'CPU A7', 'CPU A6', 'CPU A5',
    'CPU A4', 'CPU A3', 'CPU A2', 'CPU A1', 'CPU A0', 'CPU R/W', '/IRQ', 'GND',
    'PPU /RD', 'CIRAM A10', 'PPU A6', 'PPU A5', 'PPU A4', 'PPU A3', 'PPU A2',
    'PPU A1', 'PPU A0', 'PPU D0', 'PPU D1', 'PPU D2', 'PPU D3', '+5V',
    '+5V', 'M2', 'CPU A12', 'CPU A13', 'CPU A14', 'CPU D7', 'CPU D6', 'CPU D5',
    'CPU D4', 'CPU D3', 'CPU D2', 'CPU D1', 'CPU D0', '/ROMSEL', 'SOUND IN',
    'SOUND OUT', 'PPU /WR', 'CIRAM /CE', 'PPU /A13', 'PPU A7', 'PPU A8', 'PPU A9',
    'PPU A10', 'PPU A11', 'PPU A12', 'PPU A13', 'PPU D7', 'PPU D6', 'PPU D5', 'PPU D4',
  ];
  const busFront = document.getElementById('bus-front');
  const busBack = document.getElementById('bus-back');
  const pinEls = [null];
  const manualOff = new Set();   // pins the user broke by clicking
  let tilt = 0;                  // cartridge tilt in degrees (-6 .. +6)
  const TILT_MAX = 6;

  for (let pin = 1; pin <= 60; pin++) {
    const el = document.createElement('div');
    el.className = 'pin';
    el.dataset.pin = pin;
    el.title = `pin ${pin}: ${PIN_NAMES[pin]}`;
    el.innerHTML = `<b>${pin}</b>` + PIN_NAMES[pin].replace(/^(CPU |PPU )/, '$1<br>');
    el.addEventListener('click', () => {
      if (manualOff.has(pin)) manualOff.delete(pin);
      else manualOff.add(pin);
      applyContacts();
      updateBusUI(true);
    });
    pinEls[pin] = el;
    (pin <= 30 ? busFront : busBack).appendChild(el);
  }
  document.getElementById('btn-bus').addEventListener('click', () => {
    document.body.classList.toggle('bus-on');
    updateBusUI(true);
  });

  // --- half-insertion model: tilting lifts one side of the edge connector ---
  // column 0..29 across the connector; both rows share the column
  const pinColumn = (pin) => (pin <= 30 ? pin - 1 : pin - 31);
  function contactQuality(col) {   // 1 = solid, 0 = no contact
    if (tilt === 0) return 1;
    const x = (col / 29) * 2 - 1;              // -1 (left) .. +1 (right)
    const lift = (tilt / TILT_MAX) * x;        // lifted side positive
    if (lift <= 0.15) return 1;
    if (lift >= 0.6) return 0;
    return 1 - (lift - 0.15) / 0.45;
  }
  // roll the dice for flaky pins — called every frame while tilted
  function applyContacts() {
    for (let pin = 1; pin <= 60; pin++) {
      let on = 0;
      if (!manualOff.has(pin)) {
        const q = contactQuality(pinColumn(pin));
        on = (q >= 1 || Math.random() < q) ? 1 : 0;
      }
      api.setPin(pin, on);
    }
  }

  let lastBusUi = 0;
  function updateBusUI(force) {
    const now = performance.now();
    if (!force && now - lastBusUi < 150) return;
    lastBusUi = now;
    if (!document.body.classList.contains('bus-on')) return;
    for (let pin = 1; pin <= 60; pin++) {
      const q = manualOff.has(pin) ? 0 : contactQuality(pinColumn(pin));
      const el = pinEls[pin];
      el.classList.toggle('off', q === 0);
      el.classList.toggle('unstable', q > 0 && q < 1);
    }
  }

  // --- cartridge front view / rotation controls ---
  const cartBody = document.getElementById('cart-body');
  const cartAngle = document.getElementById('cart-angle');
  const cartSlider = document.getElementById('cart-tilt');
  function setTilt(t) {
    tilt = Math.max(-TILT_MAX, Math.min(TILT_MAX, Math.round(t * 10) / 10));
    cartBody.style.transform = `rotate(${tilt}deg)`;
    cartAngle.textContent = (tilt > 0 ? '+' : '') + tilt.toFixed(1) + '\u00b0';
    cartSlider.value = tilt;
    applyContacts();
    updateBusUI(true);
  }
  cartSlider.addEventListener('input', () => setTilt(parseFloat(cartSlider.value)));
  document.getElementById('cart-ccw').addEventListener('click', () => setTilt(tilt - 0.1));
  document.getElementById('cart-cw').addEventListener('click', () => setTilt(tilt + 0.1));
  document.getElementById('cart-straight').addEventListener('click', () => {
    manualOff.clear();
    setTilt(0);
    api.resetPins();
    api.reset();   // 挿し直したらリセットボタンを押すのがお作法
    updateBusUI(true);
  });

  // ------------------------------------------------------------------ gamepad
  // Standard mapping, Famicom-layout accurate: right button (1) = A, bottom (0) = B
  let gamepadConnected = false;
  window.addEventListener('gamepadconnected', (e) => {
    gamepadConnected = true;
    statusEl.textContent = '🎮 ' + e.gamepad.id.slice(0, 40);
  });
  window.addEventListener('gamepaddisconnected', () => { gamepadConnected = false; });

  function pollGamepad() {
    if (!gamepadConnected) return 0;
    let bits = 0;
    for (const gp of navigator.getGamepads()) {
      if (!gp || !gp.connected) continue;
      const b = gp.buttons;
      const pressed = (i) => b[i] && b[i].pressed;
      if (pressed(1) || pressed(3)) bits |= 1;    // A (right / top)
      if (pressed(0) || pressed(2)) bits |= 2;    // B (bottom / left)
      if (pressed(8)) bits |= 4;                  // Select
      if (pressed(9)) bits |= 8;                  // Start
      if (pressed(12)) bits |= 16;                // Up
      if (pressed(13)) bits |= 32;                // Down
      if (pressed(14)) bits |= 64;                // Left
      if (pressed(15)) bits |= 128;               // Right
      // left stick fallback
      if (gp.axes.length >= 2) {
        if (gp.axes[1] < -0.5) bits |= 16;
        if (gp.axes[1] > 0.5) bits |= 32;
        if (gp.axes[0] < -0.5) bits |= 64;
        if (gp.axes[0] > 0.5) bits |= 128;
      }
    }
    return bits;
  }

  // ------------------------------------------------------------------ debug panel
  const APU_REG_NAMES = [
    'SQ1_VOL', 'SQ1_SWEEP', 'SQ1_LO', 'SQ1_HI',
    'SQ2_VOL', 'SQ2_SWEEP', 'SQ2_LO', 'SQ2_HI',
    'TRI_LINEAR', '(unused)', 'TRI_LO', 'TRI_HI',
    'NOISE_VOL', '(unused)', 'NOISE_LO', 'NOISE_HI',
    'DMC_FREQ', 'DMC_RAW', 'DMC_START', 'DMC_LEN',
    'OAMDMA', 'SND_CHN', 'JOY1', 'JOY2/FRAME',
  ];
  const dbgApu = document.getElementById('dbg-apu');
  const dbgWram = document.getElementById('dbg-wram');
  const chrCanvas = document.getElementById('chr-canvas');
  const chrCtx = chrCanvas.getContext('2d');
  const chrImage = chrCtx.createImageData(128, 256);
  let chrPal = 0;
  chrCanvas.addEventListener('click', () => {
    chrPal = (chrPal + 1) & 7;
    document.getElementById('chr-title').textContent =
      `CGROM (CHR) — ${chrPal < 4 ? 'BG' : 'SP'} pal ${chrPal & 3} [click]`;
    lastDebugUpdate = 0;
  });

  // waveform scopes
  const waveCanvases = [...document.querySelectorAll('canvas.wave')];
  const waveCtxs = waveCanvases.map((c) => c.getContext('2d'));
  const WAVE_SCALE = [15, 15, 15, 15, 127];  // raw level range per channel
  let waveData = null;  // captured per frame while debug is on

  function captureWave(count) {
    const chans = [];
    for (let i = 0; i < 5; i++) {
      const p = api.chanBuffer(i);
      chans.push(Module.HEAPU8.slice(p, p + count));
    }
    const mp = api.audioBuffer() >> 2;
    waveData = { count, chans, mix: Module.HEAPF32.slice(mp, mp + count) };
  }

  function drawWaves() {
    if (!waveData) return;
    const { count, chans, mix } = waveData;
    for (let ch = 0; ch < 6; ch++) {
      const ctx2 = waveCtxs[ch];
      const w = waveCanvases[ch].width, h = waveCanvases[ch].height;
      ctx2.fillStyle = '#000';
      ctx2.fillRect(0, 0, w, h);
      ctx2.strokeStyle = ch === 5 ? '#ffcf5a' : '#6fdc6f';
      ctx2.lineWidth = 1;
      ctx2.beginPath();
      for (let x = 0; x < w; x++) {
        const i = Math.min(count - 1, (x * count / w) | 0);
        const v = ch < 5 ? chans[ch][i] / WAVE_SCALE[ch] : Math.min(1, mix[i] * 2);
        const y = h - 2 - v * (h - 4);
        if (x === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
      }
      ctx2.stroke();
    }
  }
  let debugOn = false;
  let lastDebugUpdate = 0;
  const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');

  document.getElementById('btn-debug').addEventListener('click', () => {
    debugOn = !debugOn;
    document.body.classList.toggle('debug-on', debugOn);
  });

  function updateDebug(now) {
    if (!debugOn || now - lastDebugUpdate < 100) return;
    lastDebugUpdate = now;
    const regs = Module.HEAPU8.subarray(api.apuRegs(), api.apuRegs() + 0x18);
    let apuText = '';
    for (let i = 0; i < 0x18; i++) {
      apuText += '$' + (0x4000 + i).toString(16).toUpperCase() + '  ' + hex2(regs[i])
               + '  ' + APU_REG_NAMES[i] + '\n';
    }
    dbgApu.textContent = apuText;

    const ram = Module.HEAPU8.subarray(api.ram(), api.ram() + 0x800);
    let wramText = '';
    for (let row = 0; row < 0x800; row += 16) {
      let line = '$' + row.toString(16).toUpperCase().padStart(4, '0') + ' ';
      for (let i = 0; i < 16; i++) line += ' ' + hex2(ram[row + i]);
      wramText += line + '\n';
    }
    dbgWram.textContent = wramText;

    const chrPtr = api.renderChr(chrPal);
    if (chrPtr) {
      chrImage.data.set(Module.HEAPU8.subarray(chrPtr, chrPtr + 128 * 256 * 4));
      chrCtx.putImageData(chrImage, 0, 0);
    }

    drawWaves();
  }
  window.__nes.updateDebug = (now) => updateDebug(now);
  window.__nes.captureWave = (c) => captureWave(c);

  // ------------------------------------------------------------------ main loop
  const FRAME_MS = 1000 / 60.0988; // NTSC
  let lastTime = performance.now();
  let acc = 0;

  function tick(now) {
    requestAnimationFrame(tick);
    if (!running) return;

    acc += now - lastTime;
    lastTime = now;
    if (acc > 100) acc = 100; // avoid spiral after tab switch

    let ranFrame = false;
    while (acc >= FRAME_MS) {
      if (tilt !== 0) applyContacts();   // flaky contacts re-roll every frame
      api.setButtons(0, buttons | pollGamepad());
      api.frame();
      window.__nes.frames++;
      acc -= FRAME_MS;
      ranFrame = true;

      // ship audio produced by this frame
      const count = api.audioCount();
      if (count > 0) {
        if (pushSamples && !muted) {
          const ptr = api.audioBuffer() >> 2;
          pushSamples(Module.HEAPF32.slice(ptr, ptr + count));
        }
        if (debugOn) captureWave(count);
        api.audioClear();
      }

      // periodic SRAM save (~every 5s)
      if (++sramDirty >= 300) { sramDirty = 0; saveSram(); }
    }

    if (ranFrame) {
      const ptr = api.framebuffer();
      imageData.data.set(Module.HEAPU8.subarray(ptr, ptr + 256 * 240 * 4));
      ctx.putImageData(imageData, 0, 0);
      updateDebug(now);
      if (tilt !== 0) updateBusUI(false);
    }
  }
  requestAnimationFrame((now) => { lastTime = now; tick(now); });
})();
