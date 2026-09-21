/**
 * config.js
 *
 * Centralises environment-variable reading & validation plus shared constants
 * for the Pump.fun live launch detector.
 *
 * Throws at startup if any required env var is missing so failures are
 * loud and immediate rather than hidden inside a later async call.
 */

'use strict';

// ---------------------------------------------------------------------------
// Environment-variable validation
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Copy .env.example to .env and fill in the value, or set it on your host.`
    );
  }
  return value;
}

// Required
export const HELIUS_API_KEY = requireEnv('HELIUS_API_KEY');
export const FIREBASE_SERVICE_ACCOUNT_JSON = requireEnv('FIREBASE_SERVICE_ACCOUNT_JSON');
export const FIREBASE_DATABASE_ID =
  process.env.FIREBASE_DATABASE_ID ??
  'ai-studio-solanamemecointr-e8d74d6f-bad5-479c-b097-fb16e4279ca1';

// ---------------------------------------------------------------------------
// Derived URLs
// ---------------------------------------------------------------------------

/** Helius websocket endpoint for logsSubscribe */
export const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

/** Helius RPC endpoint for getTransaction / getAccountInfo */
export const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// ---------------------------------------------------------------------------
// Pump.fun constants
// ---------------------------------------------------------------------------

/** The on-chain program ID for Pump.fun — the ONLY launchpad in scope */
export const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * The log line emitted by the Pump.fun Anchor program when a new token is
 * being created. Buy/sell/swap instructions log different names
 * ("Instruction: Buy", "Instruction: Sell", etc.).
 * This is how we filter create-only from the firehose of all program activity.
 */
export const CREATE_LOG_MARKER = 'Program log: Instruction: Create';
