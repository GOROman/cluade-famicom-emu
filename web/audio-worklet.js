// Ring-buffer playback of APU samples sent from the main thread.
class NesAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 16384;          // frames (L,R pairs)
    this.ring = new Float32Array(this.capacity * 2);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.port.onmessage = (e) => {
      const s = e.data;                 // interleaved L,R
      const frames = s.length >> 1;
      for (let i = 0; i < frames; i++) {
        if (this.available >= this.capacity) break; // drop on overflow
        this.ring[this.writePos * 2] = s[i * 2];
        this.ring[this.writePos * 2 + 1] = s[i * 2 + 1];
        this.writePos = (this.writePos + 1) % this.capacity;
        this.available++;
      }
    };
  }
  process(inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outL;
    for (let i = 0; i < outL.length; i++) {
      if (this.available > 0) {
        this.lastL = this.ring[this.readPos * 2];
        this.lastR = this.ring[this.readPos * 2 + 1];
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available--;
      }
      outL[i] = this.lastL;   // hold last sample on underrun
      outR[i] = this.lastR;
    }
    return true;
  }
}
registerProcessor('nes-audio', NesAudioProcessor);
