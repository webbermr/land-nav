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

  // How each surface sounds underfoot: filter, centre frequency, length (s), level.
  // Hard surfaces click, litter crunches, grass and snow are soft.
  static SURFACES = {
    road: { type: 'bandpass', f: 1900, q: 1.2, len: 0.07, vol: 0.9 },
    parking: { type: 'bandpass', f: 1900, q: 1.2, len: 0.07, vol: 0.9 },
    track: { type: 'bandpass', f: 1400, q: 0.8, len: 0.11, vol: 1 },
    trail: { type: 'lowpass', f: 1000, q: 0.7, len: 0.12, vol: 0.9 },
    litter: { type: 'bandpass', f: 2600, q: 0.6, len: 0.14, vol: 0.85 },
    grass: { type: 'lowpass', f: 750, q: 0.7, len: 0.13, vol: 0.8 },
    snow: { type: 'bandpass', f: 1100, q: 1.6, len: 0.2, vol: 0.9 },
    stream: { type: 'highpass', f: 900, q: 0.5, len: 0.25, vol: 1 },
    mud: { type: 'lowpass', f: 500, q: 1.4, len: 0.18, vol: 0.9 },
  };

  // foot: 'left' | 'right'. haptics: optional (foot) => void for the XR controller.
  // surface: a key of SURFACES (default grass).
  play(foot, haptics, surface = 'grass') {
    const left = foot === 'left';
    if (left) haptics?.('left', this.settings.hapticStrength, this.settings.hapticMs);
    const sf = Footfalls.SURFACES[surface] || Footfalls.SURFACES.grass;
    const vol = this.settings.footfallVolume * (left ? 1 : 0.55) * sf.vol;
    if (!this.ctx || vol <= 0 || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    // A different slice of noise each time so steps don't sound identical.
    const offset = Math.random() * 0.05;
    const filter = this.ctx.createBiquadFilter();
    filter.type = sf.type;
    filter.frequency.value = sf.f * (left ? 0.92 : 1.08) * (0.85 + Math.random() * 0.3);
    filter.Q.value = sf.q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + sf.len);
    src.connect(filter).connect(gain).connect(this.ctx.destination);
    src.start(t, offset, sf.len + 0.02);
  }
}
