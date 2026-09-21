/**
 * listener.js
 *
 * Subscribes to Pump.fun program logs via Helius websocket and detects
 * brand-new token launches by filtering for the "create" instruction.
 *
 * Emits 'launch' events with { mint, signature, name?, symbol?, uri? }
 * when a new token creation is detected.
 *
 * Features:
 *  - Filters specifically for "Instruction: Create" logs (ignores buy/sell/swap)
 *  - Extracts mint address via getTransaction for reliability (top-level & inner CPI)
 *  - Supports transaction versions 0 and 1
 *  - Best-effort name/symbol/uri extraction from Program data event logs
 *  - Auto-reconnect with exponential backoff
 *  - Heartbeat pings to prevent Helius 10-min inactivity timeout
 *  - In-memory deduplication of recent signatures
 */

'use strict';

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  HELIUS_WS_URL,
  HELIUS_RPC_URL,
  PUMPFUN_PROGRAM_ID,
  CREATE_LOG_MARKER,
} from './config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;        // 30s ping to keep connection alive
const RECONNECT_BASE_MS = 1_000;             // Initial reconnect delay
const RECONNECT_MAX_MS = 30_000;             // Max reconnect delay
const DEDUP_SET_MAX_SIZE = 1_000;            // Max recent signatures to remember
const GET_TX_RETRY_DELAY_MS = 1_500;         // Delay before retrying getTransaction
const GET_TX_MAX_RETRIES = 4;                // Max retries for getTransaction

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort extraction of name, symbol, uri from the Pump.fun CreateEvent
 * emitted in the "Program data:" log line.
 */
function parseCreateEventFromLogs(logs) {
  let dataB64 = null;
  let seenCreate = false;

  for (const line of logs) {
    if (line.includes(CREATE_LOG_MARKER)) {
      seenCreate = true;
      continue;
    }
    if (seenCreate && line.startsWith('Program data: ')) {
      dataB64 = line.slice('Program data: '.length).trim();
      break;
    }
  }

  if (!dataB64) return null;

  try {
    const buf = Buffer.from(dataB64, 'base64');
    let offset = 8; // skip 8-byte Anchor event discriminator

    function readString() {
      if (offset + 4 > buf.length) return null;
      const len = buf.readUInt32LE(offset);
      offset += 4;
      if (offset + len > buf.length) return null;
      const str = buf.toString('utf8', offset, offset + len);
      offset += len;
      return str;
    }

    const name = readString();
    const symbol = readString();
    const uri = readString();

    return { name, symbol, uri };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PumpfunListener class
// ---------------------------------------------------------------------------

export class PumpfunListener extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._subscriptionId = null;
    this._heartbeatTimer = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._recentSignatures = new Set();
    this._closing = false;
    this._connection = new Connection(HELIUS_RPC_URL, 'confirmed');

    // Stats
    this._stats = {
      connected: false,
      launchesDetected: 0,
      logsReceived: 0,
      logsFiltered: 0,
      errors: 0,
      lastLaunchAt: null,
    };
  }

  get stats() {
    return { ...this._stats };
  }

  start() {
    this._closing = false;
    this._connect();
  }

  close() {
    this._closing = true;
    this._clearHeartbeat();

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  // ── Private: Connection management ─────────────────────────────────────

  _connect() {
    if (this._closing) return;

    console.log(`[listener] Connecting to Helius websocket…`);
    const ws = new WebSocket(HELIUS_WS_URL);
    this._ws = ws;

    ws.on('open', () => {
      console.log('[listener] WebSocket connected.');
      this._stats.connected = true;
      this._reconnectDelay = RECONNECT_BASE_MS;
      this._startHeartbeat(ws);
      this._subscribe(ws);
    });

    ws.on('message', (raw) => {
      this._handleMessage(raw);
    });

    ws.on('close', (code, reason) => {
      this._stats.connected = false;
      this._clearHeartbeat();
      const reasonStr = reason ? reason.toString() : 'unknown';
      console.warn(`[listener] WebSocket closed: code=${code} reason=${reasonStr}`);
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      this._stats.errors++;
      console.error(`[listener] WebSocket error: ${err.message}`);
    });

    ws.on('pong', () => {});
  }

  _subscribe(ws) {
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        { mentions: [PUMPFUN_PROGRAM_ID] },
        { commitment: 'confirmed' },
      ],
    };

    console.log(`[listener] Subscribing to program logs for ${PUMPFUN_PROGRAM_ID}…`);
    ws.send(JSON.stringify(request));
  }

  _scheduleReconnect() {
    if (this._closing) return;

    console.log(`[listener] Reconnecting in ${this._reconnectDelay / 1000}s…`);
    setTimeout(() => {
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
      this._connect();
    }, this._reconnectDelay);
  }

  _startHeartbeat(ws) {
    this._clearHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _clearHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── Private: Message handling ──────────────────────────────────────────

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('[listener] Failed to parse WebSocket message.');
      return;
    }

    if (msg.id === 1 && msg.result != null) {
      this._subscriptionId = msg.result;
      console.log(`[listener] ✓ Subscribed. Subscription ID: ${this._subscriptionId}`);
      return;
    }

    if (msg.method !== 'logsNotification') return;

    const value = msg.params?.result?.value;
    if (!value) return;

    this._stats.logsReceived++;

    if (value.err !== null) {
      this._stats.logsFiltered++;
      return;
    }

    const { signature, logs } = value;
    if (!signature || !logs) return;

    const isCreate = logs.some((line) => line.includes(CREATE_LOG_MARKER));

    if (!isCreate) {
      this._stats.logsFiltered++;
      return;
    }

    if (this._recentSignatures.has(signature)) {
      return;
    }
    this._addToDedup(signature);

    this._processCreate(signature, logs).catch((err) => {
      this._stats.errors++;
      console.error(`[listener] Error processing create tx ${signature}: ${err.message}`);
    });
  }

  // ── Private: Create transaction processing ─────────────────────────────

  async _processCreate(signature, logs) {
    const eventData = parseCreateEventFromLogs(logs);

    const mint = await this._extractMintFromTransaction(signature);

    if (!mint) {
      console.warn(`[listener] Could not extract mint from tx ${signature} — skipping.`);
      return;
    }

    this._stats.launchesDetected++;
    this._stats.lastLaunchAt = new Date().toISOString();

    const launch = {
      mint,
      signature,
      name: eventData?.name ?? null,
      symbol: eventData?.symbol ?? null,
      uri: eventData?.uri ?? null,
    };

    console.log(
      `[listener] 🚀 NEW LAUNCH DETECTED: ${launch.symbol ?? 'unknown'} ` +
        `mint=${mint.slice(0, 12)}… tx=${signature.slice(0, 12)}…`
    );

    this.emit('launch', launch);
  }

  async _extractMintFromTransaction(signature) {
    for (let attempt = 1; attempt <= GET_TX_MAX_RETRIES; attempt++) {
      try {
        const tx = await this._connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (!tx) {
          if (attempt < GET_TX_MAX_RETRIES) {
            await sleep(GET_TX_RETRY_DELAY_MS);
            continue;
          }
          return null;
        }

        return this._parseMintFromTx(tx);
      } catch (err) {
        const errMsg = err?.message || String(err);
        const isRateLimit = errMsg.includes('429') || errMsg.toLowerCase().includes('too many requests');

        if (attempt < GET_TX_MAX_RETRIES) {
          const delay = isRateLimit ? GET_TX_RETRY_DELAY_MS * Math.pow(2, attempt) : GET_TX_RETRY_DELAY_MS;
          await sleep(delay);
        } else {
          throw err;
        }
      }
    }
    return null;
  }

  _parseMintFromTx(tx) {
    const message = tx.transaction.message;

    let accountKeys;
    if (message.accountKeys) {
      accountKeys = message.accountKeys.map((k) =>
        typeof k === 'string' ? k : k.pubkey?.toBase58?.() ?? k.toBase58?.() ?? String(k)
      );
    } else if (message.staticAccountKeys) {
      accountKeys = message.staticAccountKeys.map((k) =>
        typeof k === 'string' ? k : k.toBase58?.() ?? String(k)
      );
      if (tx.meta?.loadedAddresses) {
        const writable = (tx.meta.loadedAddresses.writable || []).map((k) =>
          typeof k === 'string' ? k : k.toBase58?.() ?? String(k)
        );
        const readonly = (tx.meta.loadedAddresses.readonly || []).map((k) =>
          typeof k === 'string' ? k : k.toBase58?.() ?? String(k)
        );
        accountKeys = [...accountKeys, ...writable, ...readonly];
      }
    } else {
      console.warn('[listener] Unknown transaction message format.');
      return null;
    }

    // Collect all instructions (top-level and inner CPI instructions)
    const allInstructions = [];

    const topInstructions = message.compiledInstructions ?? message.instructions ?? [];
    for (const ix of topInstructions) {
      allInstructions.push(ix);
    }

    if (tx.meta?.innerInstructions) {
      for (const innerGroup of tx.meta.innerInstructions) {
        if (innerGroup.instructions) {
          for (const ix of innerGroup.instructions) {
            allInstructions.push(ix);
          }
        }
      }
    }

    for (const ix of allInstructions) {
      const programIdx = ix.programIdIndex;
      const programId = accountKeys[programIdx];

      if (programId !== PUMPFUN_PROGRAM_ID) continue;

      const ixAccountIndices = ix.accountKeyIndexes ?? ix.accounts ?? [];
      if (ixAccountIndices.length === 0) continue;

      // In Pump.fun create instruction, mint is index 0
      const mintIdx = ixAccountIndices[0];
      const mint = accountKeys[mintIdx];

      if (mint) {
        return mint;
      }
    }

    console.warn('[listener] Pump.fun instruction found but could not extract mint.');
    return null;
  }

  _addToDedup(signature) {
    this._recentSignatures.add(signature);
    if (this._recentSignatures.size > DEDUP_SET_MAX_SIZE) {
      const entries = [...this._recentSignatures];
      this._recentSignatures = new Set(entries.slice(entries.length - Math.floor(DEDUP_SET_MAX_SIZE / 2)));
    }
  }
}
