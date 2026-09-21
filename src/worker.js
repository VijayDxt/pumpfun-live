/**
 * worker.js  ←  entry point
 *
 * Wires the pipeline: listener → checker → writer
 *
 *   1. Starts the websocket listener for Pump.fun create instructions
 *   2. On each detected launch:
 *      a. Checks mint/freeze authority status via Solana RPC
 *      b. Writes the result to Firestore live_launches collection
 *   3. Logs aggregate stats every 60 seconds
 *   4. Handles graceful shutdown on SIGINT/SIGTERM
 *
 * Start with:
 *   node --import ./src/boot.js src/worker.js
 *
 * Required env vars:
 *   HELIUS_API_KEY
 *   FIREBASE_SERVICE_ACCOUNT_JSON
 */

'use strict';

import { PUMPFUN_PROGRAM_ID } from './config.js';
import { PumpfunListener } from './listener.js';
import { checkMint } from './checker.js';
import { writeLaunch } from './writer.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const listener = new PumpfunListener();
let totalProcessed = 0;
let totalErrors = 0;

// ---------------------------------------------------------------------------
// Launch processing pipeline
// ---------------------------------------------------------------------------

listener.on('launch', async (launch) => {
  const { mint, signature, name, symbol } = launch;
  const label = symbol ?? name ?? mint.slice(0, 12) + '…';

  try {
    // Step 1: Check mint/freeze authority
    console.log(`[worker] Checking authorities for ${label} (${mint})…`);
    const { mintAuthorityRevoked, freezeAuthorityRevoked } = await checkMint(mint);

    const mintFlag = mintAuthorityRevoked ? '✓ revoked' : '✗ ACTIVE';
    const freezeFlag = freezeAuthorityRevoked ? '✓ revoked' : '✗ ACTIVE';
    console.log(
      `[worker]   Mint authority: ${mintFlag}  |  Freeze authority: ${freezeFlag}`
    );

    // Step 2: Write to Firestore
    await writeLaunch({
      mint,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      name: name ?? null,
      symbol: symbol ?? null,
    });

    totalProcessed++;
    console.log(
      `[worker] ── Launch #${totalProcessed} processed: ${label} ` +
        `(tx: ${signature.slice(0, 16)}…) ──`
    );
  } catch (err) {
    totalErrors++;
    console.error(
      `[worker] ── FAILED processing ${label} (${mint}): ${err.message}`
    );
    if (err.stack) console.error(err.stack);
  }
});

// ---------------------------------------------------------------------------
// Periodic stats logging
// ---------------------------------------------------------------------------

const STATS_INTERVAL_MS = 60_000; // every 60 seconds

const statsTimer = setInterval(() => {
  const s = listener.stats;
  console.log(
    `\n[worker] ── STATS ──` +
      `  connected=${s.connected}` +
      `  logs_received=${s.logsReceived}` +
      `  logs_filtered=${s.logsFiltered}` +
      `  launches_detected=${s.launchesDetected}` +
      `  processed=${totalProcessed}` +
      `  errors=${totalErrors + s.errors}` +
      `  last_launch=${s.lastLaunchAt ?? 'none'}` +
      `\n`
  );
}, STATS_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`\n[worker] Received ${signal} — shutting down…`);
  clearInterval(statsTimer);
  listener.close();

  // Give a moment for any in-flight writes to complete
  setTimeout(() => {
    console.log('[worker] Goodbye.');
    process.exit(0);
  }, 2_000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

console.log('[worker] ╔══════════════════════════════════════════════════════╗');
console.log('[worker] ║   Pump.fun Live Launch Detector — Starting Up       ║');
console.log('[worker] ╚══════════════════════════════════════════════════════╝');
console.log(`[worker] Program ID: ${PUMPFUN_PROGRAM_ID}`);
console.log(`[worker] Filter: "Instruction: Create" only`);
console.log(`[worker] Stats interval: ${STATS_INTERVAL_MS / 1000}s`);
console.log('[worker] Starting websocket listener…\n');

listener.start();
