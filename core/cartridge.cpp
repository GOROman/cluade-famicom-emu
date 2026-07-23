#include "nes.h"

namespace nes {

// ------------------------------------------------------------- Mapper 0: NROM
class Mapper0 : public Mapper {
public:
    using Mapper::Mapper;
    uint8_t cpuRead(uint16_t addr) override {
        if (addr >= 0x8000) return prg_[(addr - 0x8000) % prg_.size()];
        if (addr >= 0x6000) return prgRam_[addr - 0x6000];
        return 0;
    }
    void cpuWrite(uint16_t addr, uint8_t v) override {
        if (addr >= 0x6000 && addr < 0x8000) prgRam_[addr - 0x6000] = v;
    }
    uint8_t ppuRead(uint16_t addr) override { return chr_[addr & 0x1FFF]; }
};

// ------------------------------------------------------------- Mapper 1: MMC1
class Mapper1 : public Mapper {
public:
    Mapper1(std::vector<uint8_t> prg, std::vector<uint8_t> chr, Mirroring m, bool battery)
        : Mapper(std::move(prg), std::move(chr), m, battery) {
        prgBanks_ = (int)(prg_.size() / 0x4000);
    }
    uint8_t cpuRead(uint16_t addr) override {
        if (addr >= 0x6000 && addr < 0x8000) return prgRam_[addr - 0x6000];
        if (addr < 0x8000) return 0;
        int bank;
        int prgMode = (control_ >> 2) & 3;
        if (prgMode <= 1) {
            bank = (prgBank_ & 0x0E) + ((addr >> 14) & 1);   // 32KB mode
        } else if (prgMode == 2) {
            bank = (addr < 0xC000) ? 0 : prgBank_;
        } else {
            bank = (addr < 0xC000) ? prgBank_ : prgBanks_ - 1;
        }
        return prg_[((bank % prgBanks_) * 0x4000) + (addr & 0x3FFF)];
    }
    void cpuWrite(uint16_t addr, uint8_t v) override {
        if (addr >= 0x6000 && addr < 0x8000) { prgRam_[addr - 0x6000] = v; return; }
        if (addr < 0x8000) return;
        if (v & 0x80) {
            shift_ = 0x10;
            control_ |= 0x0C;
            return;
        }
        bool full = shift_ & 1;
        shift_ = (shift_ >> 1) | ((v & 1) << 4);
        if (!full) return;
        uint8_t d = shift_;
        shift_ = 0x10;
        switch ((addr >> 13) & 3) {
        case 0:
            control_ = d;
            switch (d & 3) {
            case 0: mirroring_ = Mirroring::SingleLow; break;
            case 1: mirroring_ = Mirroring::SingleHigh; break;
            case 2: mirroring_ = Mirroring::Vertical; break;
            case 3: mirroring_ = Mirroring::Horizontal; break;
            }
            break;
        case 1: chrBank0_ = d; break;
        case 2: chrBank1_ = d; break;
        case 3: prgBank_ = d & 0x0F; break;
        }
    }
    uint8_t ppuRead(uint16_t addr) override { return chr_[chrAddr(addr)]; }
    void ppuWrite(uint16_t addr, uint8_t v) override { if (chrRam_) chr_[chrAddr(addr)] = v; }
private:
    size_t chrAddr(uint16_t addr) {
        size_t banks4k = chr_.size() / 0x1000;
        size_t a;
        if (control_ & 0x10) {
            int bank = (addr < 0x1000) ? chrBank0_ : chrBank1_;
            a = (bank % banks4k) * 0x1000 + (addr & 0x0FFF);
        } else {
            a = ((chrBank0_ & 0x1E) % banks4k) * 0x1000 + (addr & 0x1FFF);
        }
        return a % chr_.size();
    }
    uint8_t shift_ = 0x10;
    uint8_t control_ = 0x0C;
    uint8_t chrBank0_ = 0, chrBank1_ = 0, prgBank_ = 0;
    int prgBanks_;
};

// ------------------------------------------------------------ Mapper 2: UxROM
class Mapper2 : public Mapper {
public:
    Mapper2(std::vector<uint8_t> prg, std::vector<uint8_t> chr, Mirroring m, bool battery)
        : Mapper(std::move(prg), std::move(chr), m, battery) {
        prgBanks_ = (int)(prg_.size() / 0x4000);
    }
    uint8_t cpuRead(uint16_t addr) override {
        if (addr < 0x8000) {
            if (addr >= 0x6000) return prgRam_[addr - 0x6000];
            return 0;
        }
        int bank = (addr < 0xC000) ? bank_ : prgBanks_ - 1;
        return prg_[(bank % prgBanks_) * 0x4000 + (addr & 0x3FFF)];
    }
    void cpuWrite(uint16_t addr, uint8_t v) override {
        if (addr >= 0x8000) bank_ = v;
        else if (addr >= 0x6000) prgRam_[addr - 0x6000] = v;
    }
    uint8_t ppuRead(uint16_t addr) override { return chr_[addr & 0x1FFF]; }
private:
    int bank_ = 0, prgBanks_;
};

// ------------------------------------------------------------ Mapper 3: CNROM
class Mapper3 : public Mapper {
public:
    using Mapper::Mapper;
    uint8_t cpuRead(uint16_t addr) override {
        if (addr >= 0x8000) return prg_[(addr - 0x8000) % prg_.size()];
        return 0;
    }
    void cpuWrite(uint16_t addr, uint8_t v) override {
        // no mask: oversize CNROM (e.g. Convoy no Nazo, 64KB CHR) uses more than 2 bits
        if (addr >= 0x8000) bank_ = v % (int)(chr_.size() / 0x2000);
    }
    uint8_t ppuRead(uint16_t addr) override {
        return chr_[(size_t)bank_ * 0x2000 + (addr & 0x1FFF)];
    }
private:
    int bank_ = 0;
};

// ------------------------------------------------------------- Mapper 4: MMC3
class Mapper4 : public Mapper {
public:
    Mapper4(std::vector<uint8_t> prg, std::vector<uint8_t> chr, Mirroring m, bool battery)
        : Mapper(std::move(prg), std::move(chr), m, battery) {
        prgBanks8k_ = (int)(prg_.size() / 0x2000);
        fourScreen_ = (m == Mirroring::FourScreen);
    }
    uint8_t cpuRead(uint16_t addr) override {
        if (addr >= 0x6000 && addr < 0x8000) return prgRam_[addr - 0x6000];
        if (addr < 0x8000) return 0;
        int slot = (addr - 0x8000) / 0x2000;   // 0..3
        int bank;
        bool swap = bankSelect_ & 0x40;
        switch (slot) {
        case 0: bank = swap ? prgBanks8k_ - 2 : regs_[6]; break;
        case 1: bank = regs_[7]; break;
        case 2: bank = swap ? regs_[6] : prgBanks8k_ - 2; break;
        default: bank = prgBanks8k_ - 1; break;
        }
        return prg_[(bank % prgBanks8k_) * 0x2000 + (addr & 0x1FFF)];
    }
    void cpuWrite(uint16_t addr, uint8_t v) override {
        if (addr >= 0x6000 && addr < 0x8000) { prgRam_[addr - 0x6000] = v; return; }
        if (addr < 0x8000) return;
        bool even = !(addr & 1);
        if (addr < 0xA000) {
            if (even) bankSelect_ = v;
            else regs_[bankSelect_ & 7] = v;
        } else if (addr < 0xC000) {
            if (even) {
                if (!fourScreen_) mirroring_ = (v & 1) ? Mirroring::Horizontal : Mirroring::Vertical;
            }
            // odd: PRG RAM protect (ignored)
        } else if (addr < 0xE000) {
            if (even) irqLatch_ = v;
            else irqCounter_ = 0;   // reload on next clock
        } else {
            if (even) { irqEnabled_ = false; irqPending_ = false; }
            else irqEnabled_ = true;
        }
    }
    uint8_t ppuRead(uint16_t addr) override { return chr_[chrAddr(addr)]; }
    void ppuWrite(uint16_t addr, uint8_t v) override { if (chrRam_) chr_[chrAddr(addr)] = v; }
    void scanline() override {
        if (irqCounter_ == 0) irqCounter_ = irqLatch_;
        else irqCounter_--;
        if (irqCounter_ == 0 && irqEnabled_) irqPending_ = true;
    }
    bool irqPending() const override { return irqPending_; }
    void irqClear() override { irqPending_ = false; }
private:
    size_t chrAddr(uint16_t addr) {
        bool invert = bankSelect_ & 0x80;
        uint16_t a = invert ? (addr ^ 0x1000) : addr;
        size_t banks1k = chr_.size() / 0x400;
        int bank;
        if (a < 0x800) bank = (regs_[0] & 0xFE) + ((a >> 10) & 1);
        else if (a < 0x1000) bank = (regs_[1] & 0xFE) + ((a >> 10) & 1);
        else bank = regs_[2 + ((a - 0x1000) >> 10)];
        return ((size_t)(bank % banks1k)) * 0x400 + (a & 0x3FF);
    }
    uint8_t bankSelect_ = 0;
    uint8_t regs_[8] = {};
    int prgBanks8k_;
    bool fourScreen_ = false;
    uint8_t irqLatch_ = 0, irqCounter_ = 0;
    bool irqEnabled_ = false, irqPending_ = false;
};

// ------------------------------------------------- Mapper 24/26: Konami VRC6
// Akumajou Densetsu (24, VRC6a) / Madara, Esper Dream 2 (26, VRC6b).
// Adds three expansion sound channels (2 pulse + sawtooth) on the cartridge.
class Mapper6502VRC6 : public Mapper {
public:
    Mapper6502VRC6(std::vector<uint8_t> prg, std::vector<uint8_t> chr, Mirroring m,
                   bool battery, bool swapA0A1)
        : Mapper(std::move(prg), std::move(chr), m, battery), swapA0A1_(swapA0A1) {
        prgBanks16_ = (int)(prg_.size() / 0x4000);
        prgBanks8_ = (int)(prg_.size() / 0x2000);
        prgRam_.resize(0x2000, 0);
    }

    uint8_t cpuRead(uint16_t addr) override {
        if (addr >= 0x6000 && addr < 0x8000) return prgRamEnable_ ? prgRam_[addr - 0x6000] : 0;
        if (addr < 0x8000) return 0;
        int bank;
        if (addr < 0xC000)      bank = (prg16_ % (prgBanks16_ ? prgBanks16_ : 1)) * 2 + ((addr >> 13) & 1);
        else if (addr < 0xE000) bank = prg8_;
        else                    bank = prgBanks8_ - 1;
        return prg_[((size_t)(bank % prgBanks8_)) * 0x2000 + (addr & 0x1FFF)];
    }

    void cpuWrite(uint16_t addr, uint8_t v) override {
        if (addr >= 0x6000 && addr < 0x8000) { if (prgRamEnable_) prgRam_[addr - 0x6000] = v; return; }
        if (addr < 0x8000) return;
        // VRC6b swaps the A0/A1 lines feeding the register decoder
        uint16_t reg = addr & 0xF000;
        int idx = addr & 3;
        if (swapA0A1_) idx = ((idx & 1) << 1) | ((idx >> 1) & 1);

        switch (reg) {
        case 0x8000: prg16_ = v & 0x0F; break;
        case 0x9000: case 0xA000: case 0xB000: {
            if (reg == 0xB000 && idx == 3) { writeBankMode(v); break; }
            audioWrite(reg, idx, v);
            break;
        }
        case 0xC000: prg8_ = v & 0x1F; break;
        case 0xD000: chrReg_[idx] = v; break;
        case 0xE000: chrReg_[4 + idx] = v; break;
        case 0xF000:
            if (idx == 0) irqLatch_ = v;
            else if (idx == 1) {
                irqMode_ = v & 4;
                irqEnable_ = v & 2;
                irqEnableAfterAck_ = v & 1;
                if (irqEnable_) { irqCounter_ = irqLatch_; irqPrescaler_ = 341; }
                irqPending_ = false;
            } else if (idx == 2) {
                irqPending_ = false;
                irqEnable_ = irqEnableAfterAck_;
            }
            break;
        }
    }

    uint8_t ppuRead(uint16_t addr) override {
        size_t banks1k = chr_.size() / 0x400;
        if (!banks1k) return 0;
        int slot = (addr >> 10) & 7;
        int bank;
        switch (chrMode_) {
        case 0:  bank = chrReg_[slot]; break;                          // 8 x 1KB
        case 1:  bank = (chrReg_[slot >> 1] << 1) | (slot & 1); break; // 4 x 2KB
        default: bank = (slot < 4) ? chrReg_[slot]                     // 4 x 1KB + 2 x 2KB
                                   : ((chrReg_[4 + ((slot - 4) >> 1)] << 1) | (slot & 1));
                 break;
        }
        return chr_[((size_t)(bank % (int)banks1k)) * 0x400 + (addr & 0x3FF)];
    }

    // ---- VRC IRQ: prescaler counts 341 "PPU-ish" ticks per scanline in mode 0 ----
    void cpuCycle() override {
        clockAudio();
        if (!irqEnable_) return;
        if (irqMode_) {                       // cycle mode
            clockIrqCounter();
        } else {                              // scanline mode
            irqPrescaler_ -= 3;
            if (irqPrescaler_ <= 0) {
                irqPrescaler_ += 341;
                clockIrqCounter();
            }
        }
    }
    bool irqPending() const override { return irqPending_; }
    void irqClear() override { irqPending_ = false; }

    // ---- expansion audio ----
    bool hasExpansionAudio() const override { return true; }
    int expansionChannel(int ch) const override {
        switch (ch) {
        case 0: return expMute_[0] ? 0 : pulseOut(p1_);
        case 1: return expMute_[1] ? 0 : pulseOut(p2_);
        default: return expMute_[2] ? 0 : sawOut();
        }
    }
    float audioOut() const override {
        int sum = expansionChannel(0) + expansionChannel(1) + expansionChannel(2);
        return sum * expansionGain();
    }
    // 6-bit linear DAC, leveled against the 2A03 mix
    float expansionGain() const override { return 0.0065f; }

private:
    struct Pulse {
        uint8_t volume = 0, duty = 0;
        bool ignoreDuty = false, enabled = false;
        uint16_t freq = 0;
        int timer = 0, step = 15;
    } p1_, p2_;
    struct Saw {
        uint8_t rate = 0, accumulator = 0;
        bool enabled = false;
        uint16_t freq = 0;
        int timer = 0, step = 0;
    } saw_;

    int pulseOut(const Pulse& p) const {
        if (!p.enabled) return 0;
        return (p.ignoreDuty || p.step <= p.duty) ? p.volume : 0;
    }
    int sawOut() const { return saw_.enabled ? (saw_.accumulator >> 3) : 0; }

    void audioWrite(uint16_t reg, int idx, uint8_t v) {
        if (reg == 0x9000 && idx == 3) {        // frequency control
            halt_ = v & 1;
            freqShift_ = (v & 4) ? 8 : ((v & 2) ? 4 : 0);
            return;
        }
        if (reg == 0xB000) {                    // sawtooth
            if (idx == 0) saw_.rate = v & 0x3F;
            else if (idx == 1) saw_.freq = (saw_.freq & 0xF00) | v;
            else {
                saw_.freq = (saw_.freq & 0x0FF) | ((v & 0x0F) << 8);
                saw_.enabled = v & 0x80;
                if (!saw_.enabled) { saw_.accumulator = 0; saw_.step = 0; }
            }
            return;
        }
        Pulse& p = (reg == 0x9000) ? p1_ : p2_;
        if (idx == 0) {
            p.volume = v & 0x0F;
            p.duty = (v >> 4) & 7;
            p.ignoreDuty = v & 0x80;
        } else if (idx == 1) {
            p.freq = (p.freq & 0xF00) | v;
        } else {
            p.freq = (p.freq & 0x0FF) | ((v & 0x0F) << 8);
            p.enabled = v & 0x80;
            if (!p.enabled) p.step = 15;
        }
    }

    void clockPulse(Pulse& p) {
        if (!p.enabled) return;
        if (--p.timer <= 0) {
            p.timer = (p.freq >> freqShift_) + 1;
            p.step = (p.step - 1) & 0x0F;
        }
    }
    void clockAudio() {
        if (halt_) return;
        clockPulse(p1_);
        clockPulse(p2_);
        if (saw_.enabled && --saw_.timer <= 0) {
            saw_.timer = (saw_.freq >> freqShift_) + 1;
            saw_.step++;
            if (saw_.step & 1) saw_.accumulator += saw_.rate;
            if (saw_.step >= 14) { saw_.step = 0; saw_.accumulator = 0; }
        }
    }

    void clockIrqCounter() {
        if (irqCounter_ == 0xFF) { irqCounter_ = irqLatch_; irqPending_ = true; }
        else irqCounter_++;
    }

    void writeBankMode(uint8_t v) {
        chrMode_ = v & 3;
        prgRamEnable_ = v & 0x80;
        if (chrMode_ == 0) {           // CIRAM nametables, mirroring from bits 2-3
            switch ((v >> 2) & 3) {
            case 0: mirroring_ = Mirroring::Vertical; break;
            case 1: mirroring_ = Mirroring::Horizontal; break;
            case 2: mirroring_ = Mirroring::SingleLow; break;
            default: mirroring_ = Mirroring::SingleHigh; break;
            }
        }
    }

    bool swapA0A1_;
    int prgBanks16_ = 1, prgBanks8_ = 1;
    uint8_t prg16_ = 0, prg8_ = 0;
    uint8_t chrReg_[8] = {};
    int chrMode_ = 0;
    bool prgRamEnable_ = true;
    // IRQ
    uint8_t irqLatch_ = 0, irqCounter_ = 0;
    int irqPrescaler_ = 341;
    bool irqMode_ = false, irqEnable_ = false, irqEnableAfterAck_ = false, irqPending_ = false;
    // audio globals
    bool halt_ = false;
    int freqShift_ = 0;
};

// ---------------------------------------------------------------- ROM loader
std::unique_ptr<Mapper> loadRom(const uint8_t* data, size_t size) {
    if (size < 16 || memcmp(data, "NES\x1A", 4) != 0) return nullptr;

    int prgBanks = data[4];
    int chrBanks = data[5];
    uint8_t flags6 = data[6];
    uint8_t flags7 = data[7];
    // Archaic iNES: bytes 12-15 should be zero; if not (e.g. "DiskDude!" garbage),
    // the flags7 upper nibble is unreliable — use only the low nibble of the mapper.
    bool dirtyHeader = data[12] || data[13] || data[14] || data[15];
    int mapperNum = (flags6 >> 4) | (dirtyHeader ? 0 : (flags7 & 0xF0));
    bool battery = flags6 & 0x02;
    bool trainer = flags6 & 0x04;

    Mirroring mirror;
    if (flags6 & 0x08) mirror = Mirroring::FourScreen;
    else mirror = (flags6 & 0x01) ? Mirroring::Vertical : Mirroring::Horizontal;

    size_t offset = 16 + (trainer ? 512 : 0);
    size_t prgSize = (size_t)prgBanks * 0x4000;
    size_t chrSize = (size_t)chrBanks * 0x2000;
    if (offset + prgSize + chrSize > size) return nullptr;

    std::vector<uint8_t> prg(data + offset, data + offset + prgSize);
    std::vector<uint8_t> chr(data + offset + prgSize, data + offset + prgSize + chrSize);

    switch (mapperNum) {
    case 0: return std::make_unique<Mapper0>(std::move(prg), std::move(chr), mirror, battery);
    case 1: return std::make_unique<Mapper1>(std::move(prg), std::move(chr), mirror, battery);
    case 2: return std::make_unique<Mapper2>(std::move(prg), std::move(chr), mirror, battery);
    case 3: return std::make_unique<Mapper3>(std::move(prg), std::move(chr), mirror, battery);
    case 4: return std::make_unique<Mapper4>(std::move(prg), std::move(chr), mirror, battery);
    case 24: return std::make_unique<Mapper6502VRC6>(std::move(prg), std::move(chr), mirror, battery, false);
    case 26: return std::make_unique<Mapper6502VRC6>(std::move(prg), std::move(chr), mirror, battery, true);
    default: return nullptr;
    }
}

} // namespace nes
