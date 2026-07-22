#include "nes.h"

namespace nes {

uint8_t CPU::read(uint16_t addr) { return nes_.cpuRead(addr); }
void CPU::write(uint16_t addr, uint8_t v) { nes_.cpuWrite(addr, v); }
uint16_t CPU::read16(uint16_t addr) { return read(addr) | (read(addr + 1) << 8); }
void CPU::push(uint8_t v) { write(0x100 | sp--, v); }
uint8_t CPU::pop() { return read(0x100 | ++sp); }

uint8_t CPU::status(bool brk) const {
    return (fN << 7) | (fV << 6) | 0x20 | (brk << 4) | (fD << 3) | (fI << 2) | (fZ << 1) | (uint8_t)fC;
}
void CPU::setStatus(uint8_t p) {
    fN = p & 0x80; fV = p & 0x40; fD = p & 0x08; fI = p & 0x04; fZ = p & 0x02; fC = p & 0x01;
}

void CPU::reset() {
    pc = read16(0xFFFC);
    sp = 0xFD;
    fI = true;
    nmiPending_ = false;
    irqLine_ = false;
    stall_ = 0;
}

// Addressing modes: each returns effective address; pageCrossed set for +1 cycle modes
namespace {
inline bool samePage(uint16_t a, uint16_t b) { return (a & 0xFF00) == (b & 0xFF00); }
}

void CPU::branch(bool cond, int& cycles) {
    int8_t off = (int8_t)read(pc++);
    if (cond) {
        uint16_t old = pc;
        pc += off;
        cycles += samePage(old, pc) ? 1 : 2;
    }
}

int CPU::step() {
    if (stall_ > 0) { int s = stall_; stall_ = 0; return s; }

    if (nmiPending_) {
        nmiPending_ = false;
        push(pc >> 8); push(pc & 0xFF);
        push(status(false));
        fI = true;
        pc = read16(0xFFFA);
        return 7;
    }
    if (irqLine_ && !fI) {
        push(pc >> 8); push(pc & 0xFF);
        push(status(false));
        fI = true;
        pc = read16(0xFFFE);
        return 7;
    }

    uint8_t op = read(pc++);
    int cycles = 0;
    bool crossed = false;

    // --- effective address helpers ---
    auto imm  = [&]() -> uint16_t { return pc++; };
    auto zp   = [&]() -> uint16_t { return read(pc++); };
    auto zpx  = [&]() -> uint16_t { return (read(pc++) + x) & 0xFF; };
    auto zpy  = [&]() -> uint16_t { return (read(pc++) + y) & 0xFF; };
    auto abs_ = [&]() -> uint16_t { uint16_t a = read16(pc); pc += 2; return a; };
    auto abx  = [&]() -> uint16_t { uint16_t b = read16(pc); pc += 2; uint16_t a = b + x; crossed = !samePage(a, b); return a; };
    auto aby  = [&]() -> uint16_t { uint16_t b = read16(pc); pc += 2; uint16_t a = b + y; crossed = !samePage(a, b); return a; };
    auto izx  = [&]() -> uint16_t { uint8_t z = read(pc++) + x; return read(z) | (read((uint8_t)(z + 1)) << 8); };
    auto izy  = [&]() -> uint16_t {
        uint8_t z = read(pc++);
        uint16_t b = read(z) | (read((uint8_t)(z + 1)) << 8);
        uint16_t a = b + y; crossed = !samePage(a, b); return a;
    };

    // --- operations ---
    auto lda = [&](uint16_t a) { this->a = read(a); setZN(this->a); };
    auto ldx = [&](uint16_t a) { x = read(a); setZN(x); };
    auto ldy = [&](uint16_t a) { y = read(a); setZN(y); };
    auto sta = [&](uint16_t a) { write(a, this->a); };
    auto stx = [&](uint16_t a) { write(a, x); };
    auto sty = [&](uint16_t a) { write(a, y); };
    auto adcv = [&](uint8_t m) {
        int r = a + m + (fC ? 1 : 0);
        fV = (~(a ^ m) & (a ^ r)) & 0x80;
        fC = r > 0xFF;
        a = (uint8_t)r; setZN(a);
    };
    auto adc = [&](uint16_t ad) { adcv(read(ad)); };
    auto sbc = [&](uint16_t ad) { adcv(~read(ad)); };
    auto and_ = [&](uint16_t ad) { a &= read(ad); setZN(a); };
    auto ora = [&](uint16_t ad) { a |= read(ad); setZN(a); };
    auto eor = [&](uint16_t ad) { a ^= read(ad); setZN(a); };
    auto cmpv = [&](uint8_t reg, uint8_t m) { fC = reg >= m; setZN(reg - m); };
    auto cmp = [&](uint16_t ad) { cmpv(a, read(ad)); };
    auto cpx_ = [&](uint16_t ad) { cmpv(x, read(ad)); };
    auto cpy_ = [&](uint16_t ad) { cmpv(y, read(ad)); };
    auto bit = [&](uint16_t ad) { uint8_t m = read(ad); fZ = (a & m) == 0; fV = m & 0x40; fN = m & 0x80; };
    auto aslv = [&](uint8_t m) -> uint8_t { fC = m & 0x80; m <<= 1; setZN(m); return m; };
    auto lsrv = [&](uint8_t m) -> uint8_t { fC = m & 0x01; m >>= 1; setZN(m); return m; };
    auto rolv = [&](uint8_t m) -> uint8_t { bool c = fC; fC = m & 0x80; m = (m << 1) | c; setZN(m); return m; };
    auto rorv = [&](uint8_t m) -> uint8_t { bool c = fC; fC = m & 0x01; m = (m >> 1) | (c << 7); setZN(m); return m; };
    auto rmw = [&](uint16_t ad, uint8_t (CPU::*)(uint8_t), uint8_t v) { write(ad, v); };
    (void)rmw;
    auto asl = [&](uint16_t ad) { uint8_t m = read(ad); write(ad, m); write(ad, aslv(m)); };
    auto lsr = [&](uint16_t ad) { uint8_t m = read(ad); write(ad, m); write(ad, lsrv(m)); };
    auto rol = [&](uint16_t ad) { uint8_t m = read(ad); write(ad, m); write(ad, rolv(m)); };
    auto ror = [&](uint16_t ad) { uint8_t m = read(ad); write(ad, m); write(ad, rorv(m)); };
    auto inc = [&](uint16_t ad) { uint8_t m = read(ad) + 1; write(ad, m); setZN(m); };
    auto dec = [&](uint16_t ad) { uint8_t m = read(ad) - 1; write(ad, m); setZN(m); };
    // unofficial
    auto lax = [&](uint16_t ad) { a = x = read(ad); setZN(a); };
    auto sax = [&](uint16_t ad) { write(ad, a & x); };
    auto dcp = [&](uint16_t ad) { uint8_t m = read(ad) - 1; write(ad, m); cmpv(a, m); };
    auto isc = [&](uint16_t ad) { uint8_t m = read(ad) + 1; write(ad, m); adcv(~m); };
    auto slo = [&](uint16_t ad) { uint8_t m = read(ad); fC = m & 0x80; m <<= 1; write(ad, m); a |= m; setZN(a); };
    auto rla = [&](uint16_t ad) { uint8_t m = read(ad); bool c = fC; fC = m & 0x80; m = (m << 1) | c; write(ad, m); a &= m; setZN(a); };
    auto sre = [&](uint16_t ad) { uint8_t m = read(ad); fC = m & 1; m >>= 1; write(ad, m); a ^= m; setZN(a); };
    auto rra = [&](uint16_t ad) { uint8_t m = read(ad); bool c = fC; fC = m & 1; m = (m >> 1) | (c << 7); write(ad, m); adcv(m); };

    switch (op) {
    // LDA
    case 0xA9: lda(imm()); cycles = 2; break;
    case 0xA5: lda(zp());  cycles = 3; break;
    case 0xB5: lda(zpx()); cycles = 4; break;
    case 0xAD: lda(abs_()); cycles = 4; break;
    case 0xBD: lda(abx()); cycles = 4 + crossed; break;
    case 0xB9: lda(aby()); cycles = 4 + crossed; break;
    case 0xA1: lda(izx()); cycles = 6; break;
    case 0xB1: lda(izy()); cycles = 5 + crossed; break;
    // LDX
    case 0xA2: ldx(imm()); cycles = 2; break;
    case 0xA6: ldx(zp());  cycles = 3; break;
    case 0xB6: ldx(zpy()); cycles = 4; break;
    case 0xAE: ldx(abs_()); cycles = 4; break;
    case 0xBE: ldx(aby()); cycles = 4 + crossed; break;
    // LDY
    case 0xA0: ldy(imm()); cycles = 2; break;
    case 0xA4: ldy(zp());  cycles = 3; break;
    case 0xB4: ldy(zpx()); cycles = 4; break;
    case 0xAC: ldy(abs_()); cycles = 4; break;
    case 0xBC: ldy(abx()); cycles = 4 + crossed; break;
    // STA
    case 0x85: sta(zp());  cycles = 3; break;
    case 0x95: sta(zpx()); cycles = 4; break;
    case 0x8D: sta(abs_()); cycles = 4; break;
    case 0x9D: sta(abx()); cycles = 5; break;
    case 0x99: sta(aby()); cycles = 5; break;
    case 0x81: sta(izx()); cycles = 6; break;
    case 0x91: sta(izy()); cycles = 6; break;
    // STX/STY
    case 0x86: stx(zp());  cycles = 3; break;
    case 0x96: stx(zpy()); cycles = 4; break;
    case 0x8E: stx(abs_()); cycles = 4; break;
    case 0x84: sty(zp());  cycles = 3; break;
    case 0x94: sty(zpx()); cycles = 4; break;
    case 0x8C: sty(abs_()); cycles = 4; break;
    // transfers
    case 0xAA: x = a; setZN(x); cycles = 2; break;             // TAX
    case 0xA8: y = a; setZN(y); cycles = 2; break;             // TAY
    case 0x8A: a = x; setZN(a); cycles = 2; break;             // TXA
    case 0x98: a = y; setZN(a); cycles = 2; break;             // TYA
    case 0xBA: x = sp; setZN(x); cycles = 2; break;            // TSX
    case 0x9A: sp = x; cycles = 2; break;                      // TXS
    // stack
    case 0x48: push(a); cycles = 3; break;                     // PHA
    case 0x68: a = pop(); setZN(a); cycles = 4; break;         // PLA
    case 0x08: push(status(true)); cycles = 3; break;          // PHP
    case 0x28: setStatus(pop()); cycles = 4; break;            // PLP
    // ADC/SBC
    case 0x69: adc(imm()); cycles = 2; break;
    case 0x65: adc(zp());  cycles = 3; break;
    case 0x75: adc(zpx()); cycles = 4; break;
    case 0x6D: adc(abs_()); cycles = 4; break;
    case 0x7D: adc(abx()); cycles = 4 + crossed; break;
    case 0x79: adc(aby()); cycles = 4 + crossed; break;
    case 0x61: adc(izx()); cycles = 6; break;
    case 0x71: adc(izy()); cycles = 5 + crossed; break;
    case 0xE9: case 0xEB: sbc(imm()); cycles = 2; break;
    case 0xE5: sbc(zp());  cycles = 3; break;
    case 0xF5: sbc(zpx()); cycles = 4; break;
    case 0xED: sbc(abs_()); cycles = 4; break;
    case 0xFD: sbc(abx()); cycles = 4 + crossed; break;
    case 0xF9: sbc(aby()); cycles = 4 + crossed; break;
    case 0xE1: sbc(izx()); cycles = 6; break;
    case 0xF1: sbc(izy()); cycles = 5 + crossed; break;
    // AND/ORA/EOR
    case 0x29: and_(imm()); cycles = 2; break;
    case 0x25: and_(zp());  cycles = 3; break;
    case 0x35: and_(zpx()); cycles = 4; break;
    case 0x2D: and_(abs_()); cycles = 4; break;
    case 0x3D: and_(abx()); cycles = 4 + crossed; break;
    case 0x39: and_(aby()); cycles = 4 + crossed; break;
    case 0x21: and_(izx()); cycles = 6; break;
    case 0x31: and_(izy()); cycles = 5 + crossed; break;
    case 0x09: ora(imm()); cycles = 2; break;
    case 0x05: ora(zp());  cycles = 3; break;
    case 0x15: ora(zpx()); cycles = 4; break;
    case 0x0D: ora(abs_()); cycles = 4; break;
    case 0x1D: ora(abx()); cycles = 4 + crossed; break;
    case 0x19: ora(aby()); cycles = 4 + crossed; break;
    case 0x01: ora(izx()); cycles = 6; break;
    case 0x11: ora(izy()); cycles = 5 + crossed; break;
    case 0x49: eor(imm()); cycles = 2; break;
    case 0x45: eor(zp());  cycles = 3; break;
    case 0x55: eor(zpx()); cycles = 4; break;
    case 0x4D: eor(abs_()); cycles = 4; break;
    case 0x5D: eor(abx()); cycles = 4 + crossed; break;
    case 0x59: eor(aby()); cycles = 4 + crossed; break;
    case 0x41: eor(izx()); cycles = 6; break;
    case 0x51: eor(izy()); cycles = 5 + crossed; break;
    // CMP/CPX/CPY
    case 0xC9: cmp(imm()); cycles = 2; break;
    case 0xC5: cmp(zp());  cycles = 3; break;
    case 0xD5: cmp(zpx()); cycles = 4; break;
    case 0xCD: cmp(abs_()); cycles = 4; break;
    case 0xDD: cmp(abx()); cycles = 4 + crossed; break;
    case 0xD9: cmp(aby()); cycles = 4 + crossed; break;
    case 0xC1: cmp(izx()); cycles = 6; break;
    case 0xD1: cmp(izy()); cycles = 5 + crossed; break;
    case 0xE0: cpx_(imm()); cycles = 2; break;
    case 0xE4: cpx_(zp());  cycles = 3; break;
    case 0xEC: cpx_(abs_()); cycles = 4; break;
    case 0xC0: cpy_(imm()); cycles = 2; break;
    case 0xC4: cpy_(zp());  cycles = 3; break;
    case 0xCC: cpy_(abs_()); cycles = 4; break;
    // BIT
    case 0x24: bit(zp()); cycles = 3; break;
    case 0x2C: bit(abs_()); cycles = 4; break;
    // shifts (accumulator)
    case 0x0A: a = aslv(a); cycles = 2; break;
    case 0x4A: a = lsrv(a); cycles = 2; break;
    case 0x2A: a = rolv(a); cycles = 2; break;
    case 0x6A: a = rorv(a); cycles = 2; break;
    // shifts (memory)
    case 0x06: asl(zp());  cycles = 5; break;
    case 0x16: asl(zpx()); cycles = 6; break;
    case 0x0E: asl(abs_()); cycles = 6; break;
    case 0x1E: asl(abx()); cycles = 7; break;
    case 0x46: lsr(zp());  cycles = 5; break;
    case 0x56: lsr(zpx()); cycles = 6; break;
    case 0x4E: lsr(abs_()); cycles = 6; break;
    case 0x5E: lsr(abx()); cycles = 7; break;
    case 0x26: rol(zp());  cycles = 5; break;
    case 0x36: rol(zpx()); cycles = 6; break;
    case 0x2E: rol(abs_()); cycles = 6; break;
    case 0x3E: rol(abx()); cycles = 7; break;
    case 0x66: ror(zp());  cycles = 5; break;
    case 0x76: ror(zpx()); cycles = 6; break;
    case 0x6E: ror(abs_()); cycles = 6; break;
    case 0x7E: ror(abx()); cycles = 7; break;
    // INC/DEC
    case 0xE6: inc(zp());  cycles = 5; break;
    case 0xF6: inc(zpx()); cycles = 6; break;
    case 0xEE: inc(abs_()); cycles = 6; break;
    case 0xFE: inc(abx()); cycles = 7; break;
    case 0xC6: dec(zp());  cycles = 5; break;
    case 0xD6: dec(zpx()); cycles = 6; break;
    case 0xCE: dec(abs_()); cycles = 6; break;
    case 0xDE: dec(abx()); cycles = 7; break;
    case 0xE8: x++; setZN(x); cycles = 2; break;               // INX
    case 0xC8: y++; setZN(y); cycles = 2; break;               // INY
    case 0xCA: x--; setZN(x); cycles = 2; break;               // DEX
    case 0x88: y--; setZN(y); cycles = 2; break;               // DEY
    // jumps
    case 0x4C: pc = read16(pc); cycles = 3; break;             // JMP abs
    case 0x6C: {                                               // JMP (ind) with page-wrap bug
        uint16_t p = read16(pc);
        uint16_t lo = read(p);
        uint16_t hi = read((p & 0xFF00) | ((p + 1) & 0xFF));
        pc = lo | (hi << 8);
        cycles = 5; break;
    }
    case 0x20: {                                               // JSR
        uint16_t target = read16(pc);
        uint16_t ret = pc + 1;
        push(ret >> 8); push(ret & 0xFF);
        pc = target;
        cycles = 6; break;
    }
    case 0x60: pc = (pop() | (pop() << 8)) + 1; cycles = 6; break;      // RTS
    case 0x40: setStatus(pop()); pc = pop() | (pop() << 8); cycles = 6; break; // RTI
    case 0x00: {                                               // BRK
        pc++;
        push(pc >> 8); push(pc & 0xFF);
        push(status(true));
        fI = true;
        pc = read16(0xFFFE);
        cycles = 7; break;
    }
    // branches
    case 0x90: cycles = 2; branch(!fC, cycles); break;         // BCC
    case 0xB0: cycles = 2; branch(fC, cycles); break;          // BCS
    case 0xD0: cycles = 2; branch(!fZ, cycles); break;         // BNE
    case 0xF0: cycles = 2; branch(fZ, cycles); break;          // BEQ
    case 0x10: cycles = 2; branch(!fN, cycles); break;         // BPL
    case 0x30: cycles = 2; branch(fN, cycles); break;          // BMI
    case 0x50: cycles = 2; branch(!fV, cycles); break;         // BVC
    case 0x70: cycles = 2; branch(fV, cycles); break;          // BVS
    // flags
    case 0x18: fC = false; cycles = 2; break;                  // CLC
    case 0x38: fC = true; cycles = 2; break;                   // SEC
    case 0x58: fI = false; cycles = 2; break;                  // CLI
    case 0x78: fI = true; cycles = 2; break;                   // SEI
    case 0xB8: fV = false; cycles = 2; break;                  // CLV
    case 0xD8: fD = false; cycles = 2; break;                  // CLD
    case 0xF8: fD = true; cycles = 2; break;                   // SED
    // NOPs (official + unofficial)
    case 0xEA: case 0x1A: case 0x3A: case 0x5A: case 0x7A: case 0xDA: case 0xFA:
        cycles = 2; break;
    case 0x80: case 0x82: case 0x89: case 0xC2: case 0xE2:
        pc++; cycles = 2; break;                               // NOP imm
    case 0x04: case 0x44: case 0x64: pc++; cycles = 3; break;  // NOP zp
    case 0x14: case 0x34: case 0x54: case 0x74: case 0xD4: case 0xF4:
        pc++; cycles = 4; break;                               // NOP zpx
    case 0x0C: pc += 2; cycles = 4; break;                     // NOP abs
    case 0x1C: case 0x3C: case 0x5C: case 0x7C: case 0xDC: case 0xFC:
        abx(); cycles = 4 + crossed; break;                    // NOP abx
    // unofficial: LAX
    case 0xA7: lax(zp());  cycles = 3; break;
    case 0xB7: lax(zpy()); cycles = 4; break;
    case 0xAF: lax(abs_()); cycles = 4; break;
    case 0xBF: lax(aby()); cycles = 4 + crossed; break;
    case 0xA3: lax(izx()); cycles = 6; break;
    case 0xB3: lax(izy()); cycles = 5 + crossed; break;
    // unofficial: SAX
    case 0x87: sax(zp());  cycles = 3; break;
    case 0x97: sax(zpy()); cycles = 4; break;
    case 0x8F: sax(abs_()); cycles = 4; break;
    case 0x83: sax(izx()); cycles = 6; break;
    // unofficial: DCP
    case 0xC7: dcp(zp());  cycles = 5; break;
    case 0xD7: dcp(zpx()); cycles = 6; break;
    case 0xCF: dcp(abs_()); cycles = 6; break;
    case 0xDF: dcp(abx()); cycles = 7; break;
    case 0xDB: dcp(aby()); cycles = 7; break;
    case 0xC3: dcp(izx()); cycles = 8; break;
    case 0xD3: dcp(izy()); cycles = 8; break;
    // unofficial: ISC
    case 0xE7: isc(zp());  cycles = 5; break;
    case 0xF7: isc(zpx()); cycles = 6; break;
    case 0xEF: isc(abs_()); cycles = 6; break;
    case 0xFF: isc(abx()); cycles = 7; break;
    case 0xFB: isc(aby()); cycles = 7; break;
    case 0xE3: isc(izx()); cycles = 8; break;
    case 0xF3: isc(izy()); cycles = 8; break;
    // unofficial: SLO
    case 0x07: slo(zp());  cycles = 5; break;
    case 0x17: slo(zpx()); cycles = 6; break;
    case 0x0F: slo(abs_()); cycles = 6; break;
    case 0x1F: slo(abx()); cycles = 7; break;
    case 0x1B: slo(aby()); cycles = 7; break;
    case 0x03: slo(izx()); cycles = 8; break;
    case 0x13: slo(izy()); cycles = 8; break;
    // unofficial: RLA
    case 0x27: rla(zp());  cycles = 5; break;
    case 0x37: rla(zpx()); cycles = 6; break;
    case 0x2F: rla(abs_()); cycles = 6; break;
    case 0x3F: rla(abx()); cycles = 7; break;
    case 0x3B: rla(aby()); cycles = 7; break;
    case 0x23: rla(izx()); cycles = 8; break;
    case 0x33: rla(izy()); cycles = 8; break;
    // unofficial: SRE
    case 0x47: sre(zp());  cycles = 5; break;
    case 0x57: sre(zpx()); cycles = 6; break;
    case 0x4F: sre(abs_()); cycles = 6; break;
    case 0x5F: sre(abx()); cycles = 7; break;
    case 0x5B: sre(aby()); cycles = 7; break;
    case 0x43: sre(izx()); cycles = 8; break;
    case 0x53: sre(izy()); cycles = 8; break;
    // unofficial: RRA
    case 0x67: rra(zp());  cycles = 5; break;
    case 0x77: rra(zpx()); cycles = 6; break;
    case 0x6F: rra(abs_()); cycles = 6; break;
    case 0x7F: rra(abx()); cycles = 7; break;
    case 0x7B: rra(aby()); cycles = 7; break;
    case 0x63: rra(izx()); cycles = 8; break;
    case 0x73: rra(izy()); cycles = 8; break;
    // unofficial: ANC/ALR/ARR/AXS
    case 0x0B: case 0x2B: a &= read(imm()); setZN(a); fC = fN; cycles = 2; break;   // ANC
    case 0x4B: a &= read(imm()); a = lsrv(a); cycles = 2; break;                    // ALR
    case 0x6B: {                                                                    // ARR
        a &= read(imm());
        a = (a >> 1) | (fC << 7);
        setZN(a);
        fC = a & 0x40;
        fV = ((a >> 6) ^ (a >> 5)) & 1;
        cycles = 2; break;
    }
    case 0xCB: {                                                                    // AXS
        uint8_t m = read(imm());
        int r = (a & x) - m;
        fC = r >= 0;
        x = (uint8_t)r; setZN(x);
        cycles = 2; break;
    }
    default:
        cycles = 2; break;  // treat unknown as NOP
    }

    return cycles;
}

} // namespace nes
