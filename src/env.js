import { existsSync, readFileSync } from 'node:fs';

/** Minimal .env loader (KEY=value lines). Existing environment variables win. */
export function loadEnv(file = '.env') {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}
