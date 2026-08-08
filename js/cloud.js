// Cross-device copy of the crate, kept on this app's own storage.
//
// This exists for one reason: a first sync on a new device is ~700 Spotify
// requests and lands straight in the rate limit, while pulling the same data
// from here is one. Spotify remains the source of truth; this is a shortcut.

import { getAccessToken } from './auth.js';

const ENDPOINT = '/api/crate';

async function authed(method, body) {
  const token = await getAccessToken();
  return fetch(ENDPOINT, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });
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
  const res = await authed('PUT', payload);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail && detail.error) || `Upload failed (${res.status}).`);
  }
  return res.json();
}

// Returns null when this account has never pushed, which is not an error.
export async function pull() {
  const res = await authed('GET');
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail && detail.error) || `Download failed (${res.status}).`);
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.playlists)) throw new Error('The stored crate looks corrupt.');
  return data;
}
