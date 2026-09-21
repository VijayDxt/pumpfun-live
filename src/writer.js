/**
 * writer.js
 *
 * Writes detected token launches to Firestore.
 * Has NO HTTP/fetch dependency — pure Firestore-writing logic.
 * Connects directly to the specific named Firestore database instance.
 *
 * Collection: live_launches
 * Document ID: mint address
 * Fields: mint, detectedAt, mintAuthorityRevoked, freezeAuthorityRevoked,
 *         name (if available), symbol (if available)
 */

'use strict';

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_DATABASE_ID } from './config.js';

// ---------------------------------------------------------------------------
// Firebase Admin initialisation (idempotent — safe to import multiple times)
// ---------------------------------------------------------------------------

let _db = null;

function normalizePrivateKey(key) {
  if (!key) return key;
  let str = String(key).replace(/\\n/g, '\n').replace(/\r/g, '');
  const header = '-----BEGIN PRIVATE KEY-----';
  const footer = '-----END PRIVATE KEY-----';
  if (str.includes(header) && str.includes(footer)) {
    const body = str
      .substring(str.indexOf(header) + header.length, str.indexOf(footer))
      .replace(/\s+/g, '');
    const lines = body.match(/.{1,64}/g) || [];
    return header + '\n' + lines.join('\n') + '\n' + footer + '\n';
  }
  return str;
}

function getDb() {
  if (_db) return _db;

  if (getApps().length === 0) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = normalizePrivateKey(serviceAccount.private_key);
      }
    } catch (err) {
      throw new Error(
        `[writer] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON. ` +
          `Make sure the env var contains the raw JSON string (not a file path).\n${err.message}`
      );
    }

    initializeApp({ credential: cert(serviceAccount) });
    console.log('[writer] Firebase Admin initialised.');
  }

  // Target the specific named Firestore database instance
  _db = getFirestore(FIREBASE_DATABASE_ID);
  return _db;
}

// ---------------------------------------------------------------------------
// Firestore schema
//
// Collection: live_launches
// Document ID: mint address
// Fields: mint, detectedAt, mintAuthorityRevoked, freezeAuthorityRevoked,
//         name (optional), symbol (optional)
// ---------------------------------------------------------------------------

const COLLECTION = 'live_launches';

/**
 * Writes a single detected launch to Firestore.
 *
 * @param {{
 *   mint: string,
 *   mintAuthorityRevoked: boolean,
 *   freezeAuthorityRevoked: boolean,
 *   name?: string | null,
 *   symbol?: string | null,
 * }} launch
 * @returns {Promise<void>}
 */
export async function writeLaunch(launch) {
  const db = getDb();
  const docRef = db.collection(COLLECTION).doc(launch.mint);

  const data = {
    mint: launch.mint,
    detectedAt: FieldValue.serverTimestamp(),
    mintAuthorityRevoked: launch.mintAuthorityRevoked,
    freezeAuthorityRevoked: launch.freezeAuthorityRevoked,
  };

  // Only include name/symbol if genuinely available from the create tx
  if (launch.name != null && launch.name !== '') {
    data.name = launch.name;
  }
  if (launch.symbol != null && launch.symbol !== '') {
    data.symbol = launch.symbol;
  }

  await docRef.set(data, { merge: true });
  console.log(`[writer] ✓ Written to Firestore/${COLLECTION}: ${launch.mint}`);
}
