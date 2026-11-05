/**
 * CareSpeak VoiceLink microphone capture worklet.
 *
 * Receives the browser's native-rate mono stream, linearly resamples it to
 * 16 kHz, converts to signed 16-bit PCM and posts ~20 ms frames. Everything is
 * local to this device; the worklet makes no network requests.
 */
class VoiceLinkCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    this.targetRate = Number(processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.inputRemainder = new Float32Array(0);
    this.position = 0;
    this.frameSamples = Math.max(160, Math.round(this.targetRate * 0.02));
    this.frame = new Int16Array(this.frameSamples);
    this.frameIndex = 0;
    this.active = true;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "active") {
        this.active = Boolean(event.data.value);
        if (!this.active) {
          this.frameIndex = 0;
        }
      }
    };
  }

  flush() {
    if (this.frameIndex === 0) return;
    const pcm = this.frame.slice(0, this.frameIndex);
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.frameIndex = 0;
  }

  write(sample) {
    const value = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    this.frame[this.frameIndex] = value < 0 ? value * 0x8000 : value * 0x7fff;
    this.frameIndex += 1;
    if (this.frameIndex >= this.frameSamples) {
      const pcm = this.frame.slice();
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
      this.frameIndex = 0;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (output) output.fill(0);
    if (!this.active) return true;

    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    let buffer;
    if (this.inputRemainder.length === 0) {
      buffer = input;
    } else {
      buffer = new Float32Array(this.inputRemainder.length + input.length);
      buffer.set(this.inputRemainder, 0);
      buffer.set(input, this.inputRemainder.length);
    }

    let position = this.position;
    while (position + 1 < buffer.length) {
      const lower = Math.floor(position);
      const fraction = position - lower;
      this.write(
        buffer[lower] * (1 - fraction) + buffer[lower + 1] * fraction,
      );
      position += this.ratio;
    }

    const consumed = Math.floor(position);
    if (consumed > 0) {
      this.inputRemainder = buffer.slice(consumed);
      this.position = position - consumed;
    } else {
      this.inputRemainder = buffer;
      this.position = position;
    }

    return true;
  }
}

registerProcessor("voicelink-capture", VoiceLinkCaptureProcessor);
