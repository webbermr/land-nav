// Movement, footfalls and slope effects (spec section 6). No Three.js, so it can be
// unit tested. The caller supplies a ground object with slopeAt(x, z, dx, dz) and size.
//
// A pace is two steps. The user counts every time the left foot lands.

export function paceLength(settings) {
  return 100 / settings.paceCountPer100m;
}

// Tobler's hiking function, normalized so flat ground gives 1.
// grade is rise over run in the direction of travel, positive uphill.
export function toblerFactor(grade, k = 3.5, offset = 0.05) {
  return Math.exp(-k * Math.abs(grade + offset)) / Math.exp(-k * offset);
}

// Stride shortens on slopes. Tuning values for training feel, not a validated model.
export function strideFactor(grade, settings) {
  const f = 1 - settings.strideUphill * Math.max(grade, 0) - settings.strideDownhill * Math.max(-grade, 0);
  return Math.min(1, Math.max(settings.strideMin, f));
}

// Fires a footfall every half pace of distance covered. Feet alternate starting with
// the right, so the left lands at each full pace: 100 m at 65 paces per 100 m gives
// 65 left footfalls.
export class PaceCounter {
  constructor() {
    this.reset();
  }

  reset() {
    this.steps = 0;        // footfalls so far, both feet
    this.progress = 0;     // in half-paces (steps), fractional
    this.distance = 0;     // horizontal metres covered
  }

  get leftCount() {
    return Math.floor(this.steps / 2);
  }

  // Advance by `dist` metres with the current step length. Returns the feet that
  // landed, in order ('left' | 'right').
  advance(dist, stepLength) {
    const feet = [];
    if (!(dist > 0) || !(stepLength > 0)) return feet;
    this.distance += dist;
    this.progress += dist / stepLength;
    // The epsilon (a millionth of a step) absorbs float drift so exactly 100 m
    // lands the 65th pace.
    while (this.steps + 1 <= this.progress + 1e-6) {
      this.steps++;
      feet.push(this.steps % 2 === 0 ? 'left' : 'right');
    }
    return feet;
  }
}

export class Locomotion {
  constructor(settings) {
    this.settings = settings;
    this.pace = new PaceCounter();
    this.lastGrade = 0;
    this.lastSpeed = 0;
  }

  // One frame of stick (or key) movement.
  //   x, z        current horizontal position (scene metres)
  //   dirX, dirZ  desired direction of travel, any length
  //   throttle    0..1 stick deflection
  // Returns the horizontal displacement to apply and the footfalls it produced.
  step(dt, ground, x, z, dirX, dirZ, throttle = 1) {
    const s = this.settings;
    const len = Math.hypot(dirX, dirZ);
    const t = Math.min(1, Math.max(0, throttle));
    if (len < 1e-6 || t === 0 || !(dt > 0)) {
      this.lastSpeed = 0;
      return { dx: 0, dz: 0, feet: [] };
    }
    const ux = dirX / len;
    const uz = dirZ / len;

    let speed = s.baseSpeed * s.timeScale * t;
    let stride = 1;
    let grade = 0;
    if (s.slopeEffects) {
      grade = ground.slopeAt(x, z, ux, uz);
      speed *= toblerFactor(grade, s.toblerK, s.toblerOffset);
      stride = strideFactor(grade, s);
    }

    const d = speed * dt;
    const size = ground.size;
    const nx = Math.min(size, Math.max(0, x + ux * d));
    const nz = Math.min(size, Math.max(0, z + uz * d));
    const dx = nx - x;
    const dz = nz - z;
    // Only distance actually covered counts, so pushing into the boundary is silent.
    const feet = this.pace.advance(Math.hypot(dx, dz), (paceLength(s) / 2) * stride);

    this.lastGrade = grade;
    this.lastSpeed = Math.hypot(dx, dz) / dt;
    return { dx, dz, feet };
  }
}
