// Weather for the site: live (Open-Meteo, falling back to the National Weather
// Service), a replayed day (Open-Meteo's historical archive), or one you pick.
// Both services are free, need no key and allow browser requests. Then the
// drawing: rain and snow around you, and lightning.
import * as THREE from 'three';
import {
  presetWeather, fromOpenMeteoCurrent, fromOpenMeteoHourly, fromNwsObservation, hourlyAt,
} from './weather-logic.js';

const LIVE_REFRESH_MS = 10 * 60 * 1000;
const OM_VARS = 'temperature_2m,relative_humidity_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,snow_depth';

async function getJson(url, ms = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class WeatherService {
  constructor(site) {
    this.site = site;
    this.mode = null;
    this.current = presetWeather('clear');
    this.status = '';
    this.offsetMin = null; // the site's UTC offset as the weather service reports it
    this.hours = null;     // a replayed day, hourly
    this.day = '';
    this.fetchedAt = 0;
    this.pending = null;
    this.error = '';
  }

  // mode: 'live' | 'replay' | a preset name. date: 'YYYY-MM-DD' for replay.
  // minuteOfDay: the local clock, for replay. Returns the weather now; starts a
  // fetch when one is needed (the weather changes when it arrives).
  get(mode, { date = '', minuteOfDay = 720 } = {}) {
    if (mode !== this.mode) { this.mode = mode; this.fetchedAt = 0; this.error = ''; }
    if (mode === 'live') {
      if (!this.pending && Date.now() - this.fetchedAt > LIVE_REFRESH_MS) this.pending = this.fetchLive().finally(() => { this.pending = null; });
      return this.current;
    }
    if (mode === 'replay') {
      if (date !== this.day && !this.pending) { this.day = date; this.hours = null; this.pending = this.fetchDay(date).finally(() => { this.pending = null; }); }
      if (this.hours?.length) this.current = hourlyAt(this.hours, minuteOfDay);
      return this.current;
    }
    this.current = presetWeather(mode);
    this.status = this.current.label;
    return this.current;
  }

  lat() { return this.site.center_lat.toFixed(4); }
  lon() { return this.site.center_lon.toFixed(4); }

  async fetchLive() {
    this.status = 'Getting the weather ...';
    try {
      const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${this.lat()}&longitude=${this.lon()}`
        + `&current=${OM_VARS},visibility&wind_speed_unit=ms&timezone=auto`);
      const w = fromOpenMeteoCurrent(j);
      if (!w) throw new Error('no current weather');
      if (Number.isFinite(j.utc_offset_seconds)) this.offsetMin = j.utc_offset_seconds / 60;
      this.set(w, 'Open-Meteo');
    } catch (err) {
      // US fallback: the nearest NWS station's latest observation.
      try {
        const pt = await getJson(`https://api.weather.gov/points/${this.lat()},${this.lon()}`);
        const st = await getJson(pt.properties.observationStations);
        const id = st.features?.[0]?.properties?.stationIdentifier;
        if (!id) throw new Error('no station');
        const w = fromNwsObservation(await getJson(`https://api.weather.gov/stations/${id}/observations/latest`));
        if (!w) throw new Error('no observation');
        this.set(w, `NWS ${id}`);
      } catch (err2) {
        this.fail(`Live weather unavailable (${err.message}; ${err2.message}). Showing clear skies.`);
      }
    }
    this.fetchedAt = Date.now();
  }

  // A whole day, hourly. ERA5 reanalysis for anything older than about a week;
  // the forecast service's recent past for the last few days.
  async fetchDay(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { this.fail('Pick a date to replay.'); return; }
    this.status = `Getting the weather for ${date} ...`;
    const ageDays = (Date.now() - Date.parse(`${date}T12:00:00Z`)) / 86400000;
    if (ageDays < -16) { this.fail(`${date} is too far ahead for a forecast.`); return; }
    const host = ageDays > 7 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
    const vars = ageDays > 7 ? OM_VARS : `${OM_VARS},visibility`;
    try {
      const j = await getJson(`${host}?latitude=${this.lat()}&longitude=${this.lon()}&start_date=${date}&end_date=${date}`
        + `&hourly=${vars}&wind_speed_unit=ms&timezone=auto`);
      const hours = fromOpenMeteoHourly(j);
      if (hours.length < 24) throw new Error('no hourly data for that day');
      if (Number.isFinite(j.utc_offset_seconds)) this.offsetMin = j.utc_offset_seconds / 60;
      if (this.day !== date) return; // the date changed while this was on its way
      this.hours = hours;
      this.status = `Open-Meteo ${ageDays > 7 ? 'archive (ERA5)' : 'recent'}: ${date}`;
      this.error = '';
    } catch (err) {
      this.fail(`No weather for ${date} (${err.message}). Showing clear skies.`);
    }
  }

  set(w, source) {
    this.current = w;
    this.status = `${w.label}, from ${source}`;
    this.error = '';
  }

  fail(message) {
    this.current = presetWeather('clear');
    this.status = message;
    this.error = message;
  }
}

// ---- Rain, snow and lightning ----

const RAIN_DROPS = 2600;
const SNOW_FLAKES = 3000;
const BOX = 36; // metres across, centred on you

// Drops live in a box that wraps around the viewer, animated in the vertex shader
// so the CPU does nothing per drop.
function precipMaterial(kind) {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      center: { value: new THREE.Vector3() },
      wind: { value: new THREE.Vector2() },
      amount: { value: 0 },
      fall: { value: kind === 'rain' ? 9 : 1.1 },
      color: { value: new THREE.Color(kind === 'rain' ? 0xaab4c0 : 0xffffff) },
      bright: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 seed; // x, y, z in 0..1, and which end of the streak
      uniform float time; uniform vec3 center; uniform vec2 wind; uniform float amount; uniform float fall;
      varying float vAlpha;
      const float BOX = ${BOX.toFixed(1)};
      void main() {
        float t = time * fall * (0.85 + 0.3 * fract(seed.x * 7.13));
        vec3 p = vec3(seed.x, seed.y, seed.z) * BOX;
        p.y -= t;
        p.xz += wind * (t / fall);
        ${kind === 'snow' ? 'p.x += sin(time * 0.9 + seed.y * 40.0) * 0.35; p.z += cos(time * 0.7 + seed.x * 40.0) * 0.35;' : ''}
        // Wrap into a box around the viewer.
        p = mod(p - center + BOX * 0.5, BOX) + center - BOX * 0.5;
        // A rain streak: the second end trails back along the drop's path.
        ${kind === 'rain' ? 'p -= seed.w * vec3(wind.x, -fall, wind.y) * 0.045;' : ''}
        vAlpha = step(fract(seed.x * 13.7 + seed.z * 3.1), amount);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        ${kind === 'snow' ? 'gl_PointSize = clamp(60.0 / -mv.z, 1.0, 6.0);' : ''}
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color; uniform float bright;
      varying float vAlpha;
      void main() {
        if (vAlpha < 0.5) discard;
        ${kind === 'snow' ? 'vec2 c = gl_PointCoord - 0.5; if (dot(c, c) > 0.25) discard;' : ''}
        gl_FragColor = vec4(color * bright, ${kind === 'rain' ? '0.45' : '0.9'});
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

function precipGeometry(count, ends) {
  const seed = new Float32Array(count * ends * 4);
  for (let i = 0; i < count; i++) {
    const x = Math.random(), y = Math.random(), z = Math.random();
    for (let e = 0; e < ends; e++) seed.set([x, y, z, e], (i * ends + e) * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * ends * 3), 3));
  return g;
}

export class WeatherVisuals {
  constructor(scene) {
    this.rainMat = precipMaterial('rain');
    this.rain = new THREE.LineSegments(precipGeometry(RAIN_DROPS, 2), this.rainMat);
    this.snowMat = precipMaterial('snow');
    this.snow = new THREE.Points(precipGeometry(SNOW_FLAKES, 1), this.snowMat);
    for (const m of [this.rain, this.snow]) {
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 5;
      scene.add(m);
    }
    this.rain.name = 'rain';
    this.snow.name = 'snow';
    this.time = 0;
    this.flash = 0;
    this.nextFlash = 0;
  }

  // fx: weatherEffects(); windTo: scene direction the wind blows toward (x, z),
  // m/s; light: daylight 0..1. onStrike(distanceM): lightning struck (for thunder).
  update(dt, head, fx, windTo, light, thunder, onStrike) {
    this.time += dt;
    for (const [mesh, mat, amount] of [[this.rain, this.rainMat, fx.rain], [this.snow, this.snowMat, fx.snow]]) {
      mesh.visible = amount > 0.01;
      if (!mesh.visible) continue;
      const u = mat.uniforms;
      u.time.value = this.time;
      u.center.value.copy(head);
      u.wind.value.set(windTo.x, windTo.z).multiplyScalar(mesh === this.rain ? 0.6 : 0.5);
      u.amount.value = Math.min(1, 0.15 + amount);
      u.bright.value = 0.25 + 0.75 * light + this.flash;
    }
    // Lightning: a flash now and then in a storm, its thunder a few seconds later.
    this.flash = Math.max(0, this.flash - dt * 6);
    if (thunder && this.time > this.nextFlash) {
      if (this.nextFlash) {
        this.flash = 1;
        onStrike?.(800 + Math.random() * 5000);
      }
      this.nextFlash = this.time + 6 + Math.random() * 20;
    }
  }
}

