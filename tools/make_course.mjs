#!/usr/bin/env node
// Generate a course file for a site from a seed, and list it in the site's
// courses/index.json so the app offers it.
//
//   node tools/make_course.mjs --site demo-synthetic --seed 1001 --id day-1 --name "Day course 1"
//
// Options: --points N --decoys N --time MIN --pass N --preset woods|open
//          --start x,z (scene metres; default: the site's default_start)
// If the site has features.json, stakes keep clear of roads, buildings, parking and
// the campground (src/features-logic.js).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { decodeHeights, Heightfield } from '../src/heightfield.js';
import { generateCourse, validateCourse, idealDistance } from '../src/course-logic.js';
import { eightDigitGrid } from '../src/coords.js';
import { FeatureIndex, stakeAvoider } from '../src/features-logic.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.site || !args.seed) {
  console.error('Usage: node tools/make_course.mjs --site <id> --seed <n> [--id <id>] [--name <name>] [--points N] [--decoys N] [--time MIN] [--pass N] [--preset woods|open]');
  process.exit(2);
}
const dir = new URL(`../sites/${args.site}/`, import.meta.url);
const site = JSON.parse(readFileSync(new URL('site.json', dir)));
const buf = readFileSync(new URL('height.bin', dir));
const field = new Heightfield(
  decodeHeights(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), site.elev_min, site.elev_max, site.elev_ref),
  site.grid, site.spacing_m,
);

const opts = {};
if (args.points) opts.points = Number(args.points);
if (args.decoys) opts.decoys = Number(args.decoys);
if (args.time) opts.timeLimitMin = Number(args.time);
if (args.pass) opts.passThreshold = Number(args.pass);
if (args.preset) opts.preset = args.preset;
if (args.start) {
  const [x, z] = args.start.split(',').map(Number);
  opts.start = { x, z };
} else if (site.default_start) opts.start = { x: site.default_start.x, z: site.default_start.z };
const featuresUrl = new URL('features.json', dir);
if (existsSync(featuresUrl)) opts.avoid = stakeAvoider(new FeatureIndex(JSON.parse(readFileSync(featuresUrl))));

const course = generateCourse(site, field, Number(args.seed), opts);
if (args.id) course.id = args.id;
if (args.name) course.name = args.name;
const problems = validateCourse(course, site, field, opts);
if (problems.length) {
  console.error('Generated course failed validation:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const coursesDir = new URL('courses/', dir);
if (!existsSync(coursesDir)) mkdirSync(coursesDir);
writeFileSync(new URL(`${course.id}.json`, coursesDir), JSON.stringify(course, null, 2) + '\n');
const indexUrl = new URL('index.json', coursesDir);
const index = existsSync(indexUrl) ? JSON.parse(readFileSync(indexUrl)) : [];
const entry = { id: course.id, name: course.name, file: `${course.id}.json` };
const at = index.findIndex((c) => c.id === course.id);
if (at >= 0) index[at] = entry; else index.push(entry);
writeFileSync(indexUrl, JSON.stringify(index, null, 2) + '\n');

console.log(`Wrote sites/${args.site}/courses/${course.id}.json: ${course.name}`);
console.log(`  start  ${eightDigitGrid(site, course.start.x, course.start.z)}`);
course.points.forEach((p, i) => console.log(`  pt ${i + 1}   ${eightDigitGrid(site, p.x, p.z)}  (${p.code})`));
console.log(`  ${course.decoys.length} decoys, ideal distance ${(idealDistance(course) / 1000).toFixed(2)} km, ${course.time_limit_min} min, pass ${course.pass_threshold}/${course.points.length}`);
