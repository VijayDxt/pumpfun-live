/**
 * boot.js — loaded before any other module via `node --import ./src/boot.js`
 *
 * Loads the .env file synchronously before any other module is evaluated.
 * This is the only reliable way to get dotenv working with ES modules,
 * because top-level `import` statements are hoisted and run before any
 * await/async code in the entry point.
 *
 * In production (Railway), this file still loads but dotenv.config() is a
 * no-op when no .env file exists — perfectly safe.
 */

import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

if (existsSync(envPath)) {
  // Use createRequire to load dotenv synchronously (require() works in ESM via this bridge)
  const require = createRequire(import.meta.url);
  const dotenv = require('dotenv');
  dotenv.config({ path: envPath });
  console.log('[boot] Loaded .env from', envPath);
}
