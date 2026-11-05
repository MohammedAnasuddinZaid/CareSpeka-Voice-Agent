/**
 * CareSpeak Web Voice Call — capture worklet.
 *
 * Receives a mono MediaStream (the patient's WebRTC audio), linearly resamples
 * it to 16 kHz, and posts 80 ms Float32 frames for voice-activity detection and
 * on-device speech recognition. It makes no network requests.
 */
class CareCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = Number(o.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.frameSamples = Math.round(this.targetRate * 0.08); // 80 ms
    this.frame = new Float32Array(this.frameSamples);
    this.frameIndex = 0;
    this.remainder = new Float32Array(0);
    this.position = 0;
    this.active = true;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "active") {
        this.active = Boolean(event.data.value);
        if (!this.active) this.frameIndex = 0;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (out) out.fill(0);
    if (!this.active) return true;

    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    let buffer;
    if (this.remainder.length === 0) {
      buffer = input;
    } else {
      buffer = new Float32Array(this.remainder.length + input.length);
      buffer.set(this.remainder, 0);
      buffer.set(input, this.remainder.length);
    }

    let p = this.position;
    while (p + 1 < buffer.length) {
      const lo = Math.floor(p);
      const f = p - lo;
      this.frame[this.frameIndex++] = buffer[lo] * (1 - f) + buffer[lo + 1] * f;
      if (this.frameIndex >= this.frameSamples) {
        const copy = this.frame.slice();
        this.port.postMessage(copy.buffer, [copy.buffer]);
        this.frameIndex = 0;
      }
      p += this.ratio;
    }

    const consumed = Math.floor(p);
    if (consumed > 0) {
      this.remainder = buffer.slice(consumed);
      this.position = p - consumed;
    } else {
      this.remainder = buffer;
      this.position = p;
    }
    return true;
  }
}

registerProcessor("care-capture", CareCaptureProcessor);
