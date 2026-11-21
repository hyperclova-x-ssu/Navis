/* global AudioWorkletProcessor, registerProcessor, sampleRate */
class NavisPcmCapture extends AudioWorkletProcessor {
  samples = new Int16Array(sampleRate * 60);
  length = 0;
  audible = false;

  constructor() {
    super();
    this.port.onmessage = () => this.finish();
  }

  finish() {
    if (!this.samples) return;
    const samples = this.samples.subarray(0, this.length);
    this.samples = null;
    if (this.audible) this.port.postMessage(samples, [samples.buffer]);
    else this.port.postMessage(null);
  }

  process([channels]) {
    const mono = channels?.[0];
    if (!this.samples) return false;
    if (!mono) return true;
    const length = Math.min(mono.length, this.samples.length - this.length);
    for (let index = 0; index < length; index++) {
      const sample = Math.max(-1, Math.min(1, mono[index]));
      this.samples[this.length++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (Math.abs(sample) >= 0.0005) this.audible = true;
    }
    if (this.length === this.samples.length) this.finish();
    return this.samples !== null;
  }
}
registerProcessor('navis-pcm-capture', NavisPcmCapture);
