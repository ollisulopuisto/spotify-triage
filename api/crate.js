// Cross-device storage for a synced crate.
//
// Identity comes from Spotify, not from us: the caller presents the same access
// token the browser already holds, we ask Spotify who it belongs to, and that
// answer picks the file. There are no accounts, passwords or sessions here, and
// a token for one account can never reach another account's data.
//
// The payload is stored as-is. It is a private blob reachable only through this
// function, but it is not encrypted at rest — see the note on the setup page.

import { put, head } from '@vercel/blob';

const SPOTIFY_ME = 'https://api.spotify.com/v1/me';
// A crate of ~35k tracks is around 7MB of JSON. Leave room, refuse the absurd.
const MAX_BYTES = 32 * 1024 * 1024;

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

// Resolve the bearer token to a Spotify user id, or null.
async function whoIs(req) {
  const auth = req.headers.authorization || '';
  if (!/^Bearer \S+$/.test(auth)) return null;

  const r = await fetch(SPOTIFY_ME, { headers: { Authorization: auth } });
  if (!r.ok) return null;
  const me = await r.json().catch(() => null);
  return me && me.id ? String(me.id) : null;
}

// One file per account. The id is already unique and opaque enough; keep the
// path boring so it stays debuggable.
const pathFor = (userId) => `crates/${encodeURIComponent(userId)}.json`;

export default async function handler(req, res) {
  const userId = await whoIs(req);
  if (!userId) {
    return json(res, 401, { error: 'Sign in to Spotify first — that token is not valid.' });
  }

  const pathname = pathFor(userId);

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
      // head() throws when the blob does not exist yet: a first-time device.
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
    return json(res, 200, { ok: true, bytes: body.length, updatedAt: saved.uploadedAt || null });
  }

  res.setHeader('Allow', 'GET, PUT');
  return json(res, 405, { error: 'Use GET or PUT.' });
}
