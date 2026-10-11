import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compassPoint, formatTemp, formatWind, formatDistance, formatElevation, formatLatLon, formatDay, utcLabel } from '../src/info-logic.js';

test('compass points', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(247.5), 'WSW');
  assert.equal(compassPoint(-90), 'W');
});

test('temperature, wind, distance and elevation in US and metric units', () => {
  assert.equal(formatTemp(20, 'us'), '68 °F (20 °C)');
  assert.equal(formatTemp(-5, 'metric'), '-5 °C (23 °F)');
  assert.equal(formatWind(4, 250, 4, 'us'), 'WSW 9 mph');
  assert.equal(formatWind(4, 250, 9, 'metric'), 'WSW 14 km/h, gusts 32');
  assert.equal(formatWind(0.2, 90, 0, 'us'), 'calm');
  assert.equal(formatDistance(24140, 'us'), '15 mi');
  assert.equal(formatDistance(120, 'us'), '390 ft');
  assert.equal(formatDistance(2500, 'metric'), '2.5 km');
  assert.equal(formatElevation(862, 'us'), '2,828 ft (862 m)');
  assert.equal(formatElevation(862, 'metric'), '862 m (2,828 ft)');
});

test('lat/lon, day and UTC offset labels', () => {
  assert.equal(formatLatLon(38.76417, -78.29575), '38.76417° N  78.29575° W');
  assert.equal(formatDay(new Date(Date.UTC(2026, 9, 11, 20)), -240), 'Sunday 11 October 2026');
  assert.equal(formatDay(new Date(Date.UTC(2026, 9, 12, 2)), -240), 'Sunday 11 October 2026');
  assert.equal(utcLabel(-240), 'UTC-4');
  assert.equal(utcLabel(330), 'UTC+5.5');
});
