// 2本の読み出し位置を交互にフェードし、再生速度を変えずに音の高さを変える。
class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: "ratio",
      defaultValue: 1,
      minValue: 0.25,
      maxValue: 4,
      automationRate: "k-rate",
    }];
  }

  constructor() {
    super();
    this.capacity = 16384;
    this.grain = 4096;
    this.buffers = [];
    this.write = 0;
    this.phase = 0;
  }

  ensureChannels(count) {
    if (this.buffers.length === count) return;
    this.buffers = Array.from({ length: count }, () => new Float32Array(this.capacity));
    this.write = 0;
    this.phase = 0;
  }

  sample(buffer, index) {
    const size = buffer.length;
    let position = index % size;
    if (position < 0) position += size;
    const left = Math.floor(position);
    const fraction = position - left;
    const right = (left + 1) % size;
    return buffer[left] * (1 - fraction) + buffer[right] * fraction;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.[0] || !output?.[0]) return true;
    const channels = Math.min(input.length, output.length);
    this.ensureChannels(channels);
    const frames = input[0].length;
    const ratio = parameters.ratio[0] || 1;
    if (Math.abs(ratio - 1) < 0.001) {
      for (let channel = 0; channel < channels; channel += 1) {
        output[channel].set(input[channel]);
      }
      return true;
    }

    const grain = this.grain;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        this.buffers[channel][this.write] = input[channel][frame];
      }
      const phase = this.phase;
      const other = (phase + 0.5) % 1;
      const gainA = Math.sin(Math.PI * phase);
      const gainB = Math.sin(Math.PI * other);
      for (let channel = 0; channel < channels; channel += 1) {
        const buffer = this.buffers[channel];
        const first = this.sample(buffer, this.write - phase * grain);
        const second = this.sample(buffer, this.write - other * grain);
        output[channel][frame] = first * gainA + second * gainB;
      }
      this.write = (this.write + 1) % this.capacity;
      this.phase += (1 - ratio) / grain;
      if (this.phase >= 1) this.phase -= 1;
      if (this.phase < 0) this.phase += 1;
    }
    return true;
  }
}

registerProcessor("pitch-processor", PitchProcessor);
