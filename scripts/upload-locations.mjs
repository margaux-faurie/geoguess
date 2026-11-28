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

execFileSync('npx', ['wrangler@4', 'd1', 'execute', 'guessgeo', '--remote', '--file', out], {
  stdio: 'inherit',
  shell: process.platform === 'win32', // npx is a .cmd file on Windows
});
console.log('Done. The Worker picks the new locations up on its next start (a deploy, or within minutes).');
