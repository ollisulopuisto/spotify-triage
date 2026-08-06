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
  return page.evaluate(() => { document.getElementById('banner').hidden = true; });
}

function resetCounters() {
  server.counters.catalog = 0;
  server.counters.trackPages = 0;
  server.counters.trackFetchesByPlaylist = {};
}

function json(route, body) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });
}

async function installMock(page) {
  await page.route('**://accounts.spotify.com/api/token', (route) => json(route, {
    access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600,
  }));

  await page.route('**://api.spotify.com/**', async (route) => {
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
      if (server.rateLimitOnce) {
        server.rateLimitOnce = false;
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*', 'Retry-After': '2' },
          body: JSON.stringify({ error: { status: 429, message: 'Too Many Requests' } }),
        });
      }
      server.counters.catalog += 1;
      return json(route, {
        total: server.playlists.length,
        next: null,
        items: server.playlists.map((p) => ({
          id: p.id,
          name: p.name,
          snapshot_id: p.snapshot,
          tracks: { total: p.count },
          owner: { id: 'me', display_name: 'Me' },
          images: [],
          external_urls: { spotify: `${BASE_URL}/#${p.id}` },
        })),
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
    const expected = /Failed to load resource.*(403|429)/.test(m.text())
      || /^\[crate\] 403 /.test(m.text());
    if (m.type() === 'error' && !expected) {
      errors.push(m.text());
    }
  });

  await installMock(page);
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

  assert.equal(server.counters.catalog, 1, 'the catalog is still checked');
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

test('nothing threw along the way', () => {
  assert.deepEqual(errors, []);
});
