// Ranger pace beads (spec section 7.3). Pure state, no Three.js.
// 9 lower beads count 100 m each; on the 10th slide they all go back and one of the
// 4 upper (1 km) beads slides. After 4 km plus 900 m the next slide resets everything.

export class BeadCounter {
  constructor() {
    this.lower = 0;
    this.upper = 0;
    this.log = [];
  }

  // t: seconds into the run. pos: true position { x, z }, logged for the AAR only.
  slide(t, pos) {
    this.lower++;
    if (this.lower === 10) {
      this.lower = 0;
      this.upper = (this.upper + 1) % 5;
    }
    this.log.push({ t, x: pos.x, z: pos.z, action: 'slide', lower: this.lower, upper: this.upper });
  }

  reset(t, pos) {
    this.lower = 0;
    this.upper = 0;
    this.log.push({ t, x: pos.x, z: pos.z, action: 'reset', lower: 0, upper: 0 });
  }

  // Distance the beads claim.
  get metres() {
    return this.upper * 1000 + this.lower * 100;
  }
}
