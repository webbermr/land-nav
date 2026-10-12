// The sound of the place, made on the fly with Web Audio (no recordings to
// download): wind, leaves moving, birds by day, crickets and the odd owl at night,
// running water near streams, and rain. Birds, insects and water are placed in
// 3-D around you, so in a headset you can turn toward them.
//
// It shares the footsteps' AudioContext, which the browser only allows after a
// click, a key or Enter VR.

const rand = (a, b) => a + Math.random() * (b - a);

// What the world is like right now, from main.js each frame.
// { head: {x,y,z}, fwd: {x,y,z}, up: {x,y,z}, sunElev, windMs, cover 0..1,
//   heightAboveGround, stream: {x,z,d}|null, rainMmH, snowing, tempC, month 1..12,
//   thunder: bool }

export class Soundscape {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.nextBird = 0;
    this.nextOwl = 0;
    this.nextThunder = 0;
    this.gust = 0;
    this.gustTarget = 0;
    this.nextGust = 0;
  }

  // Build the audio graph once the context exists (after a user gesture).
  start(ctx) {
    if (this.ctx || !ctx) return;
    this.ctx = ctx;
    const sr = ctx.sampleRate;
    // Two seconds of noise, looped by every bed below with different filters.
    const len = sr * 2;
    this.noise = ctx.createBuffer(1, len, sr);
    const d = this.noise.getChannelData(0);
    // Brownish noise for wind and water (more low end than white noise).
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    this.white = ctx.createBuffer(1, len, sr);
    const w = this.white.getChannelData(0);
    for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.ambientVolume;
    this.master.connect(ctx.destination);

    this.wind = this.bed(this.noise, 'lowpass', 420, 0.6);
    this.leaves = this.bed(this.white, 'bandpass', 3200, 0.7);
    this.rain = this.bed(this.white, 'highpass', 1400, 0.5);
    this.rainBody = this.bed(this.noise, 'lowpass', 900, 0.5);
    // Water: two band-passed noises that wander, placed at the nearest stream.
    this.waterPan = this.panner(8, 1.2);
    this.waterPan.connect(this.master);
    this.water = [this.bed(this.white, 'bandpass', 900, 2.5, this.waterPan), this.bed(this.noise, 'bandpass', 450, 1.5, this.waterPan)];
    // Crickets: a few, each a steady tone switched on and off in chirps.
    this.crickets = [];
    for (let i = 0; i < 4; i++) {
      const pan = this.panner(4, 1.6);
      pan.connect(this.master);
      const osc = ctx.createOscillator();
      osc.frequency.value = rand(4000, 4700);
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(pan);
      osc.start();
      this.crickets.push({ pan, gain: g, next: 0, x: 0, z: 0, placed: false, rate: rand(0.6, 1.1) });
    }
  }

  // A looping filtered-noise bed whose loudness we ride with a gain node.
  bed(buffer, type, freq, q, dest = this.master) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0;
    src.playbackRate.value = rand(0.95, 1.05);
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(dest);
    src.start(0, Math.random() * 1.9);
    return { src, filter: f, gain: g };
  }

  panner(ref, rolloff) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = 400;
    return p;
  }

  setPos(p, x, y, z) {
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
    else p.setPosition(x, y, z);
  }

  // Ease a gain toward a level without clicks.
  ride(g, v, t = 0.4) {
    g.gain.setTargetAtTime(v, this.ctx.currentTime, t);
  }

  update(dt, w) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.ambientVolume, now, 0.2);
    this.listen(w);

    // Wind: gusts wander every few seconds. Louder up high and in the open.
    if (now > this.nextGust) {
      this.gustTarget = Math.random();
      this.nextGust = now + rand(2, 7);
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.6);
    const wind = Math.min(1.4, (w.windMs ?? 3) / 10);
    const exposed = 1 - 0.55 * (w.cover ?? 0) + Math.min(0.8, (w.heightAboveGround ?? 0) / 60);
    const windLevel = 0.04 + wind * (0.35 + 0.45 * this.gust) * exposed;
    this.ride(this.wind.gain, Math.min(0.9, windLevel));
    this.wind.filter.frequency.setTargetAtTime(260 + 500 * wind * this.gust, now, 0.5);
    // Leaves move with the wind where there are trees.
    const leafy = (w.cover ?? 0) * (w.leafOn ?? 1);
    this.ride(this.leaves.gain, leafy * wind * (0.05 + 0.13 * this.gust));

    // Rain on leaves and ground.
    const rain = w.snowing ? 0 : Math.min(1, (w.rainMmH ?? 0) / 8);
    this.ride(this.rain.gain, rain * 0.32, 1);
    this.ride(this.rainBody.gain, rain * 0.25, 1);

    // Water near a stream (the panner does the fading with distance).
    if (w.stream && w.stream.d < 80) {
      this.setPos(this.waterPan, w.stream.x, (w.head?.y ?? 0) - 1.5, w.stream.z);
      this.ride(this.water[0].gain, 0.22, 0.6);
      this.ride(this.water[1].gain, 0.3, 0.6);
      this.water[0].filter.frequency.setTargetAtTime(rand(700, 1400), now, 0.08);
      this.water[1].filter.frequency.setTargetAtTime(rand(300, 600), now, 0.15);
    } else {
      this.ride(this.water[0].gain, 0, 1);
      this.ride(this.water[1].gain, 0, 1);
    }

    const elev = w.sunElev ?? 30;
    const month = w.month ?? 6;
    const temp = w.tempC ?? (month >= 5 && month <= 9 ? 20 : 8);
    const calm = rain < 0.4 && wind < 1;

    // Birds: by day, most at dawn, few in winter or rain.
    const dawn = Math.exp(-(((elev - 4) / 9) ** 2));
    const season = month >= 4 && month <= 8 ? 1 : month === 3 || month === 9 || month === 10 ? 0.55 : 0.25;
    const birdRate = elev > -4 && calm ? season * (0.25 + 1.2 * dawn) * (0.3 + 0.7 * Math.max(0.2, w.cover ?? 0.5)) : 0;
    if (birdRate > 0 && now > this.nextBird) {
      this.bird(w);
      this.nextBird = now + rand(0.6, 5) / birdRate;
    }

    // Crickets on warm nights; an owl now and then.
    const night = elev < -6;
    const crickets = night && temp > 12 && calm && !w.snowing;
    for (const c of this.crickets) {
      if (!crickets) { this.ride(c.gain, 0, 0.5); c.placed = false; continue; }
      if (!c.placed || Math.hypot(c.x - w.head.x, c.z - w.head.z) > 45) {
        const a = rand(0, Math.PI * 2), r = rand(6, 30);
        c.x = w.head.x + Math.cos(a) * r; c.z = w.head.z + Math.sin(a) * r;
        this.setPos(c.pan, c.x, w.head.y - 1.6, c.z);
        c.placed = true;
        c.next = now + rand(0, 1);
      }
      if (now > c.next) {
        // Three quick pulses, then a pause.
        const g = c.gain.gain;
        for (let k = 0; k < 3; k++) {
          const t = now + k * 0.045;
          g.setValueAtTime(0, t);
          g.linearRampToValueAtTime(0.05, t + 0.006);
          g.linearRampToValueAtTime(0, t + 0.028);
        }
        c.next = now + c.rate * rand(0.85, 1.15);
      }
    }
    if (night && calm && now > this.nextOwl) {
      if (this.nextOwl) this.owl(w);
      this.nextOwl = now + rand(25, 90);
    }

    if (w.thunder && now > this.nextThunder) {
      if (this.nextThunder) this.thunder(rand(0.4, 1));
      this.nextThunder = now + rand(8, 30);
    }
  }

  listen(w) {
    const L = this.ctx.listener;
    const { head, fwd, up } = w;
    if (!head) return;
    if (L.positionX) {
      L.positionX.value = head.x; L.positionY.value = head.y; L.positionZ.value = head.z;
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
    } else {
      L.setPosition(head.x, head.y, head.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  // One bird call somewhere in the trees around you. A few kinds of song, all
  // whistled sine sweeps: down-slurred whistles, quick trills, two-note calls.
  bird(w) {
    const ctx = this.ctx;
    const a = rand(0, Math.PI * 2), r = rand(12, 70);
    const pan = this.panner(10, 1.1);
    this.setPos(pan, w.head.x + Math.cos(a) * r, w.head.y + rand(3, 14), w.head.z + Math.sin(a) * r);
    pan.connect(this.master);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0;
    osc.connect(g).connect(pan);
    const t0 = ctx.currentTime + 0.02;
    const vol = rand(0.05, 0.14);
    const kind = Math.floor(rand(0, 4));
    const f = rand(2400, 4800);
    let t = t0;
    const note = (f0, f1, dur, gap) => {
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + Math.min(0.02, dur / 3));
      g.gain.setValueAtTime(vol, t + dur * 0.7);
      g.gain.linearRampToValueAtTime(0, t + dur);
      t += dur + gap;
    };
    if (kind === 0) { // a clear down-slurred whistle, twice
      note(f * 1.3, f * 0.8, 0.28, 0.12); note(f * 1.25, f * 0.78, 0.26, 0);
    } else if (kind === 1) { // a quick trill
      const n = Math.floor(rand(6, 14));
      for (let i = 0; i < n; i++) note(f * 1.1, f * 0.9, 0.035, 0.025);
    } else if (kind === 2) { // two notes, high then low ("fee-bee")
      note(f * 1.15, f * 1.12, 0.3, 0.06); note(f * 0.85, f * 0.82, 0.35, 0);
    } else { // chips
      const n = Math.floor(rand(2, 5));
      for (let i = 0; i < n; i++) note(f * 1.4, f, 0.05, rand(0.08, 0.2));
    }
    osc.start(t0);
    osc.stop(t + 0.05);
    osc.onended = () => { osc.disconnect(); g.disconnect(); pan.disconnect(); };
  }

  // A barred owl's distant "who-cooks-for-you" stand-in: low soft hoots.
  owl(w) {
    const ctx = this.ctx;
    const a = rand(0, Math.PI * 2), r = rand(60, 160);
    const pan = this.panner(25, 1);
    this.setPos(pan, w.head.x + Math.cos(a) * r, w.head.y + 10, w.head.z + Math.sin(a) * r);
    pan.connect(this.master);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0;
    osc.connect(g).connect(pan);
    let t = ctx.currentTime + 0.05;
    const t0 = t;
    for (const [f, dur] of [[420, 0.22], [430, 0.22], [450, 0.3], [400, 0.5]]) {
      osc.frequency.setValueAtTime(f * 1.05, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.9, t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.05);
      g.gain.linearRampToValueAtTime(0, t + dur);
      t += dur + 0.12;
    }
    osc.start(t0);
    osc.stop(t + 0.1);
    osc.onended = () => { osc.disconnect(); g.disconnect(); pan.disconnect(); };
  }

  // Distant thunder: a low rumble that swells and rolls away. near: 0..1.
  thunder(near) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 120 + 200 * near;
    const g = ctx.createGain();
    const t = ctx.currentTime + 0.05;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * near, t + 0.15 + (1 - near) * 0.8);
    g.gain.exponentialRampToValueAtTime(0.25 * near + 0.01, t + 1.6);
    g.gain.linearRampToValueAtTime(0.5 * near, t + 2.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 5.6);
    src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
  }
}
