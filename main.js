'use strict';

(async () => {
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(256, 240);
  const statusEl = document.getElementById('status');

  const Module = await createNesModule();
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
      statusEl.textContent = '未対応のROM形式/マッパーです';
      return;
    }
    romKey = file.name + ':' + buf.length;
    loadSram();
    api.reset();
    resumeAudio(); // don't await: resume() only settles after a user gesture
    statusEl.textContent = file.name;
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
    }
  }
  requestAnimationFrame((now) => { lastTime = now; tick(now); });
})();
