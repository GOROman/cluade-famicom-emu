#include "nes.h"

namespace nes {

// Famicom 60-pin cartridge connector: recompute signal masks from pin states.
// Pinout (nesdev wiki): front 1-30 = GND, CPU A11..A0, R/W, /IRQ, GND, PPU /RD,
// CIRAM A10, PPU A6..A0, PPU D0..D3, +5V / back 31-60 = +5V, M2, CPU A12-A14,
// CPU D7..D0, /ROMSEL, sound in/out, PPU /WR, CIRAM /CE, PPU /A13, PPU A7..A13,
// PPU D7..D4.
void NES::updatePins() {
    // power rails are redundant: either GND pin (1/16) and either +5V pin (30/31) suffices
    powerOk = (pinOk[1] || pinOk[16]) && (pinOk[30] || pinOk[31]);
    // CPU address: pins 2..13 = A11..A0, 33..35 = A12..A14
    prgAddrAnd = 0;
    for (int i = 0; i < 12; i++) if (pinOk[13 - i]) prgAddrAnd |= 1 << i;      // A0-A11
    for (int i = 0; i < 3; i++)  if (pinOk[33 + i]) prgAddrAnd |= 1 << (12 + i); // A12-A14
    // CPU data: pins 43..36 = D0..D7
    prgDataAnd = 0;
    for (int i = 0; i < 8; i++) if (pinOk[43 - i]) prgDataAnd |= 1 << i;
    rwOk = pinOk[14];
    irqOk = pinOk[15];
    m2Ok = pinOk[32];
    romselOk = pinOk[44];
    soundOk = pinOk[45] && pinOk[46];
    // PPU address: pins 25..19 = A0..A6, 50..56 = A7..A13
    chrAddrAnd = 0;
    for (int i = 0; i < 7; i++) if (pinOk[25 - i]) chrAddrAnd |= 1 << i;       // A0-A6
    for (int i = 0; i < 7; i++) if (pinOk[50 + i]) chrAddrAnd |= 1 << (7 + i); // A7-A13
    // PPU data: pins 26..29 = D0..D3, 60..57 = D4..D7
    chrDataAnd = 0;
    for (int i = 0; i < 4; i++) if (pinOk[26 + i]) chrDataAnd |= 1 << i;
    for (int i = 0; i < 4; i++) if (pinOk[60 - i]) chrDataAnd |= 1 << (4 + i);
    ppuRdOk = pinOk[17];
    ppuWrOk = pinOk[47];
    ciramA10Ok = pinOk[18];
    ciramCeOk = pinOk[48] && pinOk[49];   // most carts drive CIRAM /CE from PPU /A13
}

bool NES::loadRom(const uint8_t* data, size_t size) {
    mapper = nes::loadRom(data, size);
    if (!mapper) return false;
    reset();
    return true;
}

void NES::reset() {
    memset(ram, 0, sizeof(ram));
    ppu.reset();
    apu.reset();
    cpu.reset();
}

uint8_t NES::cpuRead(uint16_t addr) {
    if (addr < 0x2000) return ram[addr & 0x7FF];
    if (addr < 0x4000) return ppu.readReg(addr);
    if (addr == 0x4015) return apu.readStatus();
    if (addr == 0x4016) return pad[0].read();
    if (addr == 0x4017) return pad[1].read();
    if (addr < 0x4020) return 0;
    if (!mapper) return 0;
    // cartridge access through the (possibly faulty) connector
    if (!powerOk || !m2Ok) return cartOpenBus(addr);
    if (addr >= 0x8000 && !romselOk) return cartOpenBus(addr);
    uint16_t maskedAddr = (addr & 0x8000) | (addr & prgAddrAnd);
    uint8_t v = mapper->cpuRead(maskedAddr);
    return (v & prgDataAnd) | (cartOpenBus(addr) & ~prgDataAnd);
}

void NES::cpuWrite(uint16_t addr, uint8_t v) {
    if (addr < 0x2000) { ram[addr & 0x7FF] = v; return; }
    if (addr < 0x4000) { ppu.writeReg(addr, v); return; }
    if (addr == 0x4014) {
        // OAM DMA
        uint8_t page[256];
        uint16_t base = v << 8;
        for (int i = 0; i < 256; i++) page[i] = cpuRead(base + i);
        ppu.writeOamDma(v, page);
        cpu.addStall(513);
        return;
    }
    if (addr >= 0x4000 && addr <= 0x4017) apuRegShadow[addr - 0x4000] = v;
    if (addr == 0x4016) { pad[0].writeStrobe(v); pad[1].writeStrobe(v); return; }
    if (addr < 0x4020) { apu.writeReg(addr, v); return; }
    if (!mapper) return;
    if (!powerOk || !m2Ok || !rwOk) return;
    if (addr >= 0x8000 && !romselOk) return;
    uint16_t maskedAddr = (addr & 0x8000) | (addr & prgAddrAnd);
    mapper->cpuWrite(maskedAddr, (v & prgDataAnd) | (cartOpenBus(addr) & ~prgDataAnd));
}

void NES::runFrame() {
    ppu.frameReady = false;
    while (!ppu.frameReady) {
        // IRQ line: APU frame/DMC + mapper (MMC3)
        cpu.irq(apu.irqPending() || (mapper && irqOk && mapper->irqPending()));
        int cycles = cpu.step();
        for (int i = 0; i < cycles; i++) {
            apu.step();
            ppu.step();
            ppu.step();
            ppu.step();
        }
    }
}

} // namespace nes

// ================================================================ WASM C API
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define API EMSCRIPTEN_KEEPALIVE
#else
#define API
#endif

static nes::NES* g_nes = nullptr;
static uint8_t g_romBuf[4 * 1024 * 1024];

extern "C" {

API void nes_init(double sampleRate) {
    if (!g_nes) g_nes = new nes::NES();
    g_nes->apu.setSampleRate(sampleRate);
}

API uint8_t* nes_rom_buffer() { return g_romBuf; }

API int nes_load_rom(int size) {
    if (!g_nes || size <= 0 || (size_t)size > sizeof(g_romBuf)) return 0;
    return g_nes->loadRom(g_romBuf, (size_t)size) ? 1 : 0;
}

API void nes_reset() { if (g_nes && g_nes->mapper) g_nes->reset(); }

API void nes_frame() {
    if (!g_nes || !g_nes->mapper) return;
    g_nes->runFrame();
    // Famicom audio loops through the cartridge (pins 45/46) — a bad contact mutes it
    if (!g_nes->soundOk)
        for (int i = 0; i < g_nes->apu.sampleCount; i++) g_nes->apu.sampleBuf[i] = 0;
}

API void nes_set_pin(int pin, int on) {
    if (!g_nes || pin < 1 || pin > 60) return;
    g_nes->pinOk[pin] = on != 0;
    g_nes->updatePins();
}
API int nes_get_pin(int pin) {
    return (g_nes && pin >= 1 && pin <= 60) ? (g_nes->pinOk[pin] ? 1 : 0) : 1;
}
API void nes_reset_pins() {
    if (!g_nes) return;
    for (int i = 0; i < 61; i++) g_nes->pinOk[i] = true;
    g_nes->updatePins();
}

API uint32_t* nes_framebuffer() { return g_nes ? g_nes->ppu.framebuffer : nullptr; }

API void nes_set_buttons(int padIndex, int buttons) {
    if (g_nes && padIndex >= 0 && padIndex < 2)
        g_nes->pad[padIndex].setButtons((uint8_t)buttons);
}

API float* nes_audio_buffer() { return g_nes ? g_nes->apu.sampleBuf : nullptr; }
API int nes_audio_sample_count() { return g_nes ? g_nes->apu.sampleCount : 0; }
API void nes_audio_clear() { if (g_nes) g_nes->apu.sampleCount = 0; }

API uint8_t* nes_sram() {
    return (g_nes && g_nes->mapper) ? g_nes->mapper->prgRam().data() : nullptr;
}
API int nes_sram_size() {
    return (g_nes && g_nes->mapper) ? (int)g_nes->mapper->prgRam().size() : 0;
}
// CHR pattern tables rendered as a 128x256 RGBA image (table 0 on top, 1 below)
static uint32_t g_chrImage[128 * 256];

API uint32_t* nes_render_chr(int palIdx) {
    if (!g_nes || !g_nes->mapper) return nullptr;
    // colorize with the current PPU palette (palIdx 0-3: BG, 4-7: sprite)
    const uint8_t* pal = g_nes->ppu.paletteRam();
    palIdx &= 7;
    const uint32_t SHADES[4] = {
        nes::NES_PALETTE[pal[0] & 0x3F],
        nes::NES_PALETTE[pal[palIdx * 4 + 1] & 0x3F],
        nes::NES_PALETTE[pal[palIdx * 4 + 2] & 0x3F],
        nes::NES_PALETTE[pal[palIdx * 4 + 3] & 0x3F],
    };
    // read CHR through the (possibly faulty) connector, same as the PPU does
    auto chrRead = [&](uint16_t addr) -> uint8_t {
        if (!g_nes->powerOk || !g_nes->ppuRdOk) return addr & 0xFF;
        uint8_t v = g_nes->mapper->ppuRead(addr & g_nes->chrAddrAnd & 0x1FFF);
        return (v & g_nes->chrDataAnd) | ((addr & 0xFF) & ~g_nes->chrDataAnd);
    };
    for (int table = 0; table < 2; table++) {
        for (int tile = 0; tile < 256; tile++) {
            int baseX = (tile & 15) * 8;
            int baseY = table * 128 + (tile >> 4) * 8;
            uint16_t addr = table * 0x1000 + tile * 16;
            for (int y = 0; y < 8; y++) {
                uint8_t lo = chrRead(addr + y);
                uint8_t hi = chrRead(addr + y + 8);
                for (int x = 0; x < 8; x++) {
                    int px = ((lo >> (7 - x)) & 1) | (((hi >> (7 - x)) & 1) << 1);
                    g_chrImage[(baseY + y) * 128 + baseX + x] = SHADES[px];
                }
            }
        }
    }
    return g_chrImage;
}

API uint8_t* nes_ram() { return g_nes ? g_nes->ram : nullptr; }
API uint8_t* nes_apu_regs() { return g_nes ? g_nes->apuRegShadow : nullptr; }
API uint8_t* nes_chan_buffer(int ch) {
    return (g_nes && ch >= 0 && ch < 5) ? g_nes->apu.chanBuf[ch] : nullptr;
}

API int nes_has_battery() {
    return (g_nes && g_nes->mapper && g_nes->mapper->hasBattery()) ? 1 : 0;
}

} // extern "C"
