#pragma once
#include <cstdint>
#include <cstring>
#include <vector>
#include <memory>

namespace nes {

class NES;

// ---------------------------------------------------------------- Cartridge
enum class Mirroring { Horizontal, Vertical, SingleLow, SingleHigh, FourScreen };

class Mapper {
public:
    Mapper(std::vector<uint8_t> prg, std::vector<uint8_t> chr, Mirroring m, bool battery)
        : prg_(std::move(prg)), chr_(std::move(chr)), mirroring_(m), battery_(battery) {
        chrRam_ = chr_.empty();
        if (chrRam_) chr_.resize(0x2000, 0);
        prgRam_.resize(0x2000, 0);
    }
    virtual ~Mapper() = default;

    virtual uint8_t cpuRead(uint16_t addr) = 0;
    virtual void cpuWrite(uint16_t addr, uint8_t v) = 0;
    virtual uint8_t ppuRead(uint16_t addr) = 0;   // $0000-$1FFF
    virtual void ppuWrite(uint16_t addr, uint8_t v) {
        if (chrRam_) chr_[addr & 0x1FFF] = v;
    }
    // Called once per scanline at PPU dot ~260 when rendering enabled (MMC3 IRQ)
    virtual void scanline() {}
    virtual bool irqPending() const { return false; }
    virtual void irqClear() {}

    Mirroring mirroring() const { return mirroring_; }
    bool hasBattery() const { return battery_; }
    std::vector<uint8_t>& prgRam() { return prgRam_; }

protected:
    std::vector<uint8_t> prg_, chr_, prgRam_;
    Mirroring mirroring_;
    bool battery_;
    bool chrRam_ = false;
};

std::unique_ptr<Mapper> loadRom(const uint8_t* data, size_t size);

// ---------------------------------------------------------------- CPU (6502)
class CPU {
public:
    explicit CPU(NES& nes) : nes_(nes) {}
    void reset();
    int step();                 // execute one instruction, return cycles
    void nmi() { nmiPending_ = true; }
    void irq(bool level) { irqLine_ = level; }
    void addStall(int c) { stall_ += c; }

    uint16_t pc = 0;
    uint8_t a = 0, x = 0, y = 0, sp = 0xFD;
    // status flags
    bool fC = false, fZ = false, fI = true, fD = false, fV = false, fN = false;

private:
    NES& nes_;
    bool nmiPending_ = false;
    bool irqLine_ = false;
    int stall_ = 0;

    uint8_t read(uint16_t addr);
    void write(uint16_t addr, uint8_t v);
    uint16_t read16(uint16_t addr);
    void push(uint8_t v);
    uint8_t pop();
    uint8_t status(bool brk) const;
    void setStatus(uint8_t p);
    void setZN(uint8_t v) { fZ = v == 0; fN = v & 0x80; }
    void branch(bool cond, int& cycles);
};

// ---------------------------------------------------------------- PPU
class PPU {
public:
    explicit PPU(NES& nes) : nes_(nes) {}
    void reset();
    void step();                // one PPU cycle (dot)

    uint8_t readReg(uint16_t addr);       // $2000-$2007
    void writeReg(uint16_t addr, uint8_t v);
    void writeOamDma(uint8_t v, const uint8_t* page);

    bool frameReady = false;    // set at end of each frame; consumer clears
    uint32_t frameCount = 0;    // frames since reset/power-on
    uint32_t framebuffer[256 * 240] = {};
    const uint8_t* paletteRam() const { return palette_; }
    // level of the PPU→CPU NMI output (true = asserted)
    bool nmiLine() const { return (ctrl_ & 0x80) && (status_ & 0x80); }

private:
    NES& nes_;

    // registers
    uint8_t ctrl_ = 0, mask_ = 0, status_ = 0, oamAddr_ = 0;
    uint16_t v_ = 0, t_ = 0;    // loopy
    uint8_t fineX_ = 0;
    bool w_ = false;
    uint8_t readBuffer_ = 0;
    uint8_t openBus_ = 0;

    uint8_t oam_[256] = {};
    uint8_t palette_[32] = {};
    uint8_t vram_[0x800] = {};  // 2KB nametable RAM

    int scanline_ = 261, dot_ = 0;
    bool oddFrame_ = false;

    // background shifters
    uint16_t bgPatLo_ = 0, bgPatHi_ = 0, bgAttrLo_ = 0, bgAttrHi_ = 0;
    uint8_t ntByte_ = 0, atByte_ = 0, patLo_ = 0, patHi_ = 0;

    // sprite evaluation for current scanline
    struct Sprite { uint8_t patLo, patHi, attr; int x; bool sprite0; };
    Sprite sprites_[8];
    int spriteCount_ = 0;

    uint8_t vramRead(uint16_t addr);
    void vramWrite(uint16_t addr, uint8_t v);
    uint16_t ntMirror(uint16_t addr);
    void incHoriz();
    void incVert();
    void fetchBg();
    void evalSprites();
    void renderDot();
    bool renderingEnabled() const { return mask_ & 0x18; }
};

// ---------------------------------------------------------------- APU
class APU {
public:
    explicit APU(NES& nes) : nes_(nes) {}
    void reset();
    void step();                // one CPU cycle
    uint8_t readStatus();
    void writeReg(uint16_t addr, uint8_t v);
    bool irqPending() const { return frameIrq_ || dmcIrq_; }

    // audio output: float samples accumulated per frame
    float sampleBuf[2048] = {};
    int sampleCount = 0;
    // per-channel raw levels at each sample point (debug scope): p1,p2,tri,noise,dmc
    uint8_t chanBuf[5][2048] = {};
    // per-channel mute switches (UI): p1,p2,tri,noise,dmc
    bool chanEnable[5] = {true, true, true, true, true};
    void setSampleRate(double rate) { cyclesPerSample_ = 1789773.0 / rate; }
    float mix() const;   // public: also used by the oscilloscope probe

private:
    NES& nes_;

    struct Pulse {
        bool enabled = false;
        uint8_t duty = 0; int dutyPos = 0;
        uint16_t timer = 0; int timerCounter = 0;
        int lengthCounter = 0; bool lengthHalt = false;
        // envelope
        bool constVolume = false; uint8_t volume = 0;
        bool envStart = false; int envDivider = 0; int envDecay = 0;
        // sweep
        bool sweepEnabled = false, sweepNegate = false, sweepReload = false;
        uint8_t sweepPeriod = 0, sweepShift = 0; int sweepDivider = 0;
        bool isPulse2 = false;
        int output() const;
        void stepTimer();
        void stepEnvelope();
        void stepSweep();
        bool sweepMuted() const;
    } pulse1_, pulse2_;

    struct Triangle {
        bool enabled = false;
        uint16_t timer = 0; int timerCounter = 0;
        int lengthCounter = 0; bool lengthHalt = false;
        int linearCounter = 0; uint8_t linearReload = 0; bool linearReloadFlag = false;
        int seqPos = 0;
        int output() const;
        void stepTimer();
    } triangle_;

    struct Noise {
        bool enabled = false;
        bool mode = false;
        uint16_t shiftReg = 1;
        int timerPeriod = 0; int timerCounter = 0;
        int lengthCounter = 0; bool lengthHalt = false;
        bool constVolume = false; uint8_t volume = 0;
        bool envStart = false; int envDivider = 0; int envDecay = 0;
        int output() const;
        void stepTimer();
        void stepEnvelope();
    } noise_;

    struct DMC {
        bool enabled = false;
        bool irqEnable = false, loop = false;
        int timerPeriod = 0; int timerCounter = 0;
        uint8_t outputLevel = 0;
        uint16_t sampleAddr = 0, currentAddr = 0;
        int sampleLength = 0, bytesRemaining = 0;
        uint8_t shiftReg = 0; int bitsRemaining = 0;
        bool bufferFilled = false; uint8_t buffer = 0;
        bool silence = true;
    } dmc_;

    int frameStep_ = 0;
    int frameCounterCycles_ = 0;
    bool fiveStep_ = false;
    bool irqInhibit_ = false;
    bool frameIrq_ = false;
    bool dmcIrq_ = false;
    bool oddCycle_ = false;

    double cyclesPerSample_ = 1789773.0 / 44100.0;
    double sampleTimer_ = 0;

    void quarterFrame();
    void halfFrame();
    void stepDmc();
};

// ---------------------------------------------------------------- Controller
class Controller {
public:
    void setButtons(uint8_t b) { buttons_ = b; }
    void writeStrobe(uint8_t v) {
        strobe_ = v & 1;
        if (strobe_) shift_ = buttons_;
    }
    uint8_t read() {
        if (strobe_) return (buttons_ & 1) | 0x40;
        uint8_t r = (shift_ & 1) | 0x40;
        shift_ = (shift_ >> 1) | 0x80;
        return r;
    }
private:
    uint8_t buttons_ = 0, shift_ = 0;
    bool strobe_ = false;
};

// ---------------------------------------------------------------- NES
class NES {
public:
    NES() : cpu(*this), ppu(*this), apu(*this) {
        for (int i = 0; i < 61; i++) pinOk[i] = true;
    }

    bool loadRom(const uint8_t* data, size_t size);
    void reset();      // RESET button: chips reset, RAM preserved (bug techniques!)
    void powerOn();    // power cycle: RAM cleared + reset
    void runFrame();
    void runCycles(int n);   // sub-frame stepping for very low clock rates

    uint8_t cpuRead(uint16_t addr);
    void cpuWrite(uint16_t addr, uint8_t v);

    CPU cpu;
    PPU ppu;
    APU apu;
    Controller pad[2];
    std::unique_ptr<Mapper> mapper;
    uint8_t ram[0x800] = {};
    uint8_t apuRegShadow[0x18] = {};   // last value written to $4000-$4017 (debug view)

    // ---- cartridge connector fault emulation (60-pin, 1-based) ----
    bool pinOk[61];
    // derived signal masks/flags, recomputed by updatePins()
    uint16_t prgAddrAnd = 0x7FFF;   // CPU A0-A14 to cart
    uint8_t  prgDataAnd = 0xFF;     // CPU D0-D7
    uint16_t chrAddrAnd = 0x3FFF;   // PPU A0-A13 to cart
    uint8_t  chrDataAnd = 0xFF;     // PPU D0-D7
    bool romselOk = true, m2Ok = true, rwOk = true, irqOk = true;
    bool ppuRdOk = true, ppuWrOk = true, ciramCeOk = true, ciramA10Ok = true;
    bool soundOk = true, powerOk = true;
    void updatePins();
    uint8_t cartOpenBus(uint16_t addr) const { return addr >> 8; }

    // ---- oscilloscope probe (hover a pin in the UI) ----
    int probePin = 0;               // 1-60, 0 = no probe
    uint8_t probeBuf[2048] = {};    // one sample per CPU cycle (~1.1ms window)
    int probePos = 0;
    uint64_t cycleCount = 0;
    uint16_t lastCpuAddr = 0; uint8_t lastCpuData = 0; bool lastCpuWrite = false;
    uint16_t lastPpuAddr = 0; uint8_t lastPpuData = 0;
    bool ppuRdPulse = false, ppuWrPulse = false, lastCiramA10 = false;
    void probeSample();
    uint8_t cpuReadBus(uint16_t addr);
};

extern const uint32_t NES_PALETTE[64];

// APU length counter table (shared)
extern const uint8_t LENGTH_TABLE[32];

} // namespace nes
