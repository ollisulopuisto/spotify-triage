// Drives the real sync path against a mocked Spotify Web API: pagination,
// incremental snapshot_id refetching, and export.
//
//   node --test spotify-crate/tests/sync.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765';

// --- fake Spotify ----------------------------------------------------------

// An inline 1x1 gif: real album art would leave the browser and fail.
const COVER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function makeTrack(n, albumIdx) {
  return {
    id: `tr${n}`,
    uri: `spotify:track:tr${n}`,
    name: `Track ${n}`,
    duration_ms: 200000,
    popularity: 50,
    artists: [{ id: `ar${albumIdx}`, name: `Artist ${albumIdx}` }],
    album: {
      id: `alb${albumIdx}`,
      name: `Album ${albumIdx}`,
      release_date: `${1990 + albumIdx}-05-01`,
      images: [{ url: COVER, width: 64, height: 64 }],
    },
  };
}

const server = {
  // p1 holds 150 tracks so the tracks endpoint has to paginate.
  playlists: [
    { id: 'p1', name: 'Kuukausi 2019-01', snapshot: 'a1', count: 150 },
    { id: 'p2', name: 'Kuukausi 2019-02', snapshot: 'b1', count: 10 },
    { id: 'p3', name: 'Not a monthly list', snapshot: 'c1', count: 5 },
  ],
  // Playlist IDs Spotify refuses to serve tracks for (editorial/algorithmic
  // lists 403 for apps in development mode).
  forbidden: new Set(),
  // Playlist IDs that 403 only when the request carries a `fields` filter.
  forbiddenWithFields: new Set(),
  rateLimitOnce: false,
  spotifyIdentityDown: false,  // Spotify 429s even /me
  probeAnswer: { ok: true, status: 200 },
  rateLimitTracks: false,
  rateLimitTimes: 0,      // 429 this many more catalog reads
  rateLimitRetryAfter: 2, // what the header says
  devices: [
    { id: 'dev1', name: 'Olli’s MacBook', type: 'Computer', is_active: true },
    { id: 'dev2', name: 'Kitchen speaker', type: 'Speaker', is_active: false },
  ],
  counters: {
    catalog: 0,
    trackPages: 0,
    trackFetchesByPlaylist: {},
    created: [],
    added: [],
    played: [],
    queued: [],
    stamps: [],
    cloudPuts: [],
    refusedPlaylists: new Set(),
  },
};

// The progress modal may open and close faster than a poll can see, so wait on
// the banner sync() writes when it finishes.
function waitForSync(page) {
  return page.waitForFunction(() => {
    const b = document.getElementById('banner');
    return !b.hidden && /Synced|Created|cancelled/.test(b.textContent);
  }, null, { timeout: 20000 });
}

function clearBanner(page) {
  return page.evaluate(() => {
    const b = document.getElementById('banner');
    b.hidden = true;
    // Leaving stale text behind has fooled three tests into passing instantly.
    b.textContent = '';
  });
}

function resetCounters() {
  server.counters.catalog = 0;
  server.counters.trackPages = 0;
  server.counters.trackFetchesByPlaylist = {};
  server.counters.refusedPlaylists = new Set();
}

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });
}

let cloudStore = null;
let cloudUploadedAt = null;
// What the sidecar holds about the stored copy. null means a crate saved
// before the sidecar existed, which the real endpoint still has to describe.
let cloudCounts = { tracks: null, playlists: null };

// Mirrors the real endpoint: a Spotify token buys a pass, and the pass alone
// is enough afterwards — including while Spotify is rate-limiting.
async function installCloudMock(page) {
  // The glob must allow a query string: ?meta=1 would otherwise slip past.
  await page.route('**/api/crate*', async (route) => {
    const method = route.request().method();
    const headers = route.request().headers();
    const hasPass = headers['x-crate-pass'] === 'test-pass';
    const hasToken = /^Bearer \S+/.test(headers.authorization || '');

    if (!hasPass && !hasToken) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    }
    if (!hasPass && server.spotifyIdentityDown) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'identity unavailable' }),
      });
    }
    const mint = hasPass ? {} : {
      'X-Crate-Pass': 'test-pass',
      'Access-Control-Expose-Headers': 'X-Crate-Pass',
    };
    if (method === 'PUT') {
      cloudStore = route.request().postData();
      cloudUploadedAt = new Date().toISOString();
      const count = (name) => {
        const raw = headers[name];
        if (raw === undefined || String(raw).trim() === '') return null;
        const n = Number(raw);
        return Number.isInteger(n) && n >= 0 ? n : null;
      };
      cloudCounts = { tracks: count('x-crate-tracks'), playlists: count('x-crate-playlists') };
      server.counters.cloudPuts.push(cloudStore.length);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: mint,
        body: JSON.stringify({ ok: true, bytes: cloudStore.length }),
      });
    }
    if (new URL(route.request().url()).searchParams.has('probe')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(server.probeAnswer),
      });
    }
    if (new URL(route.request().url()).searchParams.has('meta')) {
      if (!cloudStore) {
        return route.fulfill({ status: 404, contentType: 'application/json', headers: mint, body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: mint,
        body: JSON.stringify({
          uploadedAt: cloudUploadedAt,
          bytes: cloudStore.length,
          tracks: cloudCounts.tracks,
          playlists: cloudCounts.playlists,
        }),
      });
    }
    if (!cloudStore) {
      return route.fulfill({ status: 404, contentType: 'application/json', headers: mint, body: '{}' });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: mint, body: cloudStore,
    });
  });
}

async function installMock(page) {
  await page.route('**://accounts.spotify.com/api/token', (route) => json(route, {
    access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600,
  }));

  await page.route('**://api.spotify.com/**', async (route) => {
    server.counters.stamps.push(Date.now());
    const url = new URL(route.request().url());
    const { pathname } = url;

    if (pathname === '/v1/me') return json(route, { id: 'me', display_name: 'Me' });

    if (pathname === '/v1/me/player/devices') {
      return json(route, { devices: server.devices });
    }

    if (pathname === '/v1/me/player/play' && route.request().method() === 'PUT') {
      server.counters.played.push({
        deviceId: url.searchParams.get('device_id'),
        body: route.request().postDataJSON(),
      });
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    if (pathname === '/v1/me/player/queue' && route.request().method() === 'POST') {
      server.counters.queued.push(url.searchParams.get('uri'));
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    if (pathname === '/v1/me/playlists' && route.request().method() === 'GET') {
      // Rate-limit the next catalog read once, the way Spotify does.
      if (server.rateLimitOnce || server.rateLimitTimes > 0) {
        server.rateLimitOnce = false;
        if (server.rateLimitTimes > 0) server.rateLimitTimes -= 1;
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Retry-After': String(server.rateLimitRetryAfter),
          },
          body: JSON.stringify({ error: { status: 429, message: 'Too Many Requests' } }),
        });
      }
      server.counters.catalog += 1;
      const offset = Number(url.searchParams.get('offset') || 0);
      // Spotify hands back a `next` that points at /users/{id}/playlists, a
      // path the March 2026 migration retired. Page 2 only exists there.
      const page = offset > 0 ? server.playlists.slice(1) : server.playlists.slice(0, 1);
      return json(route, {
        total: server.playlists.length,
        next: offset > 0
          ? null
          : `https://api.spotify.com/v1/users/dst/playlists?offset=1&limit=50`,
        items: page.map((p) => ({
          id: p.id,
          name: p.name,
          snapshot_id: p.snapshot,
          // Post-migration shape: the count moved from `tracks` to `items`.
          items: { total: p.count },
          owner: { id: 'me', display_name: 'Me' },
          images: [],
          external_urls: { spotify: `${BASE_URL}/#${p.id}` },
        })),
      });
    }

    if (/^\/v1\/users\/[^/]+\/playlists$/.test(pathname)) {
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: { status: 403, message: 'Forbidden' } }),
      });
    }

    // The March 2026 migration retired /tracks in favour of /items; the old
    // path answers 403 for everyone now.
    if (/^\/v1\/playlists\/[^/]+\/tracks$/.test(pathname)) {
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: { status: 403, message: 'Forbidden' } }),
      });
    }

    const tracksMatch = pathname.match(/^\/v1\/playlists\/([^/]+)\/items$/);
    if (tracksMatch && route.request().method() === 'GET') {
      const id = tracksMatch[1];
      if (server.forbiddenWithFields.has(id) && url.searchParams.has('fields')) {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { status: 403, message: 'Forbidden' } }),
        });
      }
      if (server.forbidden.has(id)) {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { status: 403, message: 'Forbidden' } }),
        });
      }
      if (server.rateLimitTracks) {
        // Count refusals too, or "did it stop?" cannot be answered.
        server.counters.refusedPlaylists.add(id);
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { status: 429, message: 'Too Many Requests' } }),
        });
      }
      const pl = server.playlists.find((p) => p.id === id);
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);

      server.counters.trackPages += 1;
      const byPl = server.counters.trackFetchesByPlaylist;
      if (offset === 0) byPl[id] = (byPl[id] || 0) + 1;

      // /items caps limit at 50, unlike the old /tracks endpoint's 100.
      if (limit > 50) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { status: 400, message: 'Invalid limit' } }),
        });
      }

      const items = [];
      for (let i = offset; i < Math.min(offset + limit, pl.count); i += 1) {
        items.push({
          added_at: `2019-0${pl.id === 'p1' ? 1 : 2}-1${i % 9}T10:00:00Z`,
          is_local: false,
          // `item` is the current key; `track` is deprecated and absent here.
          item: makeTrack(i, i % 4),
        });
      }
      const nextOffset = offset + limit;
      return json(route, {
        total: pl.count,
        next: nextOffset < pl.count
          ? `https://api.spotify.com/v1/playlists/${id}/items?offset=${nextOffset}&limit=${limit}`
          : null,
        items,
      });
    }

    if (pathname === '/v1/me/playlists' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      server.counters.created.push(body);
      return json(route, {
        id: 'new1', name: body.name, external_urls: { spotify: `${BASE_URL}/#created` },
      });
    }

    if (pathname === '/v1/playlists/new1/items' && route.request().method() === 'POST') {
      server.counters.added.push(route.request().postDataJSON().uris);
      return json(route, { snapshot_id: 'z1' });
    }

    return route.fulfill({ status: 404, body: '{}' });
  });
}

// --- harness ---------------------------------------------------------------

let browser;
let page;
const errors = [];

test.before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // Chromium logs every non-2xx response itself. The forbidden-playlist test
    // induces 403s on purpose, so that line is expected, not a defect.
    // Chromium logs the bare status line and the app logs its own 403 detail;
    // the forbidden-playlist tests induce both deliberately.
    // 404: a device with nothing stored yet asks /api/crate and is told so.
    const expected = /Failed to load resource.*(403|404|429)/.test(m.text())
      || /^\[crate\] 403 /.test(m.text());
    if (m.type() === 'error' && !expected) {
      errors.push(m.text());
    }
  });

  await installMock(page);
  await installCloudMock(page);
  await page.goto(BASE_URL);
  // Signed in, but nothing cached: the app should offer the picker.
  await page.evaluate(() => {
    localStorage.setItem('crate.clientId', 'b'.repeat(32));
    localStorage.setItem('crate.tokens', JSON.stringify({
      accessToken: 'stale', refreshToken: 'refresh', expiresAt: Date.now() - 1000,
    }));
  });
  await page.reload();
});

test.after(async () => { await browser.close(); });

test('an empty crate opens the picker and lists the account playlists', async () => {
  await page.waitForSelector('#pickerBackdrop:not([hidden])');
  assert.equal(await page.locator('.picker-row').count(), 3);
  // The expired access token was silently refreshed to get here.
  assert.ok(server.counters.catalog >= 1);
});

test('the picker filter selects only the monthly playlists', async () => {
  await page.fill('#pickerFilter', 'Kuukausi');
  await page.waitForFunction(() => document.querySelectorAll('.picker-row').length === 2);
  await page.click('#btnPickMatching');
  await page.waitForFunction(
    () => document.getElementById('pickerCount').textContent.includes('2 playlists selected'),
  );
});

test('the first sync paginates through every selected playlist', async () => {
  resetCounters();
  await clearBanner(page);
  await page.click('#btnPickerSave');
  await waitForSync(page);

  // At the 50-item cap p1's 150 tracks take 3 pages; p2's 10 take 1. p3 was
  // not selected.
  assert.equal(server.counters.trackPages, 4);
  assert.deepEqual(server.counters.trackFetchesByPlaylist, { p1: 1, p2: 1 });

  await page.waitForSelector('.album');
  assert.match(await page.textContent('#count'), /from 2 playlists/);
});

test('the unselected playlist stays out of the library', async () => {
  await page.fill('#q', 'playlist:"Not a monthly"');
  await page.waitForSelector('.empty');
  assert.match(await page.textContent('.empty'), /Nothing matches/);
  await page.click('#btnReset');
  await page.waitForSelector('.album');
});

test('re-syncing an unchanged crate fetches no tracks at all', async () => {
  resetCounters();
  await clearBanner(page);
  await page.click('#btnSync');
  await waitForSync(page);

  // Two pages: the second is reached by rewriting Spotify's retired `next`.
  assert.equal(server.counters.catalog, 2, 'the catalog is still checked');
  assert.equal(server.counters.trackPages, 0, 'but no playlist is re-read');
  assert.match(await page.textContent('#banner'), /0 refetched, 2 unchanged/);
});

test('a changed snapshot_id refetches only that playlist', async () => {
  resetCounters();
  await clearBanner(page);
  server.playlists.find((p) => p.id === 'p2').snapshot = 'b2';

  await page.click('#btnSync');
  await waitForSync(page);

  assert.deepEqual(server.counters.trackFetchesByPlaylist, { p2: 1 });
  assert.equal(server.counters.trackPages, 1);
  assert.match(await page.textContent('#banner'), /1 refetched, 1 unchanged/);
});

test('exporting the current results creates a playlist in batches of 100', async () => {
  server.counters.created = [];
  server.counters.added = [];

  await clearBanner(page);
  // The name prompt is a real window.prompt; answer it without a dialog handler.
  await page.evaluate(() => { window.prompt = (msg, def) => def; });

  await page.fill('#q', 'artist:"Artist 1"');
  await page.waitForFunction(() => document.querySelectorAll('.album').length === 1);
  await page.click('#btnExport');
  await waitForSync(page);

  assert.match(await page.textContent('#banner'), /Created/);
  assert.equal(server.counters.created.length, 1);
  assert.equal(server.counters.created[0].public, false, 'exports are private');
  assert.ok(server.counters.added.length >= 1);

  const all = server.counters.added.flat();
  assert.ok(all.length > 0);
  assert.ok(server.counters.added.every((b) => b.length <= 100), 'batched to Spotify\'s limit');
  assert.equal(new Set(all).size, all.length, 'no duplicate URIs');
});

test('the cache survives a reload without touching the network', async () => {
  resetCounters();
  await page.reload();
  await page.waitForSelector('.album');
  assert.equal(server.counters.catalog, 0, 'no API call needed to browse');
  assert.match(await page.textContent('#count'), /from 2 playlists/);
});

test('one unreadable playlist does not sink the whole sync', async () => {
  resetCounters();
  await clearBanner(page);

  // Spotify refuses p3 (as it does for editorial/algorithmic lists in dev mode).
  server.forbidden.add('p3');
  server.playlists.find((p) => p.id === 'p1').snapshot = 'a2';

  await page.click('#btnPlaylists');
  await page.waitForSelector('#pickerBackdrop:not([hidden])');
  await page.fill('#pickerFilter', '');
  await page.click('#btnPickMatching');
  await page.waitForFunction(
    () => document.getElementById('pickerCount').textContent.includes('3 playlists selected'),
  );
  await page.click('#btnPickerSave');
  await waitForSync(page);

  // p1 changed and must still be refetched even though p3 blew up.
  assert.equal(server.counters.trackFetchesByPlaylist.p1, 1, 'p1 still synced');
  const banner = await page.textContent('#banner');
  assert.match(banner, /Synced/, 'the sync reports success, not a bare error');
  assert.match(banner, /Not a monthly list/, 'the skipped playlist is named');

  await page.waitForSelector('.album');
  assert.match(await page.textContent('#count'), /from 2 playlists/);

  server.forbidden.delete('p3');
});

test('a playlist that rejects the fields filter is refetched without it', async () => {
  resetCounters();
  await clearBanner(page);

  server.forbiddenWithFields.add('p2');
  server.playlists.find((p) => p.id === 'p2').snapshot = 'b3';

  await page.click('#btnSync');
  await waitForSync(page);

  const banner = await page.textContent('#banner');
  assert.doesNotMatch(banner, /Skipped/, 'the playlist is recovered, not skipped');
  assert.equal(server.counters.trackFetchesByPlaylist.p2, 1, 'p2 came back on the retry');

  server.forbiddenWithFields.delete('p2');
});

test('playing an album starts it and queues the rest of the results behind it', async () => {
  server.counters.played = [];
  await clearBanner(page);
  await page.click('#btnReset');
  await page.waitForSelector('.album');

  const firstAlbum = page.locator('.album').first();
  await firstAlbum.locator('button[title="Play now"]').click();
  await page.waitForFunction(() => /Playing/.test(document.getElementById('banner').textContent));

  assert.equal(server.counters.played.length, 1, 'one play call');
  const { body } = server.counters.played[0];
  assert.ok(Array.isArray(body.uris) && body.uris.length > 1, 'sends a list of track URIs');
  assert.ok(body.uris.every((u) => u.startsWith('spotify:track:')), 'all are track URIs');

  // The clicked album leads; later results follow so a search plays through.
  const titles = await page.locator('.album .album-title').allTextContents();
  assert.ok(titles.length > 1, 'more than one album was on screen');
});

test('queueing an album appends without interrupting playback', async () => {
  server.counters.queued = [];
  server.counters.played = [];
  await clearBanner(page);

  await page.locator('.album').first().locator('button[title="Add to queue"]').click();
  await page.waitForFunction(() => /[Qq]ueued/.test(document.getElementById('banner').textContent));

  assert.equal(server.counters.played.length, 0, 'nothing was interrupted');
  assert.ok(server.counters.queued.length >= 1, 'tracks were queued');
  assert.ok(
    server.counters.queued.every((u) => u.startsWith('spotify:track:')),
    'queued track URIs',
  );
});

test('playback targets the chosen Spotify Connect device', async () => {
  server.counters.played = [];
  await clearBanner(page);

  await page.waitForFunction(() => document.querySelectorAll('#device option').length >= 2);
  await page.selectOption('#device', 'dev2');

  await page.locator('.album').first().locator('button[title="Play now"]').click();
  await page.waitForFunction(() => /Playing/.test(document.getElementById('banner').textContent));

  assert.equal(server.counters.played[0].deviceId, 'dev2', 'played on the picked device');
});

test('the picker separates what is already in the crate from what is not', async () => {
  // A playlist that exists on the account but has never been added.
  server.playlists.push({ id: 'p4', name: 'Bought albums', snapshot: 'd1', count: 4 });
  await clearBanner(page);
  await page.click('#btnSync');
  await waitForSync(page);

  await page.click('#btnPlaylists');
  await page.waitForSelector('#pickerBackdrop:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('.picker-row').length === 4);

  // Rows already in the crate say so; the new one does not.
  assert.equal(await page.locator('.picker-row .in-crate').count(), 3);

  await page.click('#pickerScope button[data-scope="in"]');
  await page.waitForFunction(() => document.querySelectorAll('.picker-row').length === 3);
  assert.doesNotMatch(await page.textContent('#pickerList'), /Bought albums/);

  await page.click('#pickerScope button[data-scope="out"]');
  await page.waitForFunction(() => document.querySelectorAll('.picker-row').length === 1);
  assert.match(await page.textContent('#pickerList'), /Bought albums/);

  // Ticking it counts as newly added until the crate is saved.
  await page.locator('.picker-row input[type=checkbox]').first().check();
  await page.waitForFunction(
    () => /1 new/.test(document.getElementById('pickerCount').textContent),
  );
  assert.match(await page.textContent('#pickerCount'), /3 in crate/);

  await page.click('#btnPickerClose');
  await page.waitForSelector('#pickerBackdrop[hidden]', { state: 'hidden' });
});

test('a rate-limited sync says it is waiting instead of looking hung', async () => {
  await clearBanner(page);
  await page.evaluate(() => window.__crateRateBudget(null));
  server.rateLimitOnce = true;
  await page.click('#btnSync');

  // The progress dialog has to name the wait, or a 429 is indistinguishable
  // from a hang.
  await page.waitForFunction(
    () => /rate.?limited/i.test(document.getElementById('progressText').textContent),
    null,
    { timeout: 10000 },
  );
  const text = await page.textContent('#progressText');
  assert.match(text, /\d+\s*s/, 'it counts down in seconds');

  await waitForSync(page);
  assert.match(await page.textContent('#banner'), /Synced/, 'and then it recovers');
});

test('a persistent rate limit gives up and holds off, instead of hammering', async () => {
  await clearBanner(page);
  await page.evaluate(() => window.__crateRateBudget(null));
  // Retry-After is unreadable cross-origin, so the mock does not send one:
  // this is exactly what the app sees in production.
  server.rateLimitTimes = 99;
  server.rateLimitRetryAfter = 0;

  await page.click('#btnSync');
  await page.waitForFunction(
    () => /rate-limiting/i.test(document.getElementById('banner').textContent),
    null,
    { timeout: 120000 },
  );
  assert.match(await page.textContent('#banner'), /try again in/i, 'it says when to come back');

  // A second attempt is refused locally rather than spending another request.
  server.rateLimitTimes = 0;
  const before = server.counters.catalog;
  await clearBanner(page);
  await page.click('#btnSync');
  await page.waitForFunction(
    () => /rate-limiting/i.test(document.getElementById('banner').textContent),
  );
  assert.equal(server.counters.catalog, before, 'no request during the cooldown');

  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));
  server.rateLimitRetryAfter = 2;
});

test('Cancel interrupts a rate-limit wait immediately', async () => {
  // Abort any request chain still backing off from the previous test, or it
  // will overwrite the banner this test is about to assert on.
  // The button is hidden with the dialog, so fire it directly.
  await page.evaluate(() => document.getElementById('btnCancelSync').click());
  await page.waitForTimeout(300);
  await clearBanner(page);
  await page.evaluate(() => {
    localStorage.removeItem('crate.cooldownUntil');
    // Stale text from an earlier test would otherwise match instantly.
    document.getElementById('progressText').textContent = '';
  });
  server.rateLimitTimes = 99;
  server.rateLimitRetryAfter = 0;

  await page.click('#btnSync');
  // Wait until the dialog is genuinely open and sitting in the countdown.
  await page.waitForFunction(
    () => !document.getElementById('progressBackdrop').hidden
      && /rate-limited/i.test(document.getElementById('progressText').textContent),
    null,
    { timeout: 20000 },
  );

  const started = Date.now();
  await page.click('#btnCancelSync');

  // It must not sit out the remaining seconds first.
  await page.waitForSelector('#progressBackdrop[hidden]', { state: 'hidden', timeout: 5000 });
  assert.ok(Date.now() - started < 5000, 'cancel took effect promptly');
  await page.waitForFunction(
    () => /cancel/i.test(document.getElementById('banner').textContent),
    null,
    { timeout: 5000 },
  );

  server.rateLimitTimes = 0;
  server.rateLimitRetryAfter = 2;
  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));
});

test('a single 429 is remembered, so reloading does not fire more requests', async () => {
  await page.evaluate(() => document.getElementById('btnCancelSync').click());
  await page.waitForTimeout(300);
  await clearBanner(page);
  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));

  server.rateLimitTimes = 1;
  server.rateLimitRetryAfter = 0;
  await page.click('#btnSync');

  // The very first 429 must record a cooldown, not only the last one.
  await page.waitForFunction(
    () => Number(localStorage.getItem('crate.cooldownUntil') || 0) > Date.now(),
    null,
    { timeout: 15000 },
  );

  await page.evaluate(() => document.getElementById('btnCancelSync').click());
  await page.waitForTimeout(300);

  // A reload while held off must not touch the network.
  const before = server.counters.catalog;
  await page.reload();
  await page.waitForTimeout(1500);
  assert.equal(server.counters.catalog, before, 'boot made no catalog request');

  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));
  server.rateLimitTimes = 0;
  server.rateLimitRetryAfter = 2;
});

test('tapping the cover opens an action sheet that can play or queue', async () => {
  server.counters.played = [];
  server.counters.queued = [];
  await clearBanner(page);
  await page.click('#btnReset');
  await page.waitForSelector('.album');

  // The whole cover is the target, not the small tick.
  await page.locator('.album .album-art').first().click();
  await page.waitForSelector('#sheetBackdrop:not([hidden])');

  await page.click('#sheetPlay');
  await page.waitForSelector('#sheetBackdrop[hidden]', { state: 'hidden' });
  assert.equal(server.counters.played.length, 1, 'played from the sheet');

  await page.locator('.album .album-art').first().click();
  await page.waitForSelector('#sheetBackdrop:not([hidden])');
  await page.click('#sheetQueue');
  await page.waitForFunction(() => /[Qq]ueued/.test(document.getElementById('banner').textContent));
  assert.ok(server.counters.queued.length >= 1, 'queued from the sheet');
});

test('the sheet can select the album, and the tick still works on its own', async () => {
  await page.click('#btnClearSel').catch(() => {});
  await page.locator('.album .album-art').first().click();
  await page.waitForSelector('#sheetBackdrop:not([hidden])');
  await page.click('#sheetSelect');
  await page.waitForSelector('#sheetBackdrop[hidden]', { state: 'hidden' });
  await page.waitForSelector('#selectionInfo:not([hidden])');

  // The tick keeps its own click for fast multi-select: it must not open a sheet.
  await page.locator('.album .tick').nth(1).click();
  assert.equal(await page.isHidden('#sheetBackdrop'), true, 'tick did not open the sheet');

  await page.click('#btnClearSel');
});

test('Escape closes the action sheet', async () => {
  await page.locator('.album .album-art').first().click();
  await page.waitForSelector('#sheetBackdrop:not([hidden])');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#sheetBackdrop[hidden]', { state: 'hidden' });
});

test('a bulk sync paces itself instead of bursting into the rate limit', async () => {
  // A first sync on a new device is hundreds of requests. Spotify allows about
  // 180 per 30s, so an unpaced burst is limited before it finishes.
  await clearBanner(page);
  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));
  server.playlists.forEach((p, i) => { p.snapshot = `paced-${i}`; });
  server.counters.stamps = [];

  await page.click('#btnSync');
  await waitForSync(page);

  const stamps = server.counters.stamps;
  assert.ok(stamps.length >= 4, `expected several requests, got ${stamps.length}`);

  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  const tooFast = gaps.filter((g) => g < 100).length;
  assert.equal(tooFast, 0, `every request should be spaced; gaps were ${gaps.join(',')}`);
});

test('a completed sync is copied to the cross-device store', async () => {
  server.counters.cloudPuts = [];
  await clearBanner(page);
  server.playlists.forEach((p, i) => { p.snapshot = `cloud-${i}`; });

  await page.click('#btnSync');
  await waitForSync(page);
  await page.waitForFunction(() => true);

  // The push is best effort and fires after the banner, so give it a moment.
  await page.waitForTimeout(500);
  assert.ok(server.counters.cloudPuts.length >= 1, 'the crate was uploaded');
  assert.ok(server.counters.cloudPuts[0] > 100, 'and it was not empty');
});

test('a fresh device restores from the store without touching Spotify', async () => {
  const fresh = await browser.newPage();
  await installMock(fresh);
  await installCloudMock(fresh);
  await fresh.goto(BASE_URL);
  await fresh.evaluate(() => {
    localStorage.setItem('crate.clientId', 'b'.repeat(32));
    localStorage.setItem('crate.tokens', JSON.stringify({
      accessToken: 'fresh', refreshToken: 'refresh', expiresAt: Date.now() + 3600e3,
    }));
  });
  resetCounters();
  await fresh.reload();

  // An empty device restores by itself rather than re-reading Spotify.
  await fresh.waitForFunction(
    () => /Restored/.test(document.getElementById('banner').textContent),
    null,
    { timeout: 20000 },
  );
  await fresh.waitForSelector('.album');
  assert.equal(server.counters.trackPages, 0, 'no playlist was read from Spotify');
  assert.equal(await fresh.isHidden('#pickerBackdrop'), true, 'and the picker did not open');

  await fresh.close();
});

test('a local hold-off can be overridden from the banner', async () => {
  await page.evaluate(() => document.getElementById('btnCancelSync').click());
  await page.waitForTimeout(300);
  await clearBanner(page);

  // Pretend an earlier 429 put us in a long local cooldown.
  await page.evaluate(() => {
    localStorage.setItem('crate.cooldownUntil', String(Date.now() + 2 * 3600 * 1000));
  });
  server.rateLimitTimes = 0;
  server.playlists.forEach((p, i) => { p.snapshot = `override-${i}`; });
  resetCounters();

  await page.click('#btnSync');
  await page.waitForSelector('#bannerAction');
  assert.match(await page.textContent('#banner'), /rate-limiting/i);
  assert.equal(server.counters.catalog, 0, 'blocked before any request');

  await page.click('#bannerAction');
  await waitForSync(page);
  assert.ok(server.counters.catalog >= 1, 'the override actually synced');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('crate.cooldownUntil')),
    null,
    'and cleared the stale hold-off',
  );
});

test('a stored pass restores the crate even while Spotify is rate-limiting', async () => {
  // The deadlock this guards against: identity was checked against Spotify on
  // every call, so a rate limit blocked the one route that avoids the API.
  const fresh = await browser.newPage();
  await installMock(fresh);
  await installCloudMock(fresh);
  await fresh.goto(BASE_URL);
  await fresh.evaluate(() => {
    localStorage.setItem('crate.clientId', 'c'.repeat(32));
    localStorage.setItem('crate.tokens', JSON.stringify({
      accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3600e3,
    }));
    // Already verified once on this device.
    localStorage.setItem('crate.cloudPass', 'test-pass');
  });

  server.spotifyIdentityDown = true;
  resetCounters();
  await fresh.reload();

  await fresh.waitForFunction(
    () => /Restored/.test(document.getElementById('banner').textContent),
    null,
    { timeout: 20000 },
  );
  await fresh.waitForSelector('.album');
  assert.equal(server.counters.trackPages, 0, 'Spotify was not read at all');

  server.spotifyIdentityDown = false;
  await fresh.close();
});

test('without a pass, a rate-limited identity check says so honestly', async () => {
  const fresh = await browser.newPage();
  await installMock(fresh);
  await installCloudMock(fresh);
  await fresh.goto(BASE_URL);
  await fresh.evaluate(() => {
    localStorage.setItem('crate.clientId', 'd'.repeat(32));
    localStorage.setItem('crate.tokens', JSON.stringify({
      accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3600e3,
    }));
    localStorage.removeItem('crate.cloudPass');
  });

  server.spotifyIdentityDown = true;
  await fresh.reload();
  // It must not claim the crate is empty-and-fine; the picker opens instead.
  await fresh.waitForSelector('#pickerBackdrop:not([hidden])', { timeout: 20000 });

  server.spotifyIdentityDown = false;
  await fresh.close();
});

// These two share a browser context, so each one establishes the crate it needs
// rather than inheriting whatever the previous test left behind.
async function deviceWithCrate(pass) {
  const fresh = await browser.newPage();
  await installMock(fresh);
  await installCloudMock(fresh);
  await fresh.goto(BASE_URL);
  await fresh.evaluate((p) => {
    localStorage.setItem('crate.clientId', 'e'.repeat(32));
    localStorage.setItem('crate.tokens', JSON.stringify({
      accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3600e3,
    }));
    localStorage.setItem('crate.cloudPass', p);
  }, pass);

  // Populate this device from the store, so it holds a crate either way.
  cloudUploadedAt = '2000-01-01T00:00:00Z';
  await fresh.reload();
  await fresh.waitForSelector('.album', { timeout: 20000 });
  return fresh;
}

test('a device with an unsaved crate backs itself up on load', async () => {
  const fresh = await deviceWithCrate('test-pass');

  // Nothing saved since this device last synced: opening the app is enough.
  await fresh.evaluate(() => localStorage.removeItem('crate.pushedSync'));
  cloudUploadedAt = '2000-01-01T00:00:00Z';
  server.counters.cloudPuts = [];

  await fresh.reload();
  await fresh.waitForSelector('.album');
  await fresh.waitForTimeout(1200);
  assert.ok(server.counters.cloudPuts.length >= 1, 'it uploaded without being asked');

  // And a second load does not re-send the same thing.
  server.counters.cloudPuts = [];
  await fresh.reload();
  await fresh.waitForSelector('.album');
  await fresh.waitForTimeout(1000);
  assert.equal(server.counters.cloudPuts.length, 0, 'no pointless re-upload');

  await fresh.close();
});

test('an older device does not overwrite a newer crate saved elsewhere', async () => {
  const fresh = await deviceWithCrate('test-pass');

  // Another device saved something after this one last synced.
  await fresh.evaluate(() => localStorage.removeItem('crate.pushedSync'));
  cloudUploadedAt = '2030-01-01T00:00:00Z';
  server.counters.cloudPuts = [];

  await fresh.reload();
  await fresh.waitForSelector('.album');
  await fresh.waitForFunction(
    () => /Another device saved a crate/i.test(document.getElementById('banner').textContent),
    null,
    { timeout: 15000 },
  );
  assert.equal(server.counters.cloudPuts.length, 0, 'the newer copy survived');

  // Newer is not always better: a half-finished sync from a phone should be
  // beatable by a complete one here, so both directions are offered.
  assert.match(await fresh.textContent('#banner'), /This one holds [\d\s,.]+tracks/);
  await fresh.click('#btnKeepMine');
  await fresh.waitForFunction(
    () => /Saved\./.test(document.getElementById('banner').textContent),
    null,
    { timeout: 15000 },
  );
  assert.equal(server.counters.cloudPuts.length, 1, 'this device overwrote it on request');

  await fresh.close();
  cloudUploadedAt = null;
});

test('the stored copy is described in the same terms as this one', async () => {
  const fresh = await deviceWithCrate('test-pass');

  // A copy saved by a device that counted what it was sending.
  await fresh.evaluate(() => localStorage.removeItem('crate.pushedSync'));
  cloudUploadedAt = '2030-01-01T00:00:00Z';
  cloudCounts = { tracks: 412, playlists: 7 };

  await fresh.reload();
  await fresh.waitForSelector('.album');
  await fresh.waitForFunction(
    () => /Another device saved a crate/i.test(document.getElementById('banner').textContent),
    null,
    { timeout: 15000 },
  );

  // Both sides in tracks, so the choice is between two comparable things.
  const text = await fresh.textContent('#banner');
  assert.match(text, /\(412 tracks from 7 playlists\)/);
  assert.doesNotMatch(text, /MB/);

  await fresh.close();
  cloudUploadedAt = null;
  cloudCounts = { tracks: null, playlists: null };
});

test('a copy saved before the counts existed still says something', async () => {
  const fresh = await deviceWithCrate('test-pass');

  await fresh.evaluate(() => localStorage.removeItem('crate.pushedSync'));
  cloudUploadedAt = '2030-01-01T00:00:00Z';
  cloudCounts = { tracks: null, playlists: null };

  await fresh.reload();
  await fresh.waitForSelector('.album');
  await fresh.waitForFunction(
    () => /Another device saved a crate/i.test(document.getElementById('banner').textContent),
    null,
    { timeout: 15000 },
  );

  // Falls back to bytes rather than claiming a count it does not have.
  assert.match(await fresh.textContent('#banner'), /\((unknown size|[\d.]+ MB)\)/);

  await fresh.close();
  cloudUploadedAt = null;
});

test('the question can be declined, and does not come back', async () => {
  const fresh = await deviceWithCrate('test-pass');

  await fresh.evaluate(() => localStorage.removeItem('crate.pushedSync'));
  cloudUploadedAt = '2030-01-01T00:00:00Z';
  server.counters.cloudPuts = [];

  await fresh.reload();
  await fresh.waitForSelector('.album');
  await fresh.waitForSelector('#btnNotNow', { timeout: 15000 });
  await fresh.click('#btnNotNow');

  await fresh.waitForFunction(
    () => document.getElementById('banner').hidden,
    null,
    { timeout: 15000 },
  );

  // Declining is not choosing: neither copy moved.
  assert.equal(server.counters.cloudPuts.length, 0, 'nothing was uploaded');

  // And the same question does not get asked again on the next load.
  await fresh.reload();
  await fresh.waitForSelector('.album');
  await fresh.waitForTimeout(1200);
  assert.equal(
    await fresh.evaluate(() => document.getElementById('banner').hidden),
    true,
    'the banner stayed down',
  );
  assert.equal(server.counters.cloudPuts.length, 0, 'still nothing uploaded');

  await fresh.close();
  cloudUploadedAt = null;
});

test('the app can tell you how long a lockout has left', async () => {
  await page.evaluate(() => document.getElementById('btnCancelSync').click());
  await page.waitForTimeout(300);
  await clearBanner(page);

  // A local hold-off is in place and the user wants to know the real answer.
  await page.evaluate(() => {
    localStorage.setItem('crate.cooldownUntil', String(Date.now() + 60 * 1000));
  });
  server.probeAnswer = {
    ok: false,
    status: 429,
    retryAfterSeconds: 9396,
    retryAt: new Date(Date.now() + 9396 * 1000).toISOString(),
  };

  await page.click('#btnSync');
  await page.waitForSelector('#btnAskLimit');
  await page.click('#btnAskLimit');

  await page.waitForFunction(
    () => /another 2 hours|another \d+ (minutes|hours)/i.test(
      document.getElementById('banner').textContent,
    ),
    null,
    { timeout: 15000 },
  );
  const text = await page.textContent('#banner');
  assert.match(text, /until about \d{1,2}[:.]\d{2}/, 'it names a clock time');

  // And Spotify's real number replaces our guess.
  const held = await page.evaluate(
    () => Number(localStorage.getItem('crate.cooldownUntil')) - Date.now(),
  );
  assert.ok(held > 9000 * 1000, `cooldown should follow Retry-After, got ${held}ms`);

  server.probeAnswer = { ok: true, status: 200 };
  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));
});

test('a clear-again check does not send an empty device to Sync', async () => {
  const fresh = await browser.newPage();
  await installMock(fresh);
  await installCloudMock(fresh);
  await fresh.goto(BASE_URL);
  await fresh.evaluate(() => {
    localStorage.setItem('crate.clientId', 'g'.repeat(32));
    localStorage.setItem('crate.tokens', JSON.stringify({
      accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3600e3,
    }));
    localStorage.setItem('crate.cloudPass', 'test-pass');
  });

  // Nothing stored and nothing selected: the state a new phone is in.
  cloudStore = null;
  server.probeAnswer = { ok: true, status: 200 };
  await fresh.reload();
  await fresh.waitForSelector('#pickerBackdrop:not([hidden])', { timeout: 20000 });
  await fresh.click('#btnPickerClose');
  await fresh.evaluate(() => {
    // Wipe the selection this device inherited from shared storage.
    indexedDB.deleteDatabase('spotify-crate');
    localStorage.removeItem('crate.pushedSync');
  });
  await fresh.reload();
  await fresh.waitForSelector('#pickerBackdrop:not([hidden])', { timeout: 20000 });
  await fresh.click('#btnPickerClose');

  await fresh.click('#btnCheckLimit');
  await fresh.waitForFunction(
    () => /answering again/i.test(document.getElementById('banner').textContent),
    null,
    { timeout: 15000 },
  );
  // Offers the thing that actually works on this device.
  assert.match(await fresh.textContent('#bannerAction'), /Choose playlists/);

  await fresh.close();
});

test('playlist sizes survive the tracks-to-items rename', async () => {
  await page.click('#btnPlaylists');
  await page.waitForSelector('#pickerBackdrop:not([hidden])');
  await page.waitForSelector('.picker-row');

  const counts = await page.locator('.picker-row .n').allTextContents();
  assert.ok(counts.some((c) => Number(c) > 0), `every playlist showed 0: ${counts.join(',')}`);
  assert.match(await page.textContent('#pickerCount'), /about [\d\s,.]+tracks/);

  await page.click('#btnPickerClose');
});

test('a bulk sync stays inside a rolling request budget', async () => {
  await clearBanner(page);
  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));
  // Shrink the window so the shape is testable in seconds rather than minutes.
  await page.evaluate(() => window.__crateRateBudget(4, 1000));
  server.playlists.forEach((p, i) => { p.snapshot = `budget-${i}`; });
  server.counters.stamps = [];

  await page.click('#btnSync');
  await waitForSync(page);

  const stamps = server.counters.stamps;
  assert.ok(stamps.length >= 6, `need enough requests to judge, got ${stamps.length}`);

  // No 1s window may hold more than the budget.
  let worst = 0;
  for (let i = 0; i < stamps.length; i += 1) {
    const inWindow = stamps.filter((t) => t >= stamps[i] && t < stamps[i] + 1000).length;
    worst = Math.max(worst, inWindow);
  }
  assert.ok(worst <= 4, `budget of 4/s exceeded: saw ${worst}`);

  await page.evaluate(() => window.__crateRateBudget(null));
});

test('a rate limit stops the run instead of marching through the rest', async () => {
  await clearBanner(page);
  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));
  server.playlists.forEach((p, i) => { p.snapshot = `abort-${i}`; });
  // Refuse every track read, the way a live penalty does.
  server.forbidden.clear();
  server.rateLimitTracks = true;
  await page.evaluate(() => window.__crateRateBudget(null));
  resetCounters();

  await page.click('#btnSync');
  await page.waitForFunction(
    () => {
      const b = document.getElementById('banner');
      // Visible, not merely holding text from an earlier test.
      return !b.hidden && /rate-limiting|Synced/.test(b.textContent);
    },
    null,
    { timeout: 120000 },
  );

  // It must give up, not attempt all three playlists in turn.
  const attempted = server.counters.refusedPlaylists.size;
  assert.ok(attempted >= 1, 'the first playlist was attempted');
  assert.ok(attempted <= 1, `should stop after the first refusal, tried ${attempted}`);

  server.rateLimitTracks = false;
  await page.evaluate(() => localStorage.removeItem('crate.cooldownUntil'));
});

test('nothing threw along the way', () => {
  assert.deepEqual(errors, []);
});
