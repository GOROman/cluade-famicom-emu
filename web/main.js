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
