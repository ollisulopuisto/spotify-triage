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

// Cancel has to reach inside the waits and the pagination loops, not just sit
// in a flag the caller checks between playlists.
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

let cancelled = false;
export function cancelInFlight() {
  cancelled = true;
}
export function resetCancel() {
  cancelled = false;
}
function throwIfCancelled() {
  if (cancelled) throw new CancelledError();
}

// Count down out loud, one second at a time, and give up the moment the user
// asks — a 60s wait you cannot interrupt is indistinguishable from a freeze.
async function waitOut(seconds) {
  for (let left = seconds; left > 0; left -= 1) {
    throwIfCancelled();
    if (onWait) onWait(left);
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  throwIfCancelled();
  if (onWait) onWait(0);
}

export class SpotifyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Spotify sends no Access-Control-Expose-Headers, so a browser cannot read
// Retry-After off a 429 no matter what the docs say — res.headers.get() always
// returns null cross-origin. Backing off on our own schedule is the only
// option, and retrying too eagerly is what keeps a penalty alive.
const BACKOFF_SECONDS = [5, 20, 60];
// Once the escalation is spent, stop trying at all for a while. Real penalties
// run to hours — one observed Retry-After was 9396s — and every probe risks
// refreshing the clock, so consecutive lockouts back off hard.
const COOLDOWN_STEPS = [300, 900, 2700, 7200];
const LS_COOLDOWN = 'crate.cooldownUntil';
const LS_LOCKOUTS = 'crate.lockouts';

// After a 429 every later request is paced, and the gap decays once things are
// healthy again. This is what stops a 180-playlist sync from re-triggering the
// limit two requests after recovering.
let gapMs = 0;
let cleanRun = 0;

function easeOff() {
  gapMs = Math.min(gapMs * 2 + 250, 2000);
  cleanRun = 0;
}

function easeOn() {
  cleanRun += 1;
  if (gapMs && cleanRun >= 40) {
    gapMs = Math.floor(gapMs / 2);
    cleanRun = 0;
  }
}

// Remembered across reloads: retrying during a penalty is what extends it.
export function cooldownRemaining() {
  const until = Number(localStorage.getItem(LS_COOLDOWN) || 0);
  const left = Math.ceil((until - Date.now()) / 1000);
  return left > 0 ? left : 0;
}

function startCooldown(seconds) {
  localStorage.setItem(LS_COOLDOWN, String(Date.now() + seconds * 1000));
}

export function clearCooldown() {
  localStorage.removeItem(LS_COOLDOWN);
  localStorage.removeItem(LS_LOCKOUTS);
}

// Each lockout that happens without a success in between waits longer.
function nextCooldownSeconds() {
  const n = Number(localStorage.getItem(LS_LOCKOUTS) || 0);
  localStorage.setItem(LS_LOCKOUTS, String(n + 1));
  return COOLDOWN_STEPS[Math.min(n, COOLDOWN_STEPS.length - 1)];
}

export function describeDuration(seconds) {
  if (seconds < 90) return `${seconds} seconds`;
  const mins = Math.round(seconds / 60);
  if (mins < 90) return `${mins} minutes`;
  return `${Math.round(mins / 60)} hours`;
}

async function request(path, {
  method = 'GET', body = null, retriedAuth = false, attempt = 0, rateAttempt = 0, resuming = false,
} = {}) {
  // A chain that has already served its wait is allowed through: the cooldown
  // exists to stop *new* work starting, not to strand a retry mid-flight.
  const held = resuming ? 0 : cooldownRemaining();
  if (held) {
    throw new SpotifyError(429, `Spotify is rate-limiting this app for another ${describeDuration(held)}`);
  }

  throwIfCancelled();
  if (gapMs) await sleep(gapMs);
  throwIfCancelled();

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
    easeOff();
    // Retry-After is unreadable cross-origin, so it is only ever a bonus.
    const stated = Number(res.headers.get('Retry-After') || 0);
    const step = BACKOFF_SECONDS[rateAttempt];
    const wait = Math.max(stated, step || 0) + Math.round(Math.random() * 3);

    console.warn(
      `[crate] 429 #${rateAttempt + 1}, Retry-After=${stated || 'unreadable'},`
      + ` pacing ${gapMs}ms, waiting ${wait}s`,
      url.replace(BASE, '').split('?')[0],
    );

    // Record the hold-off on the *first* 429, not just the last: a reload
    // mid-backoff would otherwise start firing requests again immediately,
    // which is what keeps a penalty alive.
    startCooldown(Math.max(wait, stated));

    if (!step) {
      // Escalation spent. Refuse further calls for a while so a reload or an
      // impatient second click cannot dig the hole deeper.
      const hold = Math.max(nextCooldownSeconds(), stated);
      startCooldown(hold);
      throw new SpotifyError(
        429,
        'Spotify is rate-limiting this app. Nothing is broken — it clears on its own,'
        + ' but it can take hours, and retrying makes it last longer.'
        + ` Try again in ${describeDuration(hold)}.`,
      );
    }

    await waitOut(wait);
    return request(path, {
      method, body, retriedAuth, attempt, rateAttempt: rateAttempt + 1, resuming: true,
    });
  }

  easeOn();
  if (res.ok) clearCooldown();

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
    throwIfCancelled();
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
