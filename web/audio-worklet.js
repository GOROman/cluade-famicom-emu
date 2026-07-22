// Ring-buffer playback of APU samples sent from the main thread.
class NesAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 16384;
    this.ring = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.lastSample = 0;
    this.port.onmessage = (e) => {
      const samples = e.data;
      for (let i = 0; i < samples.length; i++) {
        if (this.available >= this.capacity) break; // drop on overflow
        this.ring[this.writePos] = samples[i];
        this.writePos = (this.writePos + 1) % this.capacity;
        this.available++;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.available > 0) {
        this.lastSample = this.ring[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available--;
      }
      out[i] = this.lastSample; // hold last sample on underrun
    }
    return true;
  }
}
registerProcessor('nes-audio', NesAudioProcessor);
