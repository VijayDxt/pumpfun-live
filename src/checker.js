/**
 * checker.js
 *
 * On-chain safety checks for a token mint address.
 * Uses direct Solana RPC via @solana/spl-token to check:
 *   - Mint authority status (revoked or active)
 *   - Freeze authority status (revoked or active)
 *
 * Automatically detects whether the token uses standard TOKEN_PROGRAM_ID
 * or TOKEN_2022_PROGRAM_ID.
 *
 * No LP/liquidity check — Pump.fun tokens at creation are pre-migration
 * bonding-curve tokens with no DEX pool, so that check doesn't apply.
 */

'use strict';

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { HELIUS_RPC_URL } from './config.js';

// ---------------------------------------------------------------------------
// Shared connection (reused across all checks)
// ---------------------------------------------------------------------------

const connection = new Connection(HELIUS_RPC_URL, 'confirmed');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Exported function
// ---------------------------------------------------------------------------

/**
 * Checks the mint and freeze authority status for a given token mint.
 * Retries up to `maxRetries` times with a delay to handle newly created mint accounts.
 *
 * @param {string} mintAddress — base58-encoded mint address
 * @param {number} [maxRetries=4]
 * @param {number} [retryDelayMs=800]
 * @returns {Promise<{ mintAuthorityRevoked: boolean, freezeAuthorityRevoked: boolean }>}
 *
 * On error, returns conservative defaults (both false = flagged as risky)
 * rather than silently assuming the token is safe.
 */
export async function checkMint(mintAddress, maxRetries = 6, retryDelayMs = 1000) {
  let mintPubkey;
  try {
    mintPubkey = new PublicKey(mintAddress);
  } catch (err) {
    console.warn(`[checker] Invalid mint address ${mintAddress}: ${err.message}`);
    return { mintAuthorityRevoked: false, freezeAuthorityRevoked: false };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const accountInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
      if (!accountInfo) {
        if (attempt < maxRetries) {
          await sleep(retryDelayMs);
          continue;
        }
        break;
      }

      // Ensure the account is actually an SPL Token mint
      const isTokenLegacy = accountInfo.owner.equals(TOKEN_PROGRAM_ID);
      const isToken2022 = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);

      if (!isTokenLegacy && !isToken2022) {
        // Not a token mint account
        return { mintAuthorityRevoked: false, freezeAuthorityRevoked: false };
      }

      const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const mintInfo = await getMint(connection, mintPubkey, 'confirmed', programId);

      const mintAuthorityRevoked = mintInfo.mintAuthority === null;
      const freezeAuthorityRevoked = mintInfo.freezeAuthority === null;

      return { mintAuthorityRevoked, freezeAuthorityRevoked };
    } catch (err) {
      const errMsg = err?.message || String(err);
      const isRateLimit = errMsg.includes('429') || errMsg.toLowerCase().includes('too many requests');

      if (attempt < maxRetries) {
        const delay = isRateLimit ? retryDelayMs * Math.pow(2, attempt) : retryDelayMs;
        await sleep(delay);
      } else {
        console.warn(
          `[checker] Failed to check mint ${mintAddress} after ${maxRetries} attempts: ${errMsg}. ` +
            `Defaulting to risky (not revoked).`
        );
      }
    }
  }

  return { mintAuthorityRevoked: false, freezeAuthorityRevoked: false };
}
