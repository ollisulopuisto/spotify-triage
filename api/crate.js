// Cross-device storage for a synced crate.
//
// Identity comes from Spotify, but only once. Verifying every request against
// Spotify /me created a deadlock: when the account is rate-limited, /me answers
// 429 too, so the one path that exists to avoid Spotify's rate limit was itself
// blocked by it. So the first successful verification mints a pass of our own,
// signed with a server secret, and later requests present that instead.
//
// The payload is stored as-is: a private blob reachable only through this
// function, not encrypted at rest — as the setup page says.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { put, head } from '@vercel/blob';

const SPOTIFY_ME = 'https://api.spotify.com/v1/me';
// A crate of ~35k tracks is around 7MB of JSON. Leave room, refuse the absurd.
const MAX_BYTES = 32 * 1024 * 1024;
const PASS_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

function sign(payload) {
  const secret = process.env.CRATE_SIGNING_SECRET;
  if (!secret) throw new Error('CRATE_SIGNING_SECRET is not configured');
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function mintPass(userId) {
  const body = `${b64(userId)}.${Date.now() + PASS_TTL_MS}`;
  return `${body}.${sign(body)}`;
}

// Returns the user id a pass belongs to, or null if it is forged or expired.
function readPass(pass) {
  const parts = String(pass || '').split('.');
  if (parts.length !== 3) return null;

  const [rawId, expires, mac] = parts;
  const expected = sign(`${rawId}.${expires}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!Number(expires) || Number(expires) < Date.now()) return null;

  return Buffer.from(rawId, 'base64url').toString('utf8');
}

// Ask Spotify who holds this token. `rateLimited` is reported separately from
// "invalid", because telling someone to sign in again during a 429 is a lie.
async function askSpotify(auth) {
  const r = await fetch(SPOTIFY_ME, { headers: { Authorization: auth } });
  if (r.status === 429) return { rateLimited: true };
  if (!r.ok) return {};
  const me = await r.json().catch(() => null);
  return me && me.id ? { userId: String(me.id) } : {};
}

// One file per account. The id is already unique; keep the path debuggable.
const pathFor = (userId) => `crates/${encodeURIComponent(userId)}.json`;

// A few bytes alongside the crate, holding what the crate itself would cost
// megabytes to answer: how much is in there. Without it the only comparable
// fact about a stored copy is its size, and "1.1 MB" against "41 140 tracks"
// is not a choice anyone can make.
const sidecarFor = (userId) => `crates/${encodeURIComponent(userId)}.meta.json`;

// Counts come from the client because the server would otherwise have to parse
// several megabytes of JSON to learn them. They are descriptive, not load
// bearing: nothing is authorised or overwritten on their say-so.
function countsFrom(headers) {
  const read = (name) => {
    const raw = headers[name];
    // Number('') is 0, and storing 0 for "did not say" is exactly the lie the
    // sidecar exists to avoid.
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  return { tracks: read('x-crate-tracks'), playlists: read('x-crate-playlists') };
}

// Ask Spotify how long a lockout has left. Browsers cannot read Retry-After
// (Spotify sends no Access-Control-Expose-Headers), but a server can — so the
// one number that matters during a rate limit stops being invisible.
//
// Probe the endpoint the app is actually blocked on. /me kept answering while
// /me/playlists was refused, so testing /me reported "all clear" during a
// lockout — worse than not checking.
const SPOTIFY_PROBE = 'https://api.spotify.com/v1/me/playlists?limit=1';

// Copies written before the sidecar existed have none, so every failure here
// is ordinary: say "unknown" rather than treating it as an error.
async function readSidecar(pathname) {
  try {
    const meta = await head(pathname);
    const r = await fetch(meta.downloadUrl || meta.url);
    if (!r.ok) return { tracks: null, playlists: null };
    const data = await r.json();
    return { tracks: data.tracks ?? null, playlists: data.playlists ?? null };
  } catch {
    return { tracks: null, playlists: null };
  }
}

async function probe(auth) {
  const r = await fetch(SPOTIFY_PROBE, { headers: { Authorization: auth } });
  if (r.status !== 429) return { ok: r.ok, status: r.status };

  const seconds = Number(r.headers.get('Retry-After') || 0);
  return {
    ok: false,
    status: 429,
    retryAfterSeconds: seconds || null,
    retryAt: seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null,
  };
}

export default async function handler(req, res) {
  if ('probe' in (req.query || {})) {
    const auth = req.headers.authorization || '';
    if (!/^Bearer \S+$/.test(auth)) return json(res, 401, { error: 'No token to test with.' });
    return json(res, 200, await probe(auth));
  }

  let userId = readPass(req.headers['x-crate-pass']);
  let freshPass = null;

  if (!userId) {
    const auth = req.headers.authorization || '';
    if (!/^Bearer \S+$/.test(auth)) {
      return json(res, 401, { error: 'Sign in to Spotify first.' });
    }

    const asked = await askSpotify(auth);
    if (asked.rateLimited) {
      return json(res, 503, {
        error: 'Spotify is rate-limiting this app, so your identity cannot be confirmed'
          + ' right now. Try again once it clears.',
      });
    }
    if (!asked.userId) return json(res, 401, { error: 'That Spotify token is not valid.' });

    userId = asked.userId;
    // Hand back a pass so the next call does not need Spotify at all.
    freshPass = mintPass(userId);
  }

  if (freshPass) res.setHeader('X-Crate-Pass', freshPass);
  res.setHeader('Access-Control-Expose-Headers', 'X-Crate-Pass');

  const pathname = pathFor(userId);

  if (req.method === 'GET' && 'meta' in (req.query || {})) {
    // Enough to tell whether the stored copy is newer than what this device
    // holds, and how much is in it, without shipping several megabytes.
    try {
      const meta = await head(pathname);
      const counts = await readSidecar(sidecarFor(userId));
      return json(res, 200, {
        uploadedAt: meta.uploadedAt || null,
        bytes: meta.size || 0,
        // null, not 0, when a copy predates the sidecar: the client has to be
        // able to tell "no tracks" from "we do not know".
        tracks: counts.tracks,
        playlists: counts.playlists,
      });
    } catch {
      return json(res, 404, { error: 'No crate stored yet.' });
    }
  }

  if (req.method === 'GET') {
    try {
      // Private blobs are not publicly readable, so fetch through the store.
      const meta = await head(pathname);
      const r = await fetch(meta.downloadUrl || meta.url);
      if (!r.ok) return json(res, 502, { error: 'The stored crate could not be read.' });
      const body = await r.text();
      res.status(200).setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(body);
    } catch {
      // head() throws when the blob does not exist: a first-time account.
      return json(res, 404, { error: 'No crate stored yet.' });
    }
  }

  if (req.method === 'PUT') {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (!body || body.length < 2) return json(res, 400, { error: 'Empty payload.' });
    if (body.length > MAX_BYTES) return json(res, 413, { error: 'Crate too large.' });

    const saved = await put(pathname, body, {
      access: 'private',
      contentType: 'application/json',
      // One file per user, overwritten in place, rather than a pile of copies.
      addRandomSuffix: false,
      allowOverwrite: true,
    });

    // After the crate, and never instead of it: a failed sidecar leaves the
    // copy readable and merely undescribed, which is where we started.
    const counts = countsFrom(req.headers);
    try {
      await put(sidecarFor(userId), JSON.stringify({ ...counts, bytes: body.length }), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    } catch {
      // Nothing to tell the client: the upload it asked for did happen.
    }

    return json(res, 200, { ok: true, bytes: body.length, updatedAt: saved.uploadedAt || null });
  }

  res.setHeader('Allow', 'GET, PUT');
  return json(res, 405, { error: 'Use GET or PUT.' });
}
