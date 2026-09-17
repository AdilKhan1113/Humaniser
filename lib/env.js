// Loads .env into process.env. Node's own --env-file flag needs a newer runtime
// than this app asks for, and it prints a notice when the file is absent, so a
// dozen lines here keep setup to a single command on any Node 18 or later.
//
// Import this before any module that reads process.env at load time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.env');

try {
  const contents = fs.readFileSync(envPath, 'utf8');
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Strip one layer of matching quotes, so both KEY=value and KEY="value" work.
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
    // A variable already set in the shell wins over the file.
    if (!(key in process.env) || process.env[key] === '') process.env[key] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.warn(`[humaniser] could not read .env: ${error.message}`);
  }
}
