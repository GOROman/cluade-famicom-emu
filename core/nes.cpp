#include "nes.h"

namespace nes {

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
    return mapper ? mapper->cpuRead(addr) : 0;
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
    if (mapper) mapper->cpuWrite(addr, v);
}

void NES::runFrame() {
    ppu.frameReady = false;
    while (!ppu.frameReady) {
        // IRQ line: APU frame/DMC + mapper (MMC3)
        cpu.irq(apu.irqPending() || (mapper && mapper->irqPending()));
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

API void nes_frame() { if (g_nes && g_nes->mapper) g_nes->runFrame(); }

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

API uint32_t* nes_render_chr() {
    if (!g_nes || !g_nes->mapper) return nullptr;
    static const uint32_t SHADES[4] = {0xFF000000, 0xFF555555, 0xFFAAAAAA, 0xFFFFFFFF};
    for (int table = 0; table < 2; table++) {
        for (int tile = 0; tile < 256; tile++) {
            int baseX = (tile & 15) * 8;
            int baseY = table * 128 + (tile >> 4) * 8;
            uint16_t addr = table * 0x1000 + tile * 16;
            for (int y = 0; y < 8; y++) {
                uint8_t lo = g_nes->mapper->ppuRead(addr + y);
                uint8_t hi = g_nes->mapper->ppuRead(addr + y + 8);
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

API int nes_has_battery() {
    return (g_nes && g_nes->mapper && g_nes->mapper->hasBattery()) ? 1 : 0;
}

} // extern "C"
