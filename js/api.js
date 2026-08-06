// Thin Spotify Web API client: auth headers, 429 backoff, 401 refresh-and-retry,
// and cursor pagination.

import { getAccessToken } from './auth.js';

const BASE = 'https://api.spotify.com/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A silent backoff is indistinguishable from a hang, so the UI gets to narrate
// it. Set by main.js; a no-op everywhere else (tests, future callers).
let onWait = null;
export function setWaitReporter(fn) {
  onWait = fn;
}

// Count down out loud, one second at a time.
async function waitOut(seconds) {
  for (let left = seconds; left > 0; left -= 1) {
    if (onWait) onWait(left);
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  if (onWait) onWait(0);
}

export class SpotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body = null, retriedAuth = false, attempt = 0 } = {}) {
  const token = await getAccessToken({ force: retriedAuth });
  const url = path.startsWith('http') ? path : BASE + path;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !retriedAuth) {
    return request(path, { method, body, retriedAuth: true, attempt });
  }

  if (res.status === 429) {
    // Spotify tells us exactly how long to wait; honour it rather than guessing.
    const wait = Number(res.headers.get('Retry-After') || 2) + 1;
    console.warn(`[crate] rate-limited, waiting ${wait}s before retrying`, url.replace(BASE, ''));
    await waitOut(wait);
    return request(path, { method, body, retriedAuth, attempt });
  }

  if (res.status >= 500 && attempt < 3) {
    await sleep(2 ** attempt * 1000);
    return request(path, { method, body, retriedAuth, attempt: attempt + 1 });
  }

  if (res.status === 204 || res.headers.get('Content-Length') === '0') return null;

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const message = (data && data.error && (data.error.message || data.error)) || res.statusText;
    // Spotify's failure bodies are terse and the browser only logs a bare
    // status line, so surface the whole thing for anyone reading the console.
    // Stringify: the console collapses objects to {…} and the body is the
    // only part of a Spotify failure that ever explains itself.
    console.error(
      '[crate]', res.status, method, url.replace(BASE, '').split('?')[0],
      'body=', JSON.stringify(data),
      'wwwAuth=', res.headers.get('WWW-Authenticate'),
    );
    throw new SpotifyError(res.status, String(message));
  }

  return data;
}

// Walk a paged endpoint to exhaustion, reporting progress as it goes.
async function paged(path, onPage) {
  let next = path;
  const out = [];
  while (next) {
    // eslint-disable-next-line no-await-in-loop
    const page = await request(next);
    if (!page) break;
    out.push(...(page.items || []));
    if (onPage) onPage(out.length, page.total);
    next = page.next;
  }
  return out;
}

export const api = {
  me() {
    return request('/me');
  },

  // The user's own playlists, plus those they follow.
  async myPlaylists(onProgress) {
    const items = await paged('/me/playlists?limit=50', onProgress);
    return items.filter(Boolean).map((p) => ({
      id: p.id,
      name: p.name,
      snapshotId: p.snapshot_id,
      total: p.tracks ? p.tracks.total : 0,
      owner: p.owner ? p.owner.display_name || p.owner.id : '',
      ownerId: p.owner ? p.owner.id : '',
      image: p.images && p.images.length ? p.images[p.images.length - 1].url : null,
      url: p.external_urls ? p.external_urls.spotify : null,
    }));
  },

  // `fields` trims the response hard — with ~180 playlists this is the
  // difference between a few MB and a few tens of MB over the wire.
  async playlistTracks(playlistId, onProgress) {
    const fields = [
      'next',
      'total',
      'items(added_at,is_local,item(id,uri,name,duration_ms,popularity,'
        + 'artists(id,name),album(id,name,release_date,images)))',
    ].join(',');

    // /items replaced /tracks in the March 2026 migration, and it caps limit
    // at 50 where the old endpoint allowed 100.
    let items;
    try {
      items = await paged(
        `/playlists/${playlistId}/items?limit=50&fields=${encodeURIComponent(fields)}`,
        onProgress,
      );
    } catch (err) {
      if (!(err instanceof SpotifyError) || err.status !== 403) throw err;
      console.warn('[crate] filtered read refused, retrying unfiltered:', playlistId);
      items = await paged(`/playlists/${playlistId}/items?limit=50`, onProgress);
      console.warn('[crate] unfiltered read succeeded:', playlistId);
    }

    return items
      // `item` is the current key; `track` is the deprecated alias still sent
      // by unfiltered responses.
      .map((it) => (it && !it.item && it.track ? { ...it, item: it.track } : it))
      .filter((it) => it && it.item && it.item.id && !it.is_local)
      .map((it) => {
        const t = it.item;
        const album = t.album || {};
        const images = album.images || [];
        return {
          id: t.id,
          uri: t.uri,
          name: t.name,
          durationMs: t.duration_ms || 0,
          popularity: typeof t.popularity === 'number' ? t.popularity : null,
          artists: (t.artists || []).map((a) => ({ id: a.id, name: a.name })),
          albumId: album.id || null,
          albumName: album.name || '',
          releaseDate: album.release_date || '',
          albumImage: images.length ? images[images.length - 1].url : null,
          addedAt: it.added_at || null,
        };
      });
  },

  // The per-user path was retired along with /tracks; creation now hangs off
  // the authenticated user directly.
  createPlaylist(userId, { name, description, isPublic }) {
    return request('/me/playlists', {
      method: 'POST',
      body: { name, description, public: Boolean(isPublic) },
    });
  },

  // --- Spotify Connect ------------------------------------------------------

  async devices() {
    const data = await request('/me/player/devices');
    return ((data && data.devices) || []).map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      isActive: Boolean(d.is_active),
    }));
  },

  // Replaces whatever is playing. The URI list *is* the queue, so passing the
  // whole result set is what makes a search play through.
  play(uris, deviceId) {
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    return request(`/me/player/play${query}`, { method: 'PUT', body: { uris } });
  },

  // Appends without interrupting. One request per track is the only shape
  // Spotify offers, so callers keep the list short.
  async queue(uris, deviceId, onProgress) {
    for (let i = 0; i < uris.length; i += 1) {
      const params = new URLSearchParams({ uri: uris[i] });
      if (deviceId) params.set('device_id', deviceId);
      // eslint-disable-next-line no-await-in-loop
      await request(`/me/player/queue?${params}`, { method: 'POST' });
      if (onProgress) onProgress(i + 1, uris.length);
    }
  },

  async addTracks(playlistId, uris, onProgress) {
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      // eslint-disable-next-line no-await-in-loop
      await request(`/playlists/${playlistId}/items`, { method: 'POST', body: { uris: batch } });
      if (onProgress) onProgress(Math.min(i + batch.length, uris.length), uris.length);
    }
  },
};
