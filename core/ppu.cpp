#include "nes.h"

namespace nes {

// Standard NES palette (2C02), RGBA in little-endian ABGR words
const uint32_t NES_PALETTE[64] = {
    0xFF666666, 0xFF882A00, 0xFFA71214, 0xFFA4003B, 0xFF7E005C, 0xFF40006E, 0xFF00066C, 0xFF001D56,
    0xFF003533, 0xFF00480B, 0xFF005200, 0xFF084F00, 0xFF4D4000, 0xFF000000, 0xFF000000, 0xFF000000,
    0xFFADADAD, 0xFFD95F15, 0xFFFF4042, 0xFFFE2775, 0xFFCC1AA0, 0xFF7B1EB7, 0xFF2031B5, 0xFF004E99,
    0xFF006D6B, 0xFF008738, 0xFF00930C, 0xFF328F00, 0xFF8D7C00, 0xFF000000, 0xFF000000, 0xFF000000,
    0xFFFFFEFF, 0xFFFFB064, 0xFFFF9092, 0xFFFF76C6, 0xFFFF6AF3, 0xFFCC6EFE, 0xFF7081FE, 0xFF229EEA,
    0xFF00BEBC, 0xFF00D888, 0xFF30E45C, 0xFF82E045, 0xFFDECD48, 0xFF4F4F4F, 0xFF000000, 0xFF000000,
    0xFFFFFEFF, 0xFFFFDFC0, 0xFFFFD2D3, 0xFFFFC8E8, 0xFFFFC2FB, 0xFFEAC4FE, 0xFFC5CCFE, 0xFFA5D8F7,
    0xFF94E5E4, 0xFF96EFCF, 0xFFA6EDB7, 0xFFCCEBA9, 0xFFF4E9A8, 0xFFB8B8B8, 0xFF000000, 0xFF000000,
};

void PPU::reset() {
    ctrl_ = mask_ = status_ = oamAddr_ = 0;
    v_ = t_ = 0; fineX_ = 0; w_ = false;
    readBuffer_ = 0;
    scanline_ = 261; dot_ = 0;
    oddFrame_ = false;
    frameReady = false;
}

uint16_t PPU::ntMirror(uint16_t addr) {
    // CIRAM A10 is derived by the cart from PPU A10/A11 — apply connector faults
    // to the table-select bits only (CIRAM A0-A9 run directly on the motherboard)
    int table = ((addr & nes_.chrAddrAnd) & 0x0FFF) / 0x400;
    int off = addr & 0x3FF;
    uint16_t r;
    switch (nes_.mapper->mirroring()) {
    case Mirroring::Vertical:   r = ((table & 1) * 0x400) + off; break;
    case Mirroring::Horizontal: r = ((table >> 1) * 0x400) + off; break;
    case Mirroring::SingleLow:  r = off; break;
    case Mirroring::SingleHigh: r = 0x400 + off; break;
    default:                    r = ((table & 1) * 0x400) + off; break; // 4-screen fallback
    }
    if (!nes_.ciramA10Ok) r &= ~0x400;   // CIRAM A10 pin broken: bit floats low
    nes_.lastCiramA10 = (r & 0x400) != 0;
    return r;
}

uint8_t PPU::vramRead(uint16_t addr) {
    addr &= 0x3FFF;
    if (addr < 0x3F00) { nes_.lastPpuAddr = addr; nes_.ppuRdPulse = true; }
    if (addr < 0x2000) {
        if (!nes_.powerOk || !nes_.ppuRdOk) return addr & 0xFF;   // bus floats
        uint8_t v = nes_.mapper->ppuRead(addr & nes_.chrAddrAnd & 0x1FFF);
        v = (v & nes_.chrDataAnd) | ((addr & 0xFF) & ~nes_.chrDataAnd);
        nes_.lastPpuData = v;
        return v;
    }
    if (addr < 0x3F00) {
        if (!nes_.ciramCeOk) return addr & 0xFF;   // nametable RAM not selected
        uint8_t v = vram_[ntMirror(addr)];
        nes_.lastPpuData = v;
        return v;
    }
    addr &= 0x1F;
    if (addr >= 0x10 && (addr & 3) == 0) addr &= 0x0F;
    return palette_[addr];
}

void PPU::vramWrite(uint16_t addr, uint8_t v) {
    addr &= 0x3FFF;
    if (addr < 0x3F00) { nes_.lastPpuAddr = addr; nes_.lastPpuData = v; nes_.ppuWrPulse = true; }
    if (addr < 0x2000) {
        if (!nes_.powerOk || !nes_.ppuWrOk) return;
        nes_.mapper->ppuWrite(addr & nes_.chrAddrAnd & 0x1FFF,
                              (v & nes_.chrDataAnd) | ((addr & 0xFF) & ~nes_.chrDataAnd));
        return;
    }
    if (addr < 0x3F00) {
        if (!nes_.ciramCeOk) return;
        vram_[ntMirror(addr)] = v;
        return;
    }
    addr &= 0x1F;
    if (addr >= 0x10 && (addr & 3) == 0) addr &= 0x0F;
    palette_[addr] = v;
}

uint8_t PPU::readReg(uint16_t addr) {
    switch (addr & 7) {
    case 2: {
        uint8_t r = (status_ & 0xE0) | (openBus_ & 0x1F);
        status_ &= ~0x80;   // clear vblank
        w_ = false;
        openBus_ = r;
        return r;
    }
    case 4:
        openBus_ = oam_[oamAddr_];
        return openBus_;
    case 7: {
        uint8_t r;
        if ((v_ & 0x3FFF) >= 0x3F00) {
            r = vramRead(v_);
            readBuffer_ = vramRead(v_ - 0x1000);  // underlying nametable
        } else {
            r = readBuffer_;
            readBuffer_ = vramRead(v_);
        }
        v_ += (ctrl_ & 0x04) ? 32 : 1;
        openBus_ = r;
        return r;
    }
    default:
        return openBus_;
    }
}

void PPU::writeReg(uint16_t addr, uint8_t val) {
    openBus_ = val;
    switch (addr & 7) {
    case 0: {
        bool wasNmi = ctrl_ & 0x80;
        ctrl_ = val;
        t_ = (t_ & 0xF3FF) | ((val & 3) << 10);
        // NMI edge if vblank set and NMI newly enabled
        if (!wasNmi && (ctrl_ & 0x80) && (status_ & 0x80)) nes_.cpu.nmi();
        break;
    }
    case 1: mask_ = val; break;
    case 3: oamAddr_ = val; break;
    case 4: oam_[oamAddr_++] = val; break;
    case 5:
        if (!w_) {
            t_ = (t_ & 0xFFE0) | (val >> 3);
            fineX_ = val & 7;
        } else {
            t_ = (t_ & 0x8C1F) | ((val & 0xF8) << 2) | ((val & 7) << 12);
        }
        w_ = !w_;
        break;
    case 6:
        if (!w_) {
            t_ = (t_ & 0x00FF) | ((val & 0x3F) << 8);
        } else {
            t_ = (t_ & 0xFF00) | val;
            v_ = t_;
        }
        w_ = !w_;
        break;
    case 7:
        vramWrite(v_, val);
        v_ += (ctrl_ & 0x04) ? 32 : 1;
        break;
    }
}

void PPU::writeOamDma(uint8_t, const uint8_t* page) {
    for (int i = 0; i < 256; i++) oam_[(oamAddr_ + i) & 0xFF] = page[i];
}

void PPU::incHoriz() {
    if ((v_ & 0x1F) == 31) { v_ &= ~0x1F; v_ ^= 0x0400; }
    else v_++;
}

void PPU::incVert() {
    if ((v_ & 0x7000) != 0x7000) { v_ += 0x1000; return; }
    v_ &= ~0x7000;
    int y = (v_ >> 5) & 0x1F;
    if (y == 29) { y = 0; v_ ^= 0x0800; }
    else if (y == 31) y = 0;
    else y++;
    v_ = (v_ & ~0x03E0) | (y << 5);
}

void PPU::fetchBg() {
    switch (dot_ & 7) {
    case 1:
        // reload shifters
        bgPatLo_ = (bgPatLo_ & 0xFF00) | patLo_;
        bgPatHi_ = (bgPatHi_ & 0xFF00) | patHi_;
        bgAttrLo_ = (bgAttrLo_ & 0xFF00) | ((atByte_ & 1) ? 0xFF : 0);
        bgAttrHi_ = (bgAttrHi_ & 0xFF00) | ((atByte_ & 2) ? 0xFF : 0);
        ntByte_ = vramRead(0x2000 | (v_ & 0x0FFF));
        break;
    case 3: {
        uint8_t at = vramRead(0x23C0 | (v_ & 0x0C00) | ((v_ >> 4) & 0x38) | ((v_ >> 2) & 0x07));
        int shift = ((v_ >> 4) & 4) | (v_ & 2);
        atByte_ = (at >> shift) & 3;
        break;
    }
    case 5:
        patLo_ = vramRead(((ctrl_ & 0x10) << 8) + ntByte_ * 16 + ((v_ >> 12) & 7));
        break;
    case 7:
        patHi_ = vramRead(((ctrl_ & 0x10) << 8) + ntByte_ * 16 + ((v_ >> 12) & 7) + 8);
        break;
    case 0:
        incHoriz();
        break;
    }
}

void PPU::evalSprites() {
    spriteCount_ = 0;
    int height = (ctrl_ & 0x20) ? 16 : 8;
    int line = scanline_;
    bool overflow = false;
    for (int i = 0; i < 64; i++) {
        int sy = oam_[i * 4];
        int row = line - sy;
        if (row < 0 || row >= height) continue;
        if (spriteCount_ == 8) { overflow = true; break; }
        uint8_t tile = oam_[i * 4 + 1];
        uint8_t attr = oam_[i * 4 + 2];
        int sx = oam_[i * 4 + 3];
        if (attr & 0x80) row = height - 1 - row;    // vertical flip
        uint16_t patAddr;
        if (height == 16) {
            uint16_t bank = (tile & 1) << 12;
            uint8_t t = tile & 0xFE;
            if (row >= 8) { t++; row -= 8; }
            patAddr = bank + t * 16 + row;
        } else {
            patAddr = ((ctrl_ & 0x08) << 9) + tile * 16 + row;
        }
        Sprite& s = sprites_[spriteCount_++];
        s.patLo = vramRead(patAddr);
        s.patHi = vramRead(patAddr + 8);
        s.attr = attr;
        s.x = sx;
        s.sprite0 = (i == 0);
    }
    if (overflow) status_ |= 0x20;
}

void PPU::renderDot() {
    int x = dot_ - 1;
    int y = scanline_;

    // background pixel
    int bgPixel = 0, bgPal = 0;
    if ((mask_ & 0x08) && (x >= 8 || (mask_ & 0x02))) {
        int bit = 15 - fineX_;
        bgPixel = ((bgPatLo_ >> bit) & 1) | (((bgPatHi_ >> bit) & 1) << 1);
        bgPal = ((bgAttrLo_ >> bit) & 1) | (((bgAttrHi_ >> bit) & 1) << 1);
    }

    // sprite pixel
    int spPixel = 0, spPal = 0;
    bool spBehind = false, spZero = false;
    if ((mask_ & 0x10) && (x >= 8 || (mask_ & 0x04))) {
        for (int i = 0; i < spriteCount_; i++) {
            Sprite& s = sprites_[i];
            int off = x - s.x;
            if (off < 0 || off > 7) continue;
            int bit = (s.attr & 0x40) ? off : 7 - off;   // horizontal flip
            int px = ((s.patLo >> bit) & 1) | (((s.patHi >> bit) & 1) << 1);
            if (px == 0) continue;
            spPixel = px;
            spPal = s.attr & 3;
            spBehind = s.attr & 0x20;
            spZero = s.sprite0;
            break;
        }
    }

    // sprite 0 hit
    if (spZero && spPixel && bgPixel && x < 255) status_ |= 0x40;

    int palIndex;
    if (bgPixel == 0 && spPixel == 0) palIndex = 0;
    else if (bgPixel == 0) palIndex = 0x10 + spPal * 4 + spPixel;
    else if (spPixel == 0) palIndex = bgPal * 4 + bgPixel;
    else palIndex = spBehind ? (bgPal * 4 + bgPixel) : (0x10 + spPal * 4 + spPixel);

    uint8_t colorIdx = palette_[palIndex] & 0x3F;
    if (mask_ & 0x01) colorIdx &= 0x30;   // greyscale
    framebuffer[y * 256 + x] = NES_PALETTE[colorIdx];
}

void PPU::step() {
    bool rendering = renderingEnabled();
    bool visible = scanline_ < 240;
    bool prerender = scanline_ == 261;

    if ((visible || prerender) && rendering) {
        // background fetch pipeline
        if ((dot_ >= 1 && dot_ <= 256) || (dot_ >= 321 && dot_ <= 336)) {
            if (visible && dot_ >= 1 && dot_ <= 256) renderDot();
            fetchBg();
            // shift
            bgPatLo_ <<= 1; bgPatHi_ <<= 1; bgAttrLo_ <<= 1; bgAttrHi_ <<= 1;
        }
        if (dot_ == 256) incVert();
        if (dot_ == 257) {
            // copy horizontal bits t -> v
            v_ = (v_ & ~0x041F) | (t_ & 0x041F);
            if (visible) evalSprites();
        }
        if (prerender && dot_ >= 280 && dot_ <= 304) {
            v_ = (v_ & ~0x7BE0) | (t_ & 0x7BE0);
        }
        if (dot_ == 260) nes_.mapper->scanline();   // MMC3 approximation
    } else if (visible && !rendering && dot_ >= 1 && dot_ <= 256) {
        // rendering disabled: draw backdrop color
        uint16_t bd = ((v_ & 0x3FFF) >= 0x3F00) ? (v_ & 0x1F) : 0;
        if (bd >= 0x10 && (bd & 3) == 0) bd &= 0x0F;
        framebuffer[scanline_ * 256 + dot_ - 1] = NES_PALETTE[palette_[bd] & 0x3F];
    }

    if (scanline_ == 241 && dot_ == 1) {
        status_ |= 0x80;
        if (ctrl_ & 0x80) nes_.cpu.nmi();
        frameReady = true;
    }
    if (prerender && dot_ == 1) {
        status_ &= ~(0x80 | 0x40 | 0x20);
    }

    dot_++;
    if (dot_ > 340) {
        dot_ = 0;
        scanline_++;
        if (scanline_ > 261) {
            scanline_ = 0;
            oddFrame_ = !oddFrame_;
            if (oddFrame_ && rendering) dot_ = 1;   // odd frame skip
        }
    }
}

} // namespace nes
