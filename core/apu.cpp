#include "nes.h"

namespace nes {

const uint8_t LENGTH_TABLE[32] = {
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
};

static const uint8_t DUTY_TABLE[4][8] = {
    {0, 1, 0, 0, 0, 0, 0, 0},
    {0, 1, 1, 0, 0, 0, 0, 0},
    {0, 1, 1, 1, 1, 0, 0, 0},
    {1, 0, 0, 1, 1, 1, 1, 1},
};

static const uint8_t TRIANGLE_SEQ[32] = {
    15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
};

static const uint16_t NOISE_PERIODS[16] = {
    4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
};

static const uint16_t DMC_PERIODS[16] = {
    428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
};

// ---- Pulse ----
void APU::Pulse::stepTimer() {
    if (--timerCounter < 0) {
        timerCounter = timer;
        dutyPos = (dutyPos + 1) & 7;
    }
}
void APU::Pulse::stepEnvelope() {
    if (envStart) {
        envStart = false;
        envDecay = 15;
        envDivider = volume;
    } else if (--envDivider < 0) {
        envDivider = volume;
        if (envDecay > 0) envDecay--;
        else if (lengthHalt) envDecay = 15;
    }
}
bool APU::Pulse::sweepMuted() const {
    if (timer < 8) return true;
    if (!sweepNegate) {
        int target = timer + (timer >> sweepShift);
        if (target > 0x7FF) return true;
    }
    return false;
}
void APU::Pulse::stepSweep() {
    if (--sweepDivider < 0 || sweepReload) {
        if (sweepDivider < 0 && sweepEnabled && sweepShift && !sweepMuted()) {
            int delta = timer >> sweepShift;
            if (sweepNegate) timer -= delta + (isPulse2 ? 0 : 1);
            else timer += delta;
        }
        if (sweepDivider < 0 || sweepReload) {
            sweepDivider = sweepPeriod;
            sweepReload = false;
        }
    }
}
int APU::Pulse::output() const {
    if (!enabled || lengthCounter == 0 || sweepMuted()) return 0;
    if (!DUTY_TABLE[duty][dutyPos]) return 0;
    return constVolume ? volume : envDecay;
}

// ---- Triangle ----
void APU::Triangle::stepTimer() {
    if (--timerCounter < 0) {
        timerCounter = timer;
        if (lengthCounter > 0 && linearCounter > 0 && timer >= 2)
            seqPos = (seqPos + 1) & 31;
    }
}
int APU::Triangle::output() const {
    if (!enabled || lengthCounter == 0 || linearCounter == 0) return TRIANGLE_SEQ[seqPos];
    return TRIANGLE_SEQ[seqPos];
}

// ---- Noise ----
void APU::Noise::stepTimer() {
    if (--timerCounter < 0) {
        timerCounter = timerPeriod;
        int fb = (shiftReg & 1) ^ ((shiftReg >> (mode ? 6 : 1)) & 1);
        shiftReg = (shiftReg >> 1) | (fb << 14);
    }
}
void APU::Noise::stepEnvelope() {
    if (envStart) {
        envStart = false;
        envDecay = 15;
        envDivider = volume;
    } else if (--envDivider < 0) {
        envDivider = volume;
        if (envDecay > 0) envDecay--;
        else if (lengthHalt) envDecay = 15;
    }
}
int APU::Noise::output() const {
    if (!enabled || lengthCounter == 0 || (shiftReg & 1)) return 0;
    return constVolume ? volume : envDecay;
}

// ---- APU ----
void APU::reset() {
    pulse1_ = Pulse{};
    pulse2_ = Pulse{}; pulse2_.isPulse2 = true;
    triangle_ = Triangle{};
    noise_ = Noise{};
    dmc_ = DMC{};
    frameStep_ = 0;
    frameCounterCycles_ = 0;
    fiveStep_ = false;
    irqInhibit_ = false;
    frameIrq_ = dmcIrq_ = false;
    oddCycle_ = false;
    sampleCount = 0;
    sampleTimer_ = 0;
}

void APU::quarterFrame() {
    pulse1_.stepEnvelope();
    pulse2_.stepEnvelope();
    noise_.stepEnvelope();
    if (triangle_.linearReloadFlag) triangle_.linearCounter = triangle_.linearReload;
    else if (triangle_.linearCounter > 0) triangle_.linearCounter--;
    if (!triangle_.lengthHalt) triangle_.linearReloadFlag = false;
}

void APU::halfFrame() {
    auto clockLength = [](int& lc, bool halt) { if (!halt && lc > 0) lc--; };
    clockLength(pulse1_.lengthCounter, pulse1_.lengthHalt);
    clockLength(pulse2_.lengthCounter, pulse2_.lengthHalt);
    clockLength(triangle_.lengthCounter, triangle_.lengthHalt);
    clockLength(noise_.lengthCounter, noise_.lengthHalt);
    pulse1_.stepSweep();
    pulse2_.stepSweep();
}

void APU::stepDmc() {
    // fetch sample byte when needed
    if (!dmc_.bufferFilled && dmc_.bytesRemaining > 0) {
        dmc_.buffer = nes_.cpuRead(dmc_.currentAddr);
        nes_.cpu.addStall(4);
        dmc_.bufferFilled = true;
        dmc_.currentAddr = (dmc_.currentAddr == 0xFFFF) ? 0x8000 : dmc_.currentAddr + 1;
        if (--dmc_.bytesRemaining == 0) {
            if (dmc_.loop) {
                dmc_.currentAddr = dmc_.sampleAddr;
                dmc_.bytesRemaining = dmc_.sampleLength;
            } else if (dmc_.irqEnable) {
                dmcIrq_ = true;
            }
        }
    }
    if (--dmc_.timerCounter < 0) {
        dmc_.timerCounter = dmc_.timerPeriod;
        if (!dmc_.silence) {
            if (dmc_.shiftReg & 1) { if (dmc_.outputLevel <= 125) dmc_.outputLevel += 2; }
            else { if (dmc_.outputLevel >= 2) dmc_.outputLevel -= 2; }
        }
        dmc_.shiftReg >>= 1;
        if (--dmc_.bitsRemaining <= 0) {
            dmc_.bitsRemaining = 8;
            if (dmc_.bufferFilled) {
                dmc_.silence = false;
                dmc_.shiftReg = dmc_.buffer;
                dmc_.bufferFilled = false;
            } else {
                dmc_.silence = true;
            }
        }
    }
}

// Per-channel contributions. The 2A03 mixes pulses and TND through two
// non-linear stages, so each channel's share is split proportionally out of
// its stage: the shares always sum back to the exact mono mix.
void APU::channelOutputs(float out[8]) const {
    float p1 = chanEnable[0] ? pulse1_.output() * chanVolume[0] : 0.0f;
    float p2 = chanEnable[1] ? pulse2_.output() * chanVolume[1] : 0.0f;
    float psum = p1 + p2;
    float pulseOut = psum > 0.0f ? 95.88f / (8128.0f / psum + 100.0f) : 0.0f;
    out[0] = psum > 0.0f ? pulseOut * (p1 / psum) : 0.0f;
    out[1] = psum > 0.0f ? pulseOut * (p2 / psum) : 0.0f;

    float t = (chanEnable[2] ? triangle_.output() * chanVolume[2] : 0.0f) / 8227.0f;
    float n = (chanEnable[3] ? noise_.output() * chanVolume[3] : 0.0f) / 12241.0f;
    float d = (chanEnable[4] ? dmc_.outputLevel * chanVolume[4] : 0.0f) / 22638.0f;
    float tsum = t + n + d;
    float tnd = tsum > 0.0f ? 159.79f / (1.0f / tsum + 100.0f) : 0.0f;
    out[2] = tsum > 0.0f ? tnd * (t / tsum) : 0.0f;
    out[3] = tsum > 0.0f ? tnd * (n / tsum) : 0.0f;
    out[4] = tsum > 0.0f ? tnd * (d / tsum) : 0.0f;

    float g = nes_.mapper ? nes_.mapper->expansionGain() : 0.0f;
    for (int c = 0; c < 3; c++) {
        float v = (g > 0.0f && nes_.mapper) ? (float)nes_.mapper->expansionChannel(c) : 0.0f;
        out[5 + c] = chanEnable[5 + c] ? v * chanVolume[5 + c] * g : 0.0f;
    }
}

float APU::mix() const {
    float out[8];
    channelOutputs(out);
    float s = 0.0f;
    for (int c = 0; c < 8; c++) s += out[c];
    return s;
}

// Linear pan law with unity at centre, so a centred mix is bit-identical to mono
void APU::mixStereo(float& l, float& r) const {
    float out[8];
    channelOutputs(out);
    l = r = 0.0f;
    for (int c = 0; c < 8; c++) {
        float p = chanPan[c];
        l += out[c] * (p <= 0.0f ? 1.0f : 1.0f - p);
        r += out[c] * (p >= 0.0f ? 1.0f : 1.0f + p);
    }
}

void APU::step() {
    // triangle clocks every CPU cycle; pulse/noise/dmc every other
    triangle_.stepTimer();
    if (oddCycle_) {
        pulse1_.stepTimer();
        pulse2_.stepTimer();
        noise_.stepTimer();
        stepDmc();
    }
    oddCycle_ = !oddCycle_;

    // frame counter (approximate CPU-cycle timing)
    frameCounterCycles_++;
    static const int STEP4[4] = {7457, 14913, 22371, 29829};
    static const int STEP5[5] = {7457, 14913, 22371, 29829, 37281};
    if (!fiveStep_) {
        if (frameStep_ < 4 && frameCounterCycles_ >= STEP4[frameStep_]) {
            quarterFrame();
            if (frameStep_ == 1 || frameStep_ == 3) halfFrame();
            if (frameStep_ == 3) {
                if (!irqInhibit_) frameIrq_ = true;
                frameCounterCycles_ = 0;
            }
            frameStep_ = (frameStep_ + 1) & 3;
        }
    } else {
        if (frameStep_ < 5 && frameCounterCycles_ >= STEP5[frameStep_]) {
            if (frameStep_ != 3) {
                quarterFrame();
                if (frameStep_ == 1 || frameStep_ == 4) halfFrame();
            }
            if (frameStep_ == 4) frameCounterCycles_ = 0;
            frameStep_ = frameStep_ == 4 ? 0 : frameStep_ + 1;
        }
    }

    // downsample
    sampleTimer_ += 1.0;
    if (sampleTimer_ >= cyclesPerSample_) {
        sampleTimer_ -= cyclesPerSample_;
        if (sampleCount < (int)(sizeof(sampleBuf) / sizeof(float))) {
            float l, r;
            mixStereo(l, r);
            sampleBuf[sampleCount] = l;
            sampleBufR[sampleCount] = r;
            chanBuf[0][sampleCount] = (uint8_t)pulse1_.output();
            chanBuf[1][sampleCount] = (uint8_t)pulse2_.output();
            chanBuf[2][sampleCount] = (uint8_t)triangle_.output();
            chanBuf[3][sampleCount] = (uint8_t)noise_.output();
            chanBuf[4][sampleCount] = dmc_.outputLevel;
            for (int c = 0; c < 3; c++)
                chanBuf[5 + c][sampleCount] =
                    nes_.mapper ? (uint8_t)nes_.mapper->expansionChannel(c) : 0;
            sampleCount++;
        }
    }
}

uint8_t APU::readStatus() {
    uint8_t r = 0;
    if (pulse1_.lengthCounter > 0) r |= 0x01;
    if (pulse2_.lengthCounter > 0) r |= 0x02;
    if (triangle_.lengthCounter > 0) r |= 0x04;
    if (noise_.lengthCounter > 0) r |= 0x08;
    if (dmc_.bytesRemaining > 0) r |= 0x10;
    if (frameIrq_) r |= 0x40;
    if (dmcIrq_) r |= 0x80;
    frameIrq_ = false;
    return r;
}

void APU::writeReg(uint16_t addr, uint8_t v) {
    switch (addr) {
    case 0x4000: case 0x4004: {
        Pulse& p = (addr == 0x4000) ? pulse1_ : pulse2_;
        p.duty = v >> 6;
        p.lengthHalt = v & 0x20;
        p.constVolume = v & 0x10;
        p.volume = v & 0x0F;
        break;
    }
    case 0x4001: case 0x4005: {
        Pulse& p = (addr == 0x4001) ? pulse1_ : pulse2_;
        p.sweepEnabled = v & 0x80;
        p.sweepPeriod = (v >> 4) & 7;
        p.sweepNegate = v & 0x08;
        p.sweepShift = v & 7;
        p.sweepReload = true;
        break;
    }
    case 0x4002: case 0x4006: {
        Pulse& p = (addr == 0x4002) ? pulse1_ : pulse2_;
        p.timer = (p.timer & 0x700) | v;
        break;
    }
    case 0x4003: case 0x4007: {
        Pulse& p = (addr == 0x4003) ? pulse1_ : pulse2_;
        p.timer = (p.timer & 0xFF) | ((v & 7) << 8);
        if (p.enabled) p.lengthCounter = LENGTH_TABLE[v >> 3];
        p.envStart = true;
        p.dutyPos = 0;
        break;
    }
    case 0x4008:
        triangle_.lengthHalt = v & 0x80;
        triangle_.linearReload = v & 0x7F;
        break;
    case 0x400A:
        triangle_.timer = (triangle_.timer & 0x700) | v;
        break;
    case 0x400B:
        triangle_.timer = (triangle_.timer & 0xFF) | ((v & 7) << 8);
        if (triangle_.enabled) triangle_.lengthCounter = LENGTH_TABLE[v >> 3];
        triangle_.linearReloadFlag = true;
        break;
    case 0x400C:
        noise_.lengthHalt = v & 0x20;
        noise_.constVolume = v & 0x10;
        noise_.volume = v & 0x0F;
        break;
    case 0x400E:
        noise_.mode = v & 0x80;
        noise_.timerPeriod = NOISE_PERIODS[v & 0x0F];
        break;
    case 0x400F:
        if (noise_.enabled) noise_.lengthCounter = LENGTH_TABLE[v >> 3];
        noise_.envStart = true;
        break;
    case 0x4010:
        dmc_.irqEnable = v & 0x80;
        if (!dmc_.irqEnable) dmcIrq_ = false;
        dmc_.loop = v & 0x40;
        dmc_.timerPeriod = DMC_PERIODS[v & 0x0F] / 2;   // stepped every other CPU cycle
        break;
    case 0x4011:
        dmc_.outputLevel = v & 0x7F;
        break;
    case 0x4012:
        dmc_.sampleAddr = 0xC000 + v * 64;
        break;
    case 0x4013:
        dmc_.sampleLength = v * 16 + 1;
        break;
    case 0x4015:
        pulse1_.enabled = v & 0x01;
        pulse2_.enabled = v & 0x02;
        triangle_.enabled = v & 0x04;
        noise_.enabled = v & 0x08;
        dmc_.enabled = v & 0x10;
        if (!pulse1_.enabled) pulse1_.lengthCounter = 0;
        if (!pulse2_.enabled) pulse2_.lengthCounter = 0;
        if (!triangle_.enabled) triangle_.lengthCounter = 0;
        if (!noise_.enabled) noise_.lengthCounter = 0;
        if (!dmc_.enabled) dmc_.bytesRemaining = 0;
        else if (dmc_.bytesRemaining == 0) {
            dmc_.currentAddr = dmc_.sampleAddr;
            dmc_.bytesRemaining = dmc_.sampleLength;
        }
        dmcIrq_ = false;
        break;
    case 0x4017:
        fiveStep_ = v & 0x80;
        irqInhibit_ = v & 0x40;
        if (irqInhibit_) frameIrq_ = false;
        frameCounterCycles_ = 0;
        frameStep_ = 0;
        if (fiveStep_) { quarterFrame(); halfFrame(); }
        break;
    }
}

} // namespace nes
