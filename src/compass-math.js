// Compass math (spec section 7.1). Pure functions, no Three.js.
import { gridAzimuth, gridToMagnetic, normalizeDeg } from './coords.js';

export const BEZEL_CLICK_DEG = 3; // a lensatic bezel has 120 clicks

const DEG = 180 / Math.PI;

// Heading of the compass's sighting axis, projected to horizontal.
//   forward: world direction of the sighting axis (any length)
//   up:      world direction of the compass face normal (any length)
// Returns grid and magnetic azimuths in degrees (null when the axis is vertical)
// and the tilt of the face from level, in degrees.
export function compassHeading(forward, up, gmAngleDeg) {
  const ul = Math.hypot(up.x, up.y, up.z) || 1;
  const tilt = Math.acos(Math.min(1, Math.max(-1, up.y / ul))) * DEG;
  if (Math.hypot(forward.x, forward.z) < 1e-6) return { grid: null, magnetic: null, tilt };
  const grid = gridAzimuth(forward.x, forward.z);
  return { grid, magnetic: gridToMagnetic(grid, gmAngleDeg), tilt };
}

// Signed shortest rotation from a to b, in degrees, in (-180, 180].
export function angleDelta(a, b) {
  const d = normalizeDeg(b - a);
  return d > 180 ? d - 360 : d;
}

// The floating dial: a damped spring toward the magnetic heading, so it swings and
// settles like a real card instead of snapping. Angles are degrees; the state is
// unwrapped so the spring never takes the long way round.
export class DialDamper {
  constructor(frequency = 9, damping = 0.6) {
    this.w = frequency; // rad/s
    this.zeta = damping;
    this.angle = null;
    this.velocity = 0;
  }

  update(target, dt) {
    if (this.angle === null) {
      this.angle = target;
      return this.reading;
    }
    const goal = this.angle + angleDelta(this.angle, target);
    // Substep so a slow frame can't make the spring explode.
    const steps = Math.max(1, Math.ceil(dt / 0.01));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acc = this.w * this.w * (goal - this.angle) - 2 * this.zeta * this.w * this.velocity;
      this.velocity += acc * h;
      this.angle += this.velocity * h;
    }
    return this.reading;
  }

  get reading() {
    return this.angle === null ? null : normalizeDeg(this.angle);
  }
}
