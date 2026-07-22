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
    default: return nullptr;
    }
}

} // namespace nes
