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
    powerOn: Module._nes_power_on,
    swapRom: Module._nes_swap_rom,
    frame: Module._nes_frame,
    runCycles: Module._nes_run_cycles,
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
    setChannel: Module._nes_set_channel,
    apuRegs: Module._nes_apu_regs,
    cpuRegs: Module._nes_cpu_regs,
    peek: Module._nes_peek,
    setProbe: Module._nes_set_probe,
    probeBuffer: Module._nes_probe_buffer,
    probePos: Module._nes_probe_pos,
    probeLevel: Module._nes_probe_level,
    sram: Module._nes_sram,
    sramSize: Module._nes_sram_size,
    hasBattery: Module._nes_has_battery,
  };
  window.__nes = { api, Module, frames: 0, getButtons: () => buttons };

  // ------------------------------------------------------------------ i18n
  // 'auto' follows the browser locale; an explicit choice is persisted
  function detectLang() {
    const n = navigator.language || '';
    return n.startsWith('ja') ? 'ja' : n.startsWith('zh') ? 'zh' : 'en';
  }
  let langPref = localStorage.getItem('lang') || 'auto';
  if (langPref !== 'auto' && !window.I18N[langPref]) langPref = 'auto';
  let lang = langPref === 'auto' ? detectLang() : langPref;
  function t(key, vars) {
    let s = (window.I18N[lang] && window.I18N[lang][key]) || window.I18N.ja[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }
  function applyLanguage() {
    document.documentElement.lang = lang;
    const set = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = t(key); };
    set('lbl-open', 'openRom');
    set('btn-power', 'power');
    set('btn-reset', 'reset');
    set('btn-swap', 'swap');
    set('btn-bus', 'bus');
    set('btn-debug', 'debug');
    set('btn-xev', 'xevCheck');
    set('btn-tas', 'tas');
    set('bus-hint', 'busHint');
    set('cart-title-h3', 'cartTitle');
    set('cart-ccw', 'ccw');
    set('cart-cw', 'cw');
    set('cart-straight', 'reinsert');
    set('cart-blow', 'blow');
    set('cart-note', 'cartNote');
    set('swap-title', 'swapTitle');
    set('lbl-swap-whole', 'swapWhole');
    set('lbl-swap-prg', 'swapPrg');
    set('lbl-swap-chr', 'swapChr');
    set('swap-note', 'swapNote');
    set('swap-url-btn', 'urlLoad');
    set('swap-close', 'close');
    set('check-close', 'close');
    set('h-cpu', 'cpuRegs');
    set('h-waves', 'apuWaves');
    set('h-apuregs', 'apuRegs');
    set('h-wram', 'wramTitle');
    if (typeof romLoaded !== 'undefined' && !romLoaded) statusEl.textContent = t('statusDefault');
    if (typeof refreshPinTitles === 'function') refreshPinTitles();
    if (typeof updateChrTitle === 'function') updateChrTitle();
    if (typeof updateMuteTips === 'function') updateMuteTips();
    const sel = document.getElementById('lang-select');
    if (sel) sel.value = langPref;
  }
  document.getElementById('lang-select').addEventListener('change', (e) => {
    langPref = e.target.value;
    localStorage.setItem('lang', langPref);
    lang = langPref === 'auto' ? detectLang() : langPref;
    applyLanguage();
  });

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
    if (e.code === 'KeyR' && !e.repeat) { setResetHold(true); e.preventDefault(); return; }
    if (e.code === 'KeyD' && !e.repeat) { document.getElementById('btn-debug').click(); e.preventDefault(); return; }
    const bit = KEYMAP[e.code];
    if (bit) { buttons |= bit; e.preventDefault(); }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyR') { setResetHold(false); e.preventDefault(); return; }
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

  // ------------------------------------------------------------------ ROM load / power
  let running = false;
  let romLoaded = false;
  let powered = false;
  const btnPower = document.getElementById('btn-power');

  function setPower(on) {
    powered = on;
    btnPower.classList.toggle('power-on', on);
    btnPower.classList.toggle('power-off', !on);
    running = on && romLoaded;
    if (!on) {
      saveSram();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 256, 240);
    }
  }
  btnPower.addEventListener('click', () => {
    if (!romLoaded) {
      statusEl.textContent = t('needRom');
      return;
    }
    if (powered) {
      setPower(false);
    } else {
      api.powerOn();   // 電源投入 = RAMクリア+リセット
      setPower(true);
    }
  });

  function keepRomCopies(buf) {
    // PRG/CHR copies for dump diagnostics
    const trainer = buf[6] & 0x04;
    const off = 16 + (trainer ? 512 : 0);
    const prgLen = buf[4] * 16384, chrLen = buf[5] * 8192;
    lastRom = {
      prg: buf.slice(off, off + prgLen),
      chr: buf.slice(off + prgLen, off + prgLen + chrLen),
    };
  }

  document.getElementById('rom-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    saveSram();
    let buf;
    try {
      buf = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      console.error('[nes] rom read failed:', err);
      statusEl.textContent = t('readFail');
      return;
    }
    const ptr = api.romBuffer();
    if (buf.length > 4 * 1024 * 1024) {
      statusEl.textContent = t('tooBig');
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
        info = t('noHeader');
      }
      statusEl.textContent = t('unsupported') + info;
      return;
    }
    romKey = file.name + ':' + buf.length;
    keepRomCopies(buf);
    setCartSources(file.name, buf);
    updateRamLabels(file.name);
    loadSram();
    resumeAudio(); // don't await: resume() only settles after a user gesture
    statusEl.textContent = file.name;
    romLoaded = true;
    setPower(true);   // 電源ON(パワーオンリセット込み)
  });

  // リセットはレベル信号: 押している間はリセット状態(停止)、離した瞬間に再起動
  let resetHeld = false;
  const btnReset = document.getElementById('btn-reset');
  function setResetHold(held) {
    if (held === resetHeld) return;
    resetHeld = held;
    btnReset.classList.toggle('held', held);
    if (!held && running) api.reset();   // オフトリガーでリセットベクタから起動
  }
  btnReset.addEventListener('pointerdown', (e) => {
    setResetHold(true);
    btnReset.setPointerCapture(e.pointerId);
  });
  btnReset.addEventListener('pointerup', () => setResetHold(false));
  btnReset.addEventListener('pointercancel', () => setResetHold(false));

  // ---- カセット入替ダイアログ: まるごと or PRG/CHR を別カセットから合体 ----
  const swapPanel = document.getElementById('swap-panel');
  const swapCurrent = document.getElementById('swap-current');
  let cartPrg = null;   // {name, header(16B), data}
  let cartChr = null;   // {name, data}

  function parseNes(buf) {
    if (buf.length < 16 || buf[0] !== 0x4E || buf[1] !== 0x45 || buf[2] !== 0x53 || buf[3] !== 0x1A) return null;
    const off = 16 + ((buf[6] & 0x04) ? 512 : 0);
    const prgLen = buf[4] * 16384, chrLen = buf[5] * 8192;
    if (off + prgLen + chrLen > buf.length) return null;
    return {
      header: buf.slice(0, 16),
      prg: buf.slice(off, off + prgLen),
      chr: buf.slice(off + prgLen, off + prgLen + chrLen),
    };
  }
  function updateSwapInfo() {
    swapCurrent.textContent = `PRG: ${cartPrg ? cartPrg.name : '-'} / CHR: ${cartChr ? cartChr.name : '-'}`;
    const strip = (n) => n.replace(/\.nes$/i, '');
    document.getElementById('cart-label').textContent =
      cartPrg && cartChr && cartPrg.name !== cartChr.name
        ? strip(cartPrg.name) + ' + ' + strip(cartChr.name)
        : (cartPrg ? strip(cartPrg.name) : 'CASSETTE');
  }
  function setCartSources(name, buf) {
    const p = parseNes(buf);
    if (!p) return;
    cartPrg = { name, header: p.header, data: p.prg };
    cartChr = { name, data: p.chr };
    updateSwapInfo();
  }
  // combined iNES image: mapper/mirroring follow the PRG cart's header
  function buildCombined() {
    const h = new Uint8Array(16);
    h.set(cartPrg.header);
    h[4] = cartPrg.data.length / 16384;
    h[5] = cartChr.data.length / 8192;
    h[6] &= ~0x04;   // trainer stripped
    const img = new Uint8Array(16 + cartPrg.data.length + cartChr.data.length);
    img.set(h);
    img.set(cartPrg.data, 16);
    img.set(cartChr.data, 16 + cartPrg.data.length);
    return img;
  }
  // リセットは掛けない(電源入れっぱなし差し替え=バグ技用)
  function applySwap() {
    const img = buildCombined();
    if (img.length > 4 * 1024 * 1024) { statusEl.textContent = t('tooBig'); return false; }
    Module.HEAPU8.set(img, api.romBuffer());
    if (!api.swapRom(img.length)) {
      statusEl.textContent = t('unsupportedSwap');
      return false;
    }
    romKey = `${cartPrg.name}+${cartChr.name}:${img.length}`;
    keepRomCopies(img);
    updateRamLabels(cartPrg.name);
    loadSram();
    romLoaded = true;
    updateSwapInfo();
    statusEl.textContent = t(powered ? 'swapDoneReset' : 'swapDonePower');
    return true;
  }
  async function readSwapFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return null;
    let buf;
    try { buf = new Uint8Array(await file.arrayBuffer()); }
    catch (_) { statusEl.textContent = t('readFail'); return null; }
    const p = parseNes(buf);
    if (!p) { statusEl.textContent = t('unsupportedFmt'); return null; }
    return { name: file.name, header: p.header, prg: p.prg, chr: p.chr };
  }
  document.getElementById('btn-swap').addEventListener('click', () => {
    updateSwapInfo();
    swapPanel.classList.add('show');
  });
  document.getElementById('swap-close').addEventListener('click', () => swapPanel.classList.remove('show'));
  document.getElementById('swap-input').addEventListener('change', async (e) => {
    const f = await readSwapFile(e);
    if (!f) return;
    saveSram();   // 旧カセットのSRAMを保存してから抜く
    cartPrg = { name: f.name, header: f.header, data: f.prg };
    cartChr = { name: f.name, data: f.chr };
    applySwap();
  });
  document.getElementById('swap-prg-input').addEventListener('change', async (e) => {
    const f = await readSwapFile(e);
    if (!f) return;
    saveSram();
    cartPrg = { name: f.name, header: f.header, data: f.prg };
    if (!cartChr) cartChr = { name: f.name, data: f.chr };
    applySwap();
  });
  document.getElementById('swap-chr-input').addEventListener('change', async (e) => {
    const f = await readSwapFile(e);
    if (!f) return;
    saveSram();
    cartChr = { name: f.name, data: f.chr };
    if (!cartPrg) cartPrg = { name: f.name, header: f.header, data: f.prg };
    applySwap();
  });

  // ---- load ROM from a URL (CORS permitting) ----
  async function loadRomFromUrl(url) {
    statusEl.textContent = t('urlFetching');
    let buf;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      buf = new Uint8Array(await res.arrayBuffer());
    } catch (_) {
      statusEl.textContent = t('urlFail');
      return;
    }
    const p = parseNes(buf);
    if (!p) { statusEl.textContent = t('unsupportedFmt'); return; }
    const name = decodeURIComponent((url.split('/').pop() || 'rom.nes').split('?')[0]) || 'rom.nes';
    saveSram();
    cartPrg = { name, header: p.header, data: p.prg };
    cartChr = { name, data: p.chr };
    if (applySwap()) {
      // URL load boots like ROMを開く: power-cycle and run
      api.powerOn();
      updateRamLabels(name);
      setPower(true);
      resumeAudio();
      statusEl.textContent = name;
      swapPanel.classList.remove('show');
    }
  }
  const swapUrlInput = document.getElementById('swap-url');
  document.getElementById('swap-url-btn').addEventListener('click', () => {
    const u = swapUrlInput.value.trim();
    if (u) loadRomFromUrl(u);
  });
  swapUrlInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') document.getElementById('swap-url-btn').click();
  });
  swapUrlInput.addEventListener('keyup', (e) => e.stopPropagation());
  // ?rom=<url> query parameter auto-load
  {
    const q = new URLSearchParams(location.search).get('rom');
    if (q) loadRomFromUrl(q);
  }
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
    if (!data || data.length === 0) return t('xevNone', { label }) + '\n';
    if (data.length !== refKB * 1024) {
      return t('xevSizeNg', { label, size: data.length / 1024, ref: refKB }) + '\n';
    }
    const crc = await crc32Slow(data, t('xevCrcLabel', { label }), crcMs);
    if (crc === refCrc) return t('xevOk', { label, crc: hex8(crc) }) + '\n';
    let out = t('xevNg', { label, crc: hex8(crc), ref: hex8(refCrc) }) + '\n';
    const stuck = findStuckAddrLines(data, addrBits);
    if (stuck.length) {
      out += t('xevStuck', { lines: stuck.map((b) => 'A' + b).join(', ') }) + '\n';
    }
    const mis = await findBusMiswireSlow(data, refCrc, addrBits, t('xevBusLabel', { label }));
    if (mis) {
      const p = mis.kind === 'addr' ? 'A' : 'D';
      out += t(mis.kind === 'addr' ? 'xevSwapAddr' : 'xevSwapData',
               { a: p + mis.i, b: p + mis.j, label }) + '\n';
    } else if (!stuck.length) {
      out += t('xevUnknown') + '\n';
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
      checkText.innerHTML = t('xevNoRom');
      return;
    }
    checking = true;
    checkText.innerHTML = t('xevTitle', { name: XEV_REF.name }) + '\n\n';
    progressBox.classList.add('show');
    setProgress(t('prep'), 0);
    checkText.innerHTML += await checkRegionSlow('PRGROM', lastRom.prg, XEV_REF.prgCrc, XEV_REF.prgKB, 15, 2000);
    checkText.innerHTML += await checkRegionSlow('CGROM ', lastRom.chr, XEV_REF.chrCrc, XEV_REF.chrKB, 13, 2000);
    checkText.innerHTML += '\n' + t('xevRef');
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
    '/NMI', 'APU /IRQ', 'MAPPER /IRQ',
  ];
  const busFront = document.getElementById('bus-front');
  const busBack = document.getElementById('bus-back');
  const pinEls = [null];
  const manualOff = new Set();   // pins the user broke by clicking
  let tilt = 0;                  // cartridge tilt in degrees (-6 .. +6)
  let clockHz = 1789773;         // CPU clock in Hz (1 .. 1789773)
  const TILT_MAX = 6;

  // per-signal hover explanations (localized)
  function pinDesc(name) {
    if (name === 'GND') return t('pin_gnd');
    if (name === '+5V') return t('pin_5v');
    if (/^CPU A/.test(name)) return t('pin_cpuA', { n: name.slice(4) });
    if (/^CPU D/.test(name)) return t('pin_cpuD', { n: name.slice(4) });
    if (name === 'CPU R/W') return t('pin_rw');
    if (name === '/IRQ') return t('pin_irq');
    if (name === 'M2') return t('pin_m2');
    if (name === '/ROMSEL') return t('pin_romsel');
    if (name === 'SOUND IN') return t('pin_sndin');
    if (name === 'SOUND OUT') return t('pin_sndout');
    if (name === 'PPU /RD') return t('pin_ppurd');
    if (name === 'PPU /WR') return t('pin_ppuwr');
    if (name === 'CIRAM A10') return t('pin_ciramA10');
    if (name === 'CIRAM /CE') return t('pin_ciramCe');
    if (name === 'PPU /A13') return t('pin_ppuA13n');
    if (/^PPU A/.test(name)) return t('pin_ppuA', { n: name.slice(4) });
    if (/^PPU D/.test(name)) return t('pin_ppuD', { n: name.slice(4) });
    if (name === '/NMI') return t('pin_nmi');
    if (name === 'APU /IRQ') return t('pin_apuirq');
    if (name === 'MAPPER /IRQ') return t('pin_mapirq');
    return '';
  }

  const busBackFunc = document.getElementById('bus-back-func');
  const busFrontFunc = document.getElementById('bus-front-func');
  const funcEls = [null];
  function refreshPinTitles() {
    for (let pin = 1; pin <= 60; pin++) {
      const tip = `pin ${pin}: ${PIN_NAMES[pin]}\n${pinDesc(PIN_NAMES[pin])}`;
      if (pinEls[pin]) pinEls[pin].title = tip;
      if (funcEls[pin]) funcEls[pin].title = tip;
    }
  }
  for (let pin = 1; pin <= 60; pin++) {
    const name = PIN_NAMES[pin];
    const el = document.createElement('div');
    el.className = 'pin';
    el.dataset.pin = pin;
    el.innerHTML = `<b>${pin}</b>`;
    el.addEventListener('click', () => {
      if (manualOff.has(pin)) manualOff.delete(pin);
      else manualOff.add(pin);
      applyContacts();
      updateBusUI(true);
    });
    el.addEventListener('mouseenter', () => probeAttach(pin, el));
    el.addEventListener('mouseleave', () => probeDetach(pin));
    pinEls[pin] = el;
    (pin <= 30 ? busFront : busBack).appendChild(el);
    // function label above (back row) / below (front row)
    const fl = document.createElement('div');
    fl.className = 'func-label';
    fl.textContent = name;
    funcEls[pin] = fl;
    (pin <= 30 ? busFrontFunc : busBackFunc).appendChild(fl);
  }
  refreshPinTitles();
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
    // clockwise (右回り, tilt>0) about the bottom-center pivot lifts the LEFT side
    const lift = (tilt / TILT_MAX) * -x;
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

  // ---- variable clock: 1 Hz .. 1.79 MHz (log slider + Hz input box) ----
  const NES_CLOCK = 1789773;
  const clockSlider = document.getElementById('clock-slider');
  const clockInput = document.getElementById('clock-input');
  const clockLabel = document.getElementById('clock-label');
  function fmtHz(hz) {
    if (hz >= 1e6) return (hz / 1e6).toFixed(2) + ' MHz';
    if (hz >= 1e3) return (hz / 1e3).toFixed(1) + ' kHz';
    return hz + ' Hz';
  }
  function setClock(hz) {
    clockHz = Math.max(1, Math.min(NES_CLOCK, Math.round(hz)));
    clockSlider.value = Math.log10(clockHz);
    clockInput.value = clockHz;
    clockLabel.textContent = 'CLOCK ' + fmtHz(clockHz);
    // APU resample ratio follows the clock: slower clock = lower pitch
    const rate = audioCtx ? audioCtx.sampleRate : 44100;
    api.init(rate * NES_CLOCK / clockHz);
  }
  clockSlider.addEventListener('input', () => setClock(Math.pow(10, parseFloat(clockSlider.value))));
  clockSlider.addEventListener('dblclick', () => setClock(NES_CLOCK));
  clockInput.addEventListener('change', () => {
    const v = parseFloat(clockInput.value);
    if (!isNaN(v)) setClock(v); else clockInput.value = clockHz;
  });
  clockInput.addEventListener('keydown', (e) => e.stopPropagation());
  clockInput.addEventListener('keyup', (e) => e.stopPropagation());

  // drag the cartridge itself to rotate it (pivot = bottom center)
  const cartStage = document.getElementById('cart-stage');
  function pointerTiltAngle(e) {
    const r = cartStage.getBoundingClientRect();
    const px = r.left + r.width / 2;
    const py = r.bottom - 21;   // cart-body bottom (0.75-scaled stage)
    return Math.atan2(e.clientX - px, py - e.clientY) * 180 / Math.PI;
  }
  let dragBaseAngle = 0, dragBaseTilt = 0;
  cartBody.style.cursor = 'grab';
  cartBody.addEventListener('pointerdown', (e) => {
    dragBaseAngle = pointerTiltAngle(e);
    dragBaseTilt = tilt;
    cartBody.setPointerCapture(e.pointerId);
    cartBody.classList.add('dragging');
    e.preventDefault();
  });
  cartBody.addEventListener('pointermove', (e) => {
    if (!cartBody.classList.contains('dragging')) return;
    setTilt(dragBaseTilt + (pointerTiltAngle(e) - dragBaseAngle));
  });
  const endDrag = (e) => {
    if (!cartBody.classList.contains('dragging')) return;
    cartBody.classList.remove('dragging');
    try { cartBody.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  cartBody.addEventListener('pointerup', endDrag);
  cartBody.addEventListener('pointercancel', endDrag);
  document.getElementById('cart-ccw').addEventListener('click', () => setTilt(tilt - 0.1));
  document.getElementById('cart-cw').addEventListener('click', () => setTilt(tilt + 0.1));
  // 息を吹く: ホコリが飛んで直ることもあれば、湿気で余計ダメになることも
  const blowSe = new Audio('foofoo.mp3?v=' + (window.NES_VER || '0'));
  document.getElementById('cart-blow').addEventListener('click', () => {
    blowSe.currentTime = 0;
    blowSe.play().catch(() => {});
    // 変化は基本PPU側(グラフィック系)に出る: 画面化けが定番症状
    const isPpuPin = (pin) => (pin >= 17 && pin <= 29) || (pin >= 47 && pin <= 60);
    for (let pin = 1; pin <= 60; pin++) {
      const breakChance = isPpuPin(pin) ? 0.10 : 0.005;
      if (manualOff.has(pin)) {
        if (Math.random() < 0.65) manualOff.delete(pin);   // ゴミが飛んで復活
      } else {
        if (Math.random() < breakChance) manualOff.add(pin);  // 湿気で接触不良に
      }
    }
    applyContacts();
    updateBusUI(true);
    api.reset();   // フーフーしたらリセットを押すのがお作法
    // 💨 演出
    const stage = document.getElementById('cart-stage');
    const puff = document.createElement('div');
    puff.className = 'blow-puff';
    puff.textContent = '💨';
    puff.style.left = (30 + Math.random() * 40) + '%';
    stage.appendChild(puff);
    setTimeout(() => puff.remove(), 1000);
    const label = document.getElementById('cart-label');
    label.classList.remove('shake');
    void label.offsetWidth;   // restart animation
    label.classList.add('shake');
  });

  document.getElementById('cart-straight').addEventListener('click', () => {
    manualOff.clear();
    setTilt(0);
    api.resetPins();
    api.reset();   // 挿し直したらリセットボタンを押すのがお作法
    updateBusUI(true);
  });

  // ------------------------------------------------------------------ TAS (FM2) playback
  let tasFrames = null;
  let tasIndex = 0;

  function parseFm2(text) {
    const frames = [];
    const map = [128, 64, 32, 16, 8, 4, 2, 1];   // R L D U T(Start) S(Select) B A
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('|')) continue;
      const parts = line.split('|');
      const cmd = parseInt(parts[1], 10) || 0;
      const p0 = parts[2] || '';
      let bits = 0;
      for (let i = 0; i < 8 && i < p0.length; i++) {
        const ch = p0[i];
        if (ch !== '.' && ch !== ' ') bits |= map[i];
      }
      frames.push({ cmd, bits });
    }
    return frames.length ? frames : null;
  }

  function tasStop(msg) {
    tasFrames = null;
    tasIndex = 0;
    document.getElementById('btn-tas').classList.remove('tas-on');
    if (msg) statusEl.textContent = msg;
  }

  function tasStart(frames) {
    // deterministic start: power cycle + FCEUX-style RAM pattern (00x4 FFx4)
    api.powerOn();
    const ramPtr = api.ram();
    for (let i = 0; i < 0x800; i++) Module.HEAPU8[ramPtr + i] = (i & 4) ? 0xFF : 0x00;
    api.reset();   // vectors fetched fresh after the pattern fill
    tasFrames = frames;
    tasIndex = 0;
    setPower(true);
    document.getElementById('btn-tas').classList.add('tas-on');
    statusEl.textContent = t('tasPlaying', { cur: 0, total: frames.length });
  }

  document.getElementById('btn-tas').addEventListener('click', () => {
    if (tasFrames) { tasStop(t('tasStopped')); return; }
    if (!romLoaded) { statusEl.textContent = t('needRom'); return; }
    document.getElementById('tas-input').click();
  });
  document.getElementById('tas-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (_) { statusEl.textContent = t('readFail'); return; }
    const frames = parseFm2(text);
    if (!frames) { statusEl.textContent = t('tasBad'); return; }
    tasStart(frames);
  });

  // ------------------------------------------------------------------ oscilloscope probe
  const probeScope = document.getElementById('probe-scope');
  const probeLabel = document.getElementById('probe-label');
  const probeCanvas = document.getElementById('probe-canvas');
  const probeCtx = probeCanvas.getContext('2d');
  let probeActive = 0;

  function probeAttach(pin, el) {
    probeActive = pin;
    api.setProbe(pin);
    probeLabel.textContent = (pin > 60 ? 'TP: ' : `pin ${pin}: `) + PIN_NAMES[pin];
    const r = el.getBoundingClientRect();
    const w = 272;
    probeScope.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left - w / 2)) + 'px';
    probeScope.style.top = (document.getElementById('cartbus').getBoundingClientRect().bottom + 4) + 'px';
    probeScope.classList.add('show');
  }
  function probeDetach(pin) {
    if (probeActive !== pin) return;
    probeActive = 0;
    api.setProbe(0);
    probeScope.classList.remove('show');
  }
  document.querySelectorAll('.tp').forEach((el) => {
    const pin = +el.dataset.pin;
    el.title = `${PIN_NAMES[pin]}`;
    el.addEventListener('mouseenter', () => probeAttach(pin, el));
    el.addEventListener('mouseleave', () => probeDetach(pin));
  });
  const stripChart = new Uint8Array(256).fill(30);
  function drawProbe() {
    if (!probeActive) return;
    const ptr = api.probeBuffer();
    if (!ptr) return;
    const buf = Module.HEAPU8.subarray(ptr, ptr + 2048);
    const head = api.probePos();
    const W = probeCanvas.width, H = probeCanvas.height;
    // slow clock: the 2048-cycle window spans seconds — switch to a
    // wall-time strip chart sampled every animation frame instead
    const slowMode = clockHz < 60000;
    if (slowMode) {
      stripChart.copyWithin(0, 1);
      stripChart[255] = api.probeLevel();
    }
    probeCtx.fillStyle = '#0a0f05';
    probeCtx.fillRect(0, 0, W, H);
    // graticule
    probeCtx.strokeStyle = '#1c2a12';
    probeCtx.lineWidth = 1;
    probeCtx.beginPath();
    for (let gx = 0; gx <= W; gx += 32) { probeCtx.moveTo(gx + 0.5, 0); probeCtx.lineTo(gx + 0.5, H); }
    for (let gy = 0; gy <= H; gy += 20) { probeCtx.moveTo(0, gy + 0.5); probeCtx.lineTo(W, gy + 0.5); }
    probeCtx.stroke();
    probeCtx.strokeStyle = '#7CFC66';
    probeCtx.lineWidth = 0.8;
    probeCtx.beginPath();
    if (slowMode) {
      // real-time scrolling trace (right edge = now)
      for (let x = 0; x < W; x++) {
        const v = stripChart[(x * 256 / W) | 0];
        const y = H - 4 - (v / 255) * (H - 8);
        if (x === 0) probeCtx.moveTo(x, y); else probeCtx.lineTo(x, y);
      }
    } else {
      // simple rising-edge trigger for a stable trace
      const at = (i) => buf[(head + i) & 2047];
      let trig = 0;
      for (let i = 1; i < 1024; i++) {
        if (at(i - 1) < 128 && at(i) >= 128) { trig = i; break; }
      }
      const N = 1024;
      for (let x = 0; x < W; x++) {
        const i = trig + ((x * N / W) | 0);
        const y = H - 4 - (at(i) / 255) * (H - 8);
        if (x === 0) probeCtx.moveTo(x, y); else probeCtx.lineTo(x, y);
      }
    }
    probeCtx.stroke();
  }

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
  // WRAM dump: one span per byte, double-click to edit in place
  const wramSpans = [];
  const wramHotAt = new Float64Array(0x800);
  const wramStreak = new Uint8Array(0x800);
  let wramPrimed = false;
  let editingSpan = null;
  for (let row = 0; row < 0x800; row += 16) {
    const line = document.createElement('div');
    const lab = document.createElement('span');
    lab.textContent = '$' + row.toString(16).toUpperCase().padStart(4, '0') + '  ';
    line.appendChild(lab);
    for (let i = 0; i < 16; i++) {
      const s = document.createElement('span');
      s.className = 'ram-b';
      s.dataset.addr = row + i;
      s.textContent = '00';
      line.appendChild(s);
      wramSpans.push(s);
    }
    dbgWram.appendChild(line);
  }
  // SMB loaded → show SMBDIS work-RAM names on hover
  function updateRamLabels(fileName) {
    const isSmb = /mario/i.test(fileName)
      || (lastRom && lastRom.prg && lastRom.prg.length === 0x8000 && crc32(lastRom.prg) === 0x5CF548D3);
    const L = (isSmb && window.SMB_RAM_LABELS) ? window.SMB_RAM_LABELS : null;
    for (let a = 0; a < 0x800; a++) {
      wramSpans[a].title = '$' + a.toString(16).toUpperCase().padStart(4, '0');
    }
    if (!L) return;
    const addrs = Object.keys(L).map(Number).sort((x, y) => x - y);
    for (let i = 0; i < addrs.length; i++) {
      const start = addrs[i];
      const end = Math.min(i + 1 < addrs.length ? addrs[i + 1] : start + 16, 0x800);
      const [name, comment] = L[start];
      for (let a = start; a < end; a++) {
        const off = a - start;
        wramSpans[a].title = '$' + a.toString(16).toUpperCase().padStart(4, '0')
          + '  ' + name + (off ? '+' + off : '') + (comment ? '\n' + comment : '');
      }
    }
  }

  dbgWram.addEventListener('dblclick', (e) => {
    const span = e.target.closest('.ram-b');
    if (!span || editingSpan) return;
    e.preventDefault();
    editingSpan = span;
    const addr = +span.dataset.addr;
    const inp = document.createElement('input');
    inp.className = 'ram-edit';
    inp.maxLength = 2;
    inp.value = span.textContent;
    span.textContent = '';
    span.appendChild(inp);
    inp.focus();
    inp.select();
    const finish = (commit) => {
      if (editingSpan !== span) return;
      editingSpan = null;
      const v = parseInt(inp.value, 16);
      inp.remove();
      if (commit && !isNaN(v)) Module.HEAPU8[api.ram() + addr] = v & 0xFF;
      span.textContent = hex2(Module.HEAPU8[api.ram() + addr]);
    };
    // keep hotkeys (R/D/F, pad keys) from firing while typing hex
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    inp.addEventListener('keyup', (ev) => ev.stopPropagation());
    inp.addEventListener('blur', () => finish(true));
  });
  const chrCanvas = document.getElementById('chr-canvas');
  const chrCtx = chrCanvas.getContext('2d');
  const chrImage = chrCtx.createImageData(128, 256);
  let chrPal = 0;
  function updateChrTitle() {
    document.getElementById('chr-title').textContent =
      t('chrTitle', { pal: t(chrPal < 4 ? 'bgPal' : 'spPal', { n: chrPal & 3 }) });
  }
  chrCanvas.addEventListener('click', () => {
    chrPal = (chrPal + 1) & 7;
    updateChrTitle();
    lastDebugUpdate = 0;
  });

  // waveform scopes
  const waveCanvases = [...document.querySelectorAll('canvas.wave')];
  const waveCtxs = waveCanvases.map((c) => c.getContext('2d'));
  // channel mute toggles: click the SQ1/SQ2/TRI/NOI/DMC labels
  const chanOn = [true, true, true, true, true];
  [...document.querySelectorAll('#dbg-waves .wave-row span')].slice(0, 5).forEach((span, ch) => {
    span.classList.add('chan-toggle');
    span.addEventListener('click', () => {
      chanOn[ch] = !chanOn[ch];
      api.setChannel(ch, chanOn[ch] ? 1 : 0);
      span.classList.toggle('muted', !chanOn[ch]);
    });
  });
  function updateMuteTips() {
    document.querySelectorAll('#dbg-waves .wave-row span.chan-toggle')
      .forEach((sp) => { sp.title = t('muteTip'); });
  }
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

  // ---- 6502 disassembler (for the debug panel) ----
  const DIS_TAB = (() => {
    const tab = {};
    const src = `ADC:69 imm,65 zp,75 zpx,6D abs,7D abx,79 aby,61 izx,71 izy
AND:29 imm,25 zp,35 zpx,2D abs,3D abx,39 aby,21 izx,31 izy
ASL:0A acc,06 zp,16 zpx,0E abs,1E abx
BCC:90 rel;BCS:B0 rel;BEQ:F0 rel;BIT:24 zp,2C abs;BMI:30 rel;BNE:D0 rel;BPL:10 rel
BRK:00 imp;BVC:50 rel;BVS:70 rel;CLC:18 imp;CLD:D8 imp;CLI:58 imp;CLV:B8 imp
CMP:C9 imm,C5 zp,D5 zpx,CD abs,DD abx,D9 aby,C1 izx,D1 izy
CPX:E0 imm,E4 zp,EC abs;CPY:C0 imm,C4 zp,CC abs
DEC:C6 zp,D6 zpx,CE abs,DE abx;DEX:CA imp;DEY:88 imp
EOR:49 imm,45 zp,55 zpx,4D abs,5D abx,59 aby,41 izx,51 izy
INC:E6 zp,F6 zpx,EE abs,FE abx;INX:E8 imp;INY:C8 imp
JMP:4C abs,6C ind;JSR:20 abs
LDA:A9 imm,A5 zp,B5 zpx,AD abs,BD abx,B9 aby,A1 izx,B1 izy
LDX:A2 imm,A6 zp,B6 zpy,AE abs,BE aby
LDY:A0 imm,A4 zp,B4 zpx,AC abs,BC abx
LSR:4A acc,46 zp,56 zpx,4E abs,5E abx
NOP:EA imp
ORA:09 imm,05 zp,15 zpx,0D abs,1D abx,19 aby,01 izx,11 izy
PHA:48 imp;PHP:08 imp;PLA:68 imp;PLP:28 imp
ROL:2A acc,26 zp,36 zpx,2E abs,3E abx
ROR:6A acc,66 zp,76 zpx,6E abs,7E abx
RTI:40 imp;RTS:60 imp
SBC:E9 imm,E5 zp,F5 zpx,ED abs,FD abx,F9 aby,E1 izx,F1 izy,EB imm
SEC:38 imp;SED:F8 imp;SEI:78 imp
STA:85 zp,95 zpx,8D abs,9D abx,99 aby,81 izx,91 izy
STX:86 zp,96 zpy,8E abs;STY:84 zp,94 zpx,8C abs
TAX:AA imp;TAY:A8 imp;TSX:BA imp;TXA:8A imp;TXS:9A imp;TYA:98 imp
LAX:A7 zp,B7 zpy,AF abs,BF aby,A3 izx,B3 izy
SAX:87 zp,97 zpy,8F abs,83 izx
DCP:C7 zp,D7 zpx,CF abs,DF abx,DB aby,C3 izx,D3 izy
ISC:E7 zp,F7 zpx,EF abs,FF abx,FB aby,E3 izx,F3 izy
SLO:07 zp,17 zpx,0F abs,1F abx,1B aby,03 izx,13 izy
RLA:27 zp,37 zpx,2F abs,3F abx,3B aby,23 izx,33 izy
SRE:47 zp,57 zpx,4F abs,5F abx,5B aby,43 izx,53 izy
RRA:67 zp,77 zpx,6F abs,7F abx,7B aby,63 izx,73 izy
ANC:0B imm,2B imm;ALR:4B imm;ARR:6B imm;AXS:CB imm
NOP*:1A imp,3A imp,5A imp,7A imp,DA imp,FA imp,80 imm,82 imm,89 imm,C2 imm,E2 imm,04 zp,44 zp,64 zp,14 zpx,34 zpx,54 zpx,74 zpx,D4 zpx,F4 zpx,0C abs,1C abx,3C abx,5C abx,7C abx,DC abx,FC abx`;
    for (const group of src.split(/[\n;]/)) {
      const [name, list] = group.split(':');
      for (const ent of list.split(',')) {
        const [code, mode] = ent.trim().split(' ');
        tab[parseInt(code, 16)] = [name, mode];
      }
    }
    return tab;
  })();
  const DIS_LEN = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, rel: 2, izx: 2, izy: 2, abs: 3, abx: 3, aby: 3, ind: 3 };
  const h4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

  function disasmLine(addr) {
    const op = api.peek(addr);
    const ent = DIS_TAB[op] || ['???', 'imp'];
    const [name, mode] = ent;
    const len = DIS_LEN[mode];
    const b1 = len > 1 ? api.peek(addr + 1) : 0;
    const b2 = len > 2 ? api.peek(addr + 2) : 0;
    const w = b1 | (b2 << 8);
    let operand = '';
    switch (mode) {
      case 'acc': operand = 'A'; break;
      case 'imm': operand = '#$' + hex2(b1); break;
      case 'zp':  operand = '$' + hex2(b1); break;
      case 'zpx': operand = '$' + hex2(b1) + ',X'; break;
      case 'zpy': operand = '$' + hex2(b1) + ',Y'; break;
      case 'abs': operand = '$' + h4(w); break;
      case 'abx': operand = '$' + h4(w) + ',X'; break;
      case 'aby': operand = '$' + h4(w) + ',Y'; break;
      case 'ind': operand = '($' + h4(w) + ')'; break;
      case 'izx': operand = '($' + hex2(b1) + ',X)'; break;
      case 'izy': operand = '($' + hex2(b1) + '),Y'; break;
      case 'rel': operand = '$' + h4((addr + 2 + (b1 << 24 >> 24)) & 0xFFFF); break;
    }
    const bytes = [op, b1, b2].slice(0, len).map(hex2).join(' ').padEnd(9);
    return { len, text: `${h4(addr)}  ${bytes} ${name} ${operand}`.trimEnd() };
  }

  function renderDisasm(pc) {
    let addr = pc;
    const lines = [];
    for (let i = 0; i < 12; i++) {
      const l = disasmLine(addr);
      lines.push((i === 0 ? '<span class="cur">&gt;' : '\u00a0') + l.text.replace(/</g, '&lt;') + (i === 0 ? '</span>' : ''));
      addr = (addr + l.len) & 0xFFFF;
    }
    document.getElementById('dbg-disasm').innerHTML = lines.join('\n');
  }

  function updateDebug(now) {
    if (!debugOn || now - lastDebugUpdate < 100) return;
    lastDebugUpdate = now;
    {
      const c = Module.HEAPU8.subarray(api.cpuRegs(), api.cpuRegs() + 12);
      const pc = c[0] | (c[1] << 8);
      const p = c[6];
      const flags = ['C','Z','I','D','B','-','V','N']
        .map((f, i) => (p >> i) & 1 ? f : f.toLowerCase()).reverse().join('');
      const frameN = c[8] | (c[9] << 8) | (c[10] << 16) | (c[11] << 24);
      document.getElementById('dbg-cpu').textContent =
        `PC=${pc.toString(16).toUpperCase().padStart(4, '0')}  A=${hex2(c[2])} X=${hex2(c[3])} Y=${hex2(c[4])}  SP=${hex2(c[5])}  P=${hex2(p)} [${flags}]  FRAME=${frameN}`;
      renderDisasm(pc);
    }
    const regs = Module.HEAPU8.subarray(api.apuRegs(), api.apuRegs() + 0x18);
    let apuText = '';
    for (let i = 0; i < 0x18; i++) {
      apuText += '$' + (0x4000 + i).toString(16).toUpperCase() + '  ' + hex2(regs[i])
               + '  ' + APU_REG_NAMES[i] + '\n';
    }
    dbgApu.textContent = apuText;

    const ram = Module.HEAPU8.subarray(api.ram(), api.ram() + 0x800);
    for (let a = 0; a < 0x800; a++) {
      const s = wramSpans[a];
      if (s === editingSpan) continue;   // don't clobber the byte being edited
      const h = hex2(ram[a]);
      const changed = s.textContent !== h;
      if (changed) s.textContent = h;
      if (!wramPrimed) continue;         // no classification on the initial fill
      // consecutive-change streak: constantly-changing bytes (timers, RNG)
      // are shown gray instead of glowing, so real events stand out
      let st = wramStreak[a];
      st = changed ? Math.min(st + 1, 20) : (st > 0 ? st - 1 : 0);
      wramStreak[a] = st;
      if (st >= 8) {
        s.classList.add('busy');
        s.classList.remove('hot');
        wramHotAt[a] = 0;
      } else {
        s.classList.remove('busy');
        if (changed) {
          s.classList.add('hot');
          wramHotAt[a] = now;
        } else if (wramHotAt[a] && now - wramHotAt[a] > 700) {
          s.classList.remove('hot');     // let the CSS transition fade it out
          wramHotAt[a] = 0;
        }
      }
    }
    wramPrimed = true;

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
    drawProbe();   // oscilloscope updates in real time, even when paused
    if (!running || resetHeld) return;   // reset held: CPU frozen in reset state

    acc += now - lastTime;
    lastTime = now;
    // at very low clocks we must accumulate enough time for at least 1 cycle
    const accCap = Math.max(150, 2200 * 1000 / clockHz);
    if (acc > accCap) acc = accCap;

    let ranFrame = false;
    if (tasFrames) {
      // TAS: strict frame stepping with the movie's inputs
      const effFrameMs = FRAME_MS * NES_CLOCK / clockHz;
      let burst = 0;
      while (tasFrames && acc >= effFrameMs && burst < 8) {
        burst++;
        acc -= effFrameMs;
        const f = tasFrames[tasIndex];
        if (f.cmd & 2) api.powerOn();
        else if (f.cmd & 1) api.reset();
        api.setButtons(0, f.bits);
        api.frame();
        window.__nes.frames++;
        ranFrame = true;
        tasIndex++;
        if (tasIndex % 30 === 0) statusEl.textContent = t('tasPlaying', { cur: tasIndex, total: tasFrames.length });
        if (tasIndex >= tasFrames.length) tasStop(t('tasDone'));
      }
      if (ranFrame) {
        const count = api.audioCount();
        if (count > 0) {
          if (pushSamples && !muted) {
            const ptr = api.audioBuffer() >> 2;
            pushSamples(Module.HEAPF32.slice(ptr, ptr + count));
          }
          if (debugOn) captureWave(count);
          api.audioClear();
        }
      }
    } else {
    const wantCycles = Math.min((clockHz * acc / 1000) | 0, 240000);
    if (wantCycles >= 1) {
      acc -= wantCycles * 1000 / clockHz;
      if (tilt !== 0) applyContacts();   // flaky contacts re-roll each burst
      api.setButtons(0, buttons | pollGamepad());
      api.runCycles(wantCycles);
      window.__nes.frames++;
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

    }
    if (ranFrame) {
      const ptr = api.framebuffer();
      imageData.data.set(Module.HEAPU8.subarray(ptr, ptr + 256 * 240 * 4));
      ctx.putImageData(imageData, 0, 0);
      updateDebug(now);
      if (tilt !== 0) updateBusUI(false);
    }
  }
  applyLanguage();
  requestAnimationFrame((now) => { lastTime = now; tick(now); });
})();
