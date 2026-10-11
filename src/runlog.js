// What happens during a run, for the after-action review (spec section 9).
// Pure state, no Three.js. Times are seconds of course time.

export class RunLog {
  constructor() {
    this.track = [];           // { t, x, z } about once a second
    this.events = [];          // { t, type, ...data }
    this.intervals = { map: [], compass: [] }; // [start, end] while each tool was out
    this._open = {};
  }

  sample(t, x, z, every = 1) {
    const last = this.track[this.track.length - 1];
    if (!last || t - last.t >= every) this.track.push({ t, x, z });
  }

  tool(name, out, t) {
    const open = this._open[name];
    if (out && open === undefined) this._open[name] = t;
    if (!out && open !== undefined) {
      this.intervals[name].push([open, t]);
      delete this._open[name];
    }
  }

  event(type, t, data = {}) {
    this.events.push({ t, type, ...data });
  }

  // Close anything still open and take a last sample.
  finish(t, x, z) {
    for (const name of Object.keys(this._open)) this.tool(name, false, t);
    const last = this.track[this.track.length - 1];
    if (!last || last.t !== t) this.track.push({ t, x, z });
  }

  distance() {
    let d = 0;
    for (let i = 1; i < this.track.length; i++) {
      d += Math.hypot(this.track[i].x - this.track[i - 1].x, this.track[i].z - this.track[i - 1].z);
    }
    return d;
  }

  toJSON() {
    return { track: this.track, events: this.events, intervals: this.intervals };
  }
}
