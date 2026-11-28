#!/usr/bin/env node
// Sends data/locations.json to the D1 database, so the deployed Worker can play it.
//
//   npm run locations:upload
//
// Writes data/locations.sql (gitignored, it holds the answers), then runs
// `wrangler d1 execute guessgeo --remote --file data/locations.sql`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapsToSql } from '../src/d1-maps.js';
import { parseMaps } from '../src/maps.js';

const root = new URL('..', import.meta.url);
const src = fileURLToPath(new URL('data/locations.json', root));
const out = fileURLToPath(new URL('data/locations.sql', root));

const maps = parseMaps(JSON.parse(readFileSync(src, 'utf8')), 'data/locations.json');
writeFileSync(out, mapsToSql(maps));
const count = maps.reduce((n, m) => n + m.locations.length, 0);
console.log(`Prepared ${maps.length} map(s), ${count} locations. Uploading to D1 (remote)...`);

// Fixed arguments only, and a relative path run from the repo root, so nothing is ever interpolated into a shell.
const args = ['wrangler@4', 'd1', 'execute', 'guessgeo', '--remote', '--file', 'data/locations.sql'];
const cwd = fileURLToPath(root);
if (process.platform === 'win32') {
  // npx is a .cmd script on Windows and Node no longer runs those without a shell: call cmd.exe explicitly.
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', ['npx', ...args].join(' ')], { stdio: 'inherit', cwd });
} else {
  execFileSync('npx', args, { stdio: 'inherit', cwd });
}
console.log('Done. A running Worker keeps the locations it started with: the next deploy, or a new isolate, picks these up.');
