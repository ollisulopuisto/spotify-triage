// Cross-device copy of the crate, kept on this app's own storage.
//
// This exists for one reason: a first sync on a new device is ~700 Spotify
// requests and lands straight in the rate limit, while pulling the same data
// from here is one. Spotify remains the source of truth; this is a shortcut.

import { getAccessToken } from './auth.js';

const ENDPOINT = '/api/crate';
const LS_PASS = 'crate.cloudPass';

// The server mints a pass after verifying us with Spotify once. Keeping it
// means later calls need no Spotify round trip — which matters precisely when
// Spotify is rate-limiting, since that is when the copy is most useful.
async function authed(method, body, query = '') {
  const pass = localStorage.getItem(LS_PASS);
  const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}) };
  if (pass) headers['X-Crate-Pass'] = pass;

  // Only reach for a token when there is no pass: refreshing one can itself
  // fail while rate-limited.
  if (!pass) headers.Authorization = `Bearer ${await getAccessToken()}`;

  const res = await fetch(ENDPOINT + query, { method, headers, body });

  const minted = res.headers.get('X-Crate-Pass');
  if (minted) localStorage.setItem(LS_PASS, minted);
  // A rejected pass is stale: drop it so the next attempt re-verifies.
  if (res.status === 401 && pass) localStorage.removeItem(LS_PASS);

  return res;
}

// The whole crate, in the shape loadCache() expects to find in IndexedDB.
export function snapshotOf(playlists, selectedIds, lastSync) {
  return JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    lastSync: lastSync || null,
    selectedPlaylistIds: [...(selectedIds || [])],
    playlists,
  });
}

export async function push(payload) {
  let res = await authed('PUT', payload);
  // One retry after a stale pass was discarded, this time with a token.
  if (res.status === 401) res = await authed('PUT', payload);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail && detail.error) || `Upload failed (${res.status}).`);
  }
  return res.json();
}

// When the stored copy was last written, or null if there is none. Cheap: no
// payload comes back.
export async function storedAt() {
  const res = await authed('GET', null, '?meta=1');
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return (data && data.uploadedAt) || null;
}

// Returns null when this account has never pushed, which is not an error.
export async function pull() {
  let res = await authed('GET');
  if (res.status === 401) res = await authed('GET');
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail && detail.error) || `Download failed (${res.status}).`);
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.playlists)) throw new Error('The stored crate looks corrupt.');
  return data;
}
