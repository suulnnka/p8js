// AudioWorklet consumer for the p8js mixer. The main thread renders PCM
// (fake-08 style: one fill per host frame) and posts Float32 blocks here;
// this processor just drains a small queue — underruns play silence.
class P8Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} */
    this.q = [];
    this.cur = new Float32Array(0);
    this.readPos = 0;
    this.underruns = 0;
    this.port.onmessage = (e) => {
      this.q.push(e.data);
      // keep at most ~6 blocks (~0.1s) of backlog
      if (this.q.length > 6) this.q.splice(0, this.q.length - 6);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let i = 0;
    while (i < out.length) {
      if (this.readPos >= this.cur.length) {
        if (this.q.length === 0) {
          out.fill(0, i);
          this.underruns++;
          break;
        }
        this.cur = this.q.shift();
        this.readPos = 0;
      }
      const n = Math.min(out.length - i, this.cur.length - this.readPos);
      out.set(this.cur.subarray(this.readPos, this.readPos + n), i);
      i += n;
      this.readPos += n;
    }
    return true;
  }
}

registerProcessor("p8-processor", P8Processor);
