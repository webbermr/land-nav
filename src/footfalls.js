// Footfall feedback: a short synthesized footstep for each foot, louder on the left,
// and a haptic pulse on the left controller (spec section 6). The left pulse is what
// the user counts.

export class Footfalls {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.noise = null;
  }

  // Browsers only allow audio after a user gesture. Call from a click or Enter VR.
  unlock() {
    try {
      if (!this.ctx) {
        const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const len = Math.floor(this.ctx.sampleRate * 0.25);
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  // foot: 'left' | 'right'. haptics: optional (foot) => void for the XR controller.
  play(foot, haptics) {
    const left = foot === 'left';
    if (left) haptics?.('left', this.settings.hapticStrength, this.settings.hapticMs);
    const vol = this.settings.footfallVolume * (left ? 1 : 0.55);
    if (!this.ctx || vol <= 0 || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    // A different slice of noise each time so steps don't sound identical.
    const offset = Math.random() * 0.15;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = (left ? 700 : 850) + Math.random() * 250;
    filter.Q.value = 0.7;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    src.connect(filter).connect(gain).connect(this.ctx.destination);
    src.start(t, offset, 0.15);
  }
}
