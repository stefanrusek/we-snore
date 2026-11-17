// Mic capture: decimates to ~16 kHz mono and ships 128 ms chunks to the main thread.
class Cap extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.D = o.processorOptions.D; this.out = new Float32Array(2048); this.n = 0; this.acc = 0; this.c = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      if (++this.c === this.D) {
        this.out[this.n++] = this.acc / this.D; this.acc = 0; this.c = 0;
        if (this.n === this.out.length) { this.port.postMessage(this.out.slice()); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('cap', Cap);
