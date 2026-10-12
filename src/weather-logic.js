// Weather and seasons as numbers the scene can use. Pure functions, no Three.js
// and no fetching, so they can be tested in Node. weather.js does the fetching and
// the drawing.
//
// One shape for every source (live, replay, picked):
//   { label, code, tempC, humidity, windMs, gustMs, windFromDeg, cloud 0..1,
//     rainMmH, snowCmH, snowDepthM, visibilityM, fog, thunder, source, time }
// windFromDeg: where the wind blows from, degrees true (meteorological).

// WMO weather interpretation codes (as Open-Meteo reports them).
export const WMO = Object.freeze({
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
});

// Weather you can pick, as if it were a report.
export const PRESETS = Object.freeze({
  clear: { label: 'Clear', code: 0, tempC: 21, humidity: 50, windMs: 2, cloud: 0.02, rainMmH: 0, snowCmH: 0, visibilityM: 30000 },
  partly: { label: 'Partly cloudy', code: 2, tempC: 19, humidity: 60, windMs: 4, cloud: 0.45, rainMmH: 0, snowCmH: 0, visibilityM: 25000 },
  overcast: { label: 'Overcast', code: 3, tempC: 14, humidity: 75, windMs: 5, cloud: 1, rainMmH: 0, snowCmH: 0, visibilityM: 15000 },
  fog: { label: 'Fog', code: 45, tempC: 9, humidity: 99, windMs: 0.5, cloud: 1, rainMmH: 0, snowCmH: 0, visibilityM: 120 },
  drizzle: { label: 'Drizzle', code: 53, tempC: 11, humidity: 95, windMs: 3, cloud: 1, rainMmH: 0.6, snowCmH: 0, visibilityM: 4000 },
  rain: { label: 'Rain', code: 63, tempC: 13, humidity: 95, windMs: 6, cloud: 1, rainMmH: 4, snowCmH: 0, visibilityM: 2500 },
  storm: { label: 'Thunderstorm', code: 95, tempC: 24, humidity: 90, windMs: 11, gustMs: 20, cloud: 1, rainMmH: 18, snowCmH: 0, visibilityM: 1200 },
  snow: { label: 'Snow', code: 73, tempC: -2, humidity: 90, windMs: 3, cloud: 1, rainMmH: 0, snowCmH: 1, snowDepthM: 0.12, visibilityM: 1500 },
  blizzard: { label: 'Blizzard', code: 75, tempC: -8, humidity: 85, windMs: 14, gustMs: 22, cloud: 1, rainMmH: 0, snowCmH: 3, snowDepthM: 0.3, visibilityM: 150 },
});

// What the Weather setting cycles through: the two data sources, then the picks.
export const WEATHER_MODES = Object.freeze(['live', 'replay', ...Object.keys(PRESETS)]);
export const WEATHER_MODE_NAMES = Object.freeze({ live: 'Live', replay: 'Replay a day', ...Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.label])) });

// Typical rates (mm/h) for rain codes reported without an amount.
const RAIN_BY_CODE = { 61: 1, 63: 4, 65: 10, 66: 1, 67: 4, 80: 1.5, 81: 5, 82: 15 };

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

// Fill in what a source leaves out, from the weather code.
export function complete(w) {
  const code = num(w.code, 0);
  const out = {
    label: w.label || WMO[code] || 'Unknown',
    code,
    tempC: num(w.tempC, 15),
    humidity: num(w.humidity, 60),
    windMs: Math.max(0, num(w.windMs, 3)),
    gustMs: Math.max(0, num(w.gustMs, num(w.windMs, 3) * 1.5)),
    windFromDeg: num(w.windFromDeg, 270),
    cloud: Math.min(1, Math.max(0, num(w.cloud, code >= 3 ? 1 : code === 2 ? 0.45 : code === 1 ? 0.2 : 0))),
    rainMmH: Math.max(0, num(w.rainMmH, 0)),
    snowCmH: Math.max(0, num(w.snowCmH, 0)),
    snowDepthM: Math.max(0, num(w.snowDepthM, 0)),
    source: w.source || 'pick',
    time: w.time ?? null,
  };
  out.fog = code === 45 || code === 48;
  out.thunder = code >= 95;
  // Precipitation the code implies but the numbers don't show (a report rounded to 0).
  if (out.rainMmH === 0 && out.snowCmH === 0) {
    if ((code >= 51 && code <= 57)) out.rainMmH = 0.4;
    else if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) out.rainMmH = RAIN_BY_CODE[code];
    else if (code >= 95) out.rainMmH = 12;
    else if ((code >= 71 && code <= 77) || code === 85 || code === 86) out.snowCmH = code === 75 || code === 86 ? 2.5 : 0.8;
  }
  // Visibility: the report's, else what fog, rain or snow usually allow.
  let vis = num(w.visibilityM, NaN);
  if (!Number.isFinite(vis) || vis <= 0) {
    vis = 30000;
    if (out.fog) vis = 200;
    else if (out.snowCmH > 0) vis = Math.max(150, 3000 / (1 + out.snowCmH * 2));
    else if (out.rainMmH > 0) vis = Math.max(800, 8000 / (1 + out.rainMmH / 2));
    else if (out.humidity > 97) vis = 2000;
  }
  out.visibilityM = vis;
  return out;
}

export function presetWeather(name) {
  const p = PRESETS[name] || PRESETS.clear;
  return complete({ ...p, windFromDeg: 250, source: 'pick' });
}

// Open-Meteo forecast "current" block -> weather.
// https://open-meteo.com/en/docs (wind_speed_unit=ms)
export function fromOpenMeteoCurrent(json) {
  const c = json?.current;
  if (!c) return null;
  return complete({
    code: c.weather_code, tempC: c.temperature_2m, humidity: c.relative_humidity_2m,
    windMs: c.wind_speed_10m, gustMs: c.wind_gusts_10m, windFromDeg: c.wind_direction_10m,
    cloud: num(c.cloud_cover, NaN) / 100, rainMmH: num(c.rain, 0) + num(c.showers, 0), snowCmH: c.snowfall,
    snowDepthM: c.snow_depth, visibilityM: c.visibility, source: 'live', time: c.time,
  });
}

// Open-Meteo hourly block (forecast past days or the ERA5 archive) -> weather
// for each hour, keyed by the hour's local time string "YYYY-MM-DDTHH:00".
export function fromOpenMeteoHourly(json) {
  const h = json?.hourly;
  if (!h?.time) return [];
  return h.time.map((t, i) => complete({
    code: h.weather_code?.[i], tempC: h.temperature_2m?.[i], humidity: h.relative_humidity_2m?.[i],
    windMs: h.wind_speed_10m?.[i], gustMs: h.wind_gusts_10m?.[i], windFromDeg: h.wind_direction_10m?.[i],
    cloud: num(h.cloud_cover?.[i], NaN) / 100, rainMmH: h.rain?.[i] ?? h.precipitation?.[i], snowCmH: h.snowfall?.[i],
    snowDepthM: h.snow_depth?.[i], visibilityM: h.visibility?.[i], source: 'replay', time: t,
  }));
}

// The weather at a local minute of the day from a day of hourly reports: the
// nearest hour for the sky's state, numbers blended between the two hours.
export function hourlyAt(hours, minuteOfDay) {
  if (!hours.length) return null;
  const i = Math.max(0, Math.min(hours.length - 1, Math.floor(minuteOfDay / 60)));
  const j = Math.min(hours.length - 1, i + 1);
  const t = Math.max(0, Math.min(1, minuteOfDay / 60 - i));
  const a = hours[i], b = hours[j];
  const mix = (k) => a[k] + (b[k] - a[k]) * t;
  const near = t < 0.5 ? a : b;
  return {
    ...near,
    tempC: mix('tempC'), humidity: mix('humidity'), windMs: mix('windMs'), gustMs: mix('gustMs'),
    cloud: mix('cloud'), rainMmH: mix('rainMmH'), snowCmH: mix('snowCmH'), snowDepthM: mix('snowDepthM'),
    visibilityM: Math.exp(Math.log(a.visibilityM) + (Math.log(b.visibilityM) - Math.log(a.visibilityM)) * t),
  };
}

// NWS latest observation (api.weather.gov, US only) -> weather. A fallback for
// live weather. Values come with units; wind in km/h.
export function fromNwsObservation(json) {
  const p = json?.properties;
  if (!p) return null;
  const v = (q) => (q && Number.isFinite(q.value) ? q.value : NaN);
  const layers = p.cloudLayers || [];
  const COVER = { CLR: 0, SKC: 0, FEW: 0.2, SCT: 0.45, BKN: 0.75, OVC: 1, VV: 1 };
  const cloud = layers.reduce((m, l) => Math.max(m, COVER[l.amount] ?? 0), 0);
  const text = (p.textDescription || '').toLowerCase();
  let code = cloud >= 0.9 ? 3 : cloud >= 0.4 ? 2 : cloud > 0.1 ? 1 : 0;
  if (/thunder/.test(text)) code = 95;
  else if (/snow/.test(text)) code = /heavy/.test(text) ? 75 : /light/.test(text) ? 71 : 73;
  else if (/drizzle/.test(text)) code = 53;
  else if (/rain|shower/.test(text)) code = /heavy/.test(text) ? 65 : /light/.test(text) ? 61 : 63;
  else if (/fog|mist/.test(text)) code = 45;
  return complete({
    label: p.textDescription || undefined, code,
    tempC: v(p.temperature), humidity: v(p.relativeHumidity),
    windMs: v(p.windSpeed) / 3.6, gustMs: v(p.windGust) / 3.6, windFromDeg: v(p.windDirection),
    cloud, rainMmH: v(p.precipitationLastHour), visibilityM: v(p.visibility), source: 'live', time: p.timestamp,
  });
}

// ---- What the weather does to the scene ----

// How far you can see (metres) and how gloomy it is (0..1, extra darkening).
export function weatherEffects(w) {
  const rain = Math.min(1, w.rainMmH / 10);
  const snow = Math.min(1, w.snowCmH / 2.5);
  return {
    visibilityM: w.visibilityM,
    gloom: Math.min(0.7, rain * 0.35 + (w.thunder ? 0.3 : 0) + (w.fog ? 0.12 : 0) + snow * 0.15),
    cloud: w.cloud,
    rain: w.snowCmH > 0 ? 0 : Math.min(1, w.rainMmH / 8),
    snow: Math.min(1, w.snowCmH / 2.5 + (w.snowCmH > 0 ? 0.15 : 0)),
    // Rain soaks things for a while: wet ground once it's raining at all.
    wet: Math.min(1, w.rainMmH > 0 ? 0.5 + w.rainMmH / 6 : 0),
    snowCover: Math.min(1, w.snowDepthM / 0.05),
    sway: Math.min(1, (w.windMs + 0.5 * Math.max(0, w.gustMs - w.windMs)) / 14),
  };
}

// ---- Seasons ----

export const SEASONS = Object.freeze(['auto', 'spring', 'summer', 'autumn', 'winter']);

const DAY = 86400000;
export function dayOfYear(date, offsetMin = 0) {
  const d = new Date(date.getTime() + offsetMin * 60000);
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
}

const ramp = (a, b, v) => Math.max(0, Math.min(1, (v - a) / (b - a)));

// Deciduous leaves for a day of the year, a latitude and an elevation (m):
//   leaf 0..1 (bare .. full), autumn 0..1 (share of trees turned), spring (fresh green).
// Mid-Atlantic dates (Virginia at 300 m: leaf-out mid April to early May, colour
// from late September, peak mid to late October, bare by mid November), moved
// later in spring and earlier in autumn about 3 days per degree north and 1 day
// per 40 m up. A rough rule, not a phenology model.
export function phenology(doy, lat = 38.5, elevM = 300) {
  const shift = (lat - 38.5) * 3 + (elevM - 300) / 40;
  const greenA = 100 + shift, greenB = 128 + shift;
  const colourA = 268 - shift, colourB = 296 - shift;
  const dropA = 293 - shift, dropB = 318 - shift;
  const leaf = doy < 200 ? ramp(greenA, greenB, doy) : 1 - ramp(dropA, dropB, doy);
  const autumn = doy < 200 ? 0 : ramp(colourA, colourB, doy);
  const spring = doy < 200 ? 1 - ramp(greenB, greenB + 25, doy) : 0;
  return { leaf, autumn, spring: leaf > 0 ? spring : 0 };
}

// The same for a season you pick instead of the date.
export function seasonPhenology(season) {
  return {
    spring: { leaf: 0.85, autumn: 0, spring: 1 },
    summer: { leaf: 1, autumn: 0, spring: 0 },
    autumn: { leaf: 0.9, autumn: 0.85, spring: 0 },
    winter: { leaf: 0, autumn: 1, spring: 0 },
  }[season] || { leaf: 1, autumn: 0, spring: 0 };
}

// The season's name for a day of the year (for the info card).
export function seasonName(p) {
  if (p.leaf < 0.2) return 'winter';
  if (p.spring > 0.3) return 'spring';
  if (p.autumn > 0.2) return 'autumn';
  return 'summer';
}
