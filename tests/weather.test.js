import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  complete, presetWeather, fromOpenMeteoCurrent, fromOpenMeteoHourly, hourlyAt, fromNwsObservation,
  weatherEffects, phenology, seasonPhenology, seasonName, dayOfYear, WEATHER_MODES, PRESETS,
} from '../src/weather-logic.js';

test('complete fills gaps from the weather code', () => {
  const fog = complete({ code: 45 });
  assert.ok(fog.fog && fog.visibilityM <= 300 && fog.cloud === 1);
  const rain = complete({ code: 65 });
  assert.equal(rain.rainMmH, 10);
  assert.ok(rain.visibilityM < 8000);
  const storm = complete({ code: 95 });
  assert.ok(storm.thunder && storm.rainMmH > 5);
  const snow = complete({ code: 73 });
  assert.ok(snow.snowCmH > 0 && snow.rainMmH === 0);
  assert.equal(complete({ code: 0, visibilityM: 24140 }).visibilityM, 24140);
});

test('every preset is a full report, and the modes list the sources first', () => {
  assert.deepEqual(WEATHER_MODES.slice(0, 2), ['live', 'replay']);
  for (const k of Object.keys(PRESETS)) {
    const w = presetWeather(k);
    for (const f of ['tempC', 'windMs', 'cloud', 'rainMmH', 'snowCmH', 'visibilityM']) assert.ok(Number.isFinite(w[f]), `${k}.${f}`);
  }
  assert.ok(presetWeather('blizzard').visibilityM < 300);
  assert.ok(presetWeather('snow').snowDepthM > 0.05);
});

test('Open-Meteo current block', () => {
  const w = fromOpenMeteoCurrent({ current: {
    time: '2026-10-11T16:00', temperature_2m: 17.2, relative_humidity_2m: 64, rain: 0, showers: 0, snowfall: 0,
    weather_code: 2, cloud_cover: 48, wind_speed_10m: 3.4, wind_direction_10m: 300, wind_gusts_10m: 7.1, visibility: 24140, snow_depth: 0,
  } });
  assert.equal(w.label, 'Partly cloudy');
  assert.equal(w.cloud, 0.48);
  assert.equal(w.windFromDeg, 300);
  assert.equal(w.visibilityM, 24140);
  assert.equal(fromOpenMeteoCurrent({}), null);
});

test('Open-Meteo hourly: a day of hours, blended between hours', () => {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const j = { hourly: {
    time: hours.map((h) => `2024-07-04T${String(h).padStart(2, '0')}:00`),
    temperature_2m: hours.map((h) => 20 + h / 2), weather_code: hours.map((h) => (h < 15 ? 1 : 63)),
    cloud_cover: hours.map((h) => (h < 15 ? 20 : 100)), rain: hours.map((h) => (h < 15 ? 0 : 3)),
    wind_speed_10m: hours.map(() => 2), wind_direction_10m: hours.map(() => 200), snowfall: hours.map(() => 0),
  } };
  const day = fromOpenMeteoHourly(j);
  assert.equal(day.length, 24);
  const at = hourlyAt(day, 14 * 60 + 30); // half way from 14:00 to 15:00
  assert.equal(at.tempC, 27.25);
  assert.ok(Math.abs(at.cloud - 0.6) < 1e-9);
  assert.equal(at.label, 'Rain'); // the nearer hour (rounded up at the half)
  assert.equal(hourlyAt(day, 3 * 60).label, 'Mainly clear');
});

test('NWS observation: units converted, cloud layers and text read', () => {
  const w = fromNwsObservation({ properties: {
    textDescription: 'Light Rain and Fog/Mist', timestamp: '2026-10-11T19:52:00+00:00',
    temperature: { value: 12.8 }, relativeHumidity: { value: 96 }, windSpeed: { value: 18 }, windGust: { value: null },
    windDirection: { value: 50 }, visibility: { value: 3220 }, precipitationLastHour: { value: 1.2 },
    cloudLayers: [{ amount: 'BKN' }, { amount: 'OVC' }],
  } });
  assert.equal(w.code, 61);
  assert.equal(w.cloud, 1);
  assert.equal(w.windMs, 5);
  assert.equal(w.visibilityM, 3220);
  assert.equal(w.label, 'Light Rain and Fog/Mist');
});

test('weatherEffects: rain wets, snow depth whitens, wind sways, fog closes in', () => {
  const r = weatherEffects(presetWeather('rain'));
  assert.ok(r.rain > 0.3 && r.wet > 0.5 && r.snow === 0);
  const s = weatherEffects(presetWeather('snow'));
  assert.ok(s.snow > 0.3 && s.rain === 0 && s.snowCover === 1);
  assert.ok(weatherEffects(presetWeather('blizzard')).sway > weatherEffects(presetWeather('clear')).sway);
  assert.ok(weatherEffects(presetWeather('fog')).visibilityM < 200);
  assert.equal(weatherEffects(presetWeather('clear')).wet, 0);
});

test('phenology: bare in winter, green in summer, turning in October, later up high and north', () => {
  const lat = 38.7, elev = 300;
  assert.equal(phenology(15, lat, elev).leaf, 0);
  assert.equal(phenology(190, lat, elev).leaf, 1);
  assert.equal(phenology(190, lat, elev).autumn, 0);
  const oct20 = phenology(293, lat, elev);
  assert.ok(oct20.leaf > 0.9 && oct20.autumn > 0.8, JSON.stringify(oct20));
  assert.ok(phenology(330, lat, elev).leaf === 0);
  // Spring comes later on a high ridge.
  assert.ok(phenology(118, lat, 1000).leaf < phenology(118, lat, 300).leaf);
  assert.equal(seasonName(phenology(15, lat, elev)), 'winter');
  assert.equal(seasonName(phenology(190, lat, elev)), 'summer');
  assert.equal(seasonName(phenology(120, lat, elev)), 'spring');
  assert.equal(seasonName(oct20), 'autumn');
  assert.equal(seasonPhenology('winter').leaf, 0);
});

test('dayOfYear in the site\'s local time', () => {
  assert.equal(dayOfYear(new Date(Date.UTC(2026, 0, 1, 3)), -300), 365); // still 31 Dec in Virginia
  assert.equal(dayOfYear(new Date(Date.UTC(2026, 1, 1, 12)), -300), 32);
});
