// Browser smoke test. Seeds a fake synced crate into IndexedDB, then drives the
// real UI — no Spotify calls are made.
//
//   node --test spotify-crate/tests/ui.test.mjs
//
// Expects the app to be served at BASE_URL (default http://127.0.0.1:8765).

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8765';

const ARTISTS = ['Radiohead', 'Aphex Twin', 'Björk', 'Boards of Canada', 'Talk Talk', 'Slowdive'];
const ALBUMS = [
  ['Kid A', 2000], ['Drukqs', 2001], ['Homogenic', 1997],
  ['Music Has the Right to Children', 1998], ['Laughing Stock', 1991], ['Souvlaki', 1993],
];

// 24 monthly playlists, each holding a handful of albums; one album is
// deliberately filed twice so the "filed 2x" path gets exercised.
function fakeCrate() {
  const playlists = [];
  for (let i = 0; i < 24; i += 1) {
    const year = 2019 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, '0');
    const tracks = [];

    for (let j = 0; j < 4; j += 1) {
      const idx = (i + j) % ALBUMS.length;
      const [albumName, year0] = ALBUMS[idx];
      for (let k = 0; k < 3; k += 1) {
        tracks.push({
          id: `t-${idx}-${k}`,
          uri: `spotify:track:t-${idx}-${k}`,
          name: `${albumName} track ${k + 1}`,
          durationMs: 180000 + k * 1000,
          popularity: 40,
          artists: [{ id: `a-${idx}`, name: ARTISTS[idx] }],
          albumId: `al-${idx}`,
          albumName,
          releaseDate: `${year0}-01-01`,
          albumImage: null,
          addedAt: `${year}-${month}-1${k}T10:00:00Z`,
        });
      }
    }

    playlists.push({
      id: `p${i}`,
      name: `Kuukausi ${year}-${month}`,
      snapshotId: `snap-${i}`,
      total: tracks.length,
      owner: 'me',
      ownerId: 'me',
      image: null,
      url: null,
      tracks,
    });
  }
  return playlists;
}

async function seed(page, playlists) {
  await page.evaluate(async (pls) => {
    localStorage.setItem('crate.clientId', 'a'.repeat(32));
    localStorage.setItem('crate.tokens', JSON.stringify({
      accessToken: 'fake', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3600e3,
    }));

    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('spotify-crate', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('playlists')) d.createObjectStore('playlists', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    await new Promise((resolve, reject) => {
      const t = db.transaction(['playlists', 'meta'], 'readwrite');
      const store = t.objectStore('playlists');
      pls.forEach((p) => store.put(p));
      const meta = t.objectStore('meta');
      meta.put(pls.map((p) => p.id), 'selectedPlaylistIds');
      meta.put(new Date().toISOString(), 'lastSync');
      meta.put(pls.map(({ tracks, ...rest }) => rest), 'catalog');
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }, playlists);
}

// Waiting on a count alone is racy: the previous query may already show the
// right number of albums, so the wait passes against a stale grid. Wait for the
// exact titles instead.
function showsAlbums(page, names) {
  return page.waitForFunction((expected) => {
    const got = [...document.querySelectorAll('.album .album-title')]
      .map((e) => e.textContent);
    return got.length === expected.length
      && expected.every((n) => got.some((g) => g.includes(n)));
  }, names);
}

const ALL_ALBUMS = ALBUMS.map(([name]) => name);

let browser;
let page;
const consoleErrors = [];

test.before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('console', (m) => {
    // A device with nothing stored asks /api/crate and is told 404. That is the
    // ordinary first-run case, and the browser logs it whatever we do.
    const expected = /Failed to load resource.*404/.test(m.text());
    if (m.type() === 'error' && !expected) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Fail loudly rather than silently hitting the network.
  await page.route('**://api.spotify.com/**', (r) => r.abort());
  await page.route('**://accounts.spotify.com/**', (r) => r.abort());

  // The app asks for Connect devices on load. Answer with an empty list rather
  // than aborting, so this suite exercises the no-devices state instead of a
  // network error the browser would log. Registered last: later routes win.
  await page.route('**://api.spotify.com/v1/me/player/devices*', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ devices: [] }),
  }));

  // This suite serves static files only, so the app's own endpoint is stubbed:
  // nothing stored, uploads accepted and discarded.
  await page.route('**/api/crate*', (r) => {
    if (r.request().method() === 'PUT') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"bytes":2}' });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto(BASE_URL);
  await seed(page, fakeCrate());
  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
});

test.after(async () => {
  await browser.close();
});

test('signed-out visitors get setup instructions with the exact redirect URI', async () => {
  const fresh = await browser.newPage();
  await fresh.goto(`${BASE_URL}?t=setup`);
  await fresh.waitForSelector('#setup:not([hidden])');
  assert.equal(await fresh.textContent('#redirectUri'), `${BASE_URL}/`);

  // A stranger needs to know what this is, that it is safe, and that Premium
  // is required — before being asked to register anything.
  const copy = await fresh.textContent('#setup');
  assert.match(copy, /Premium/, 'the Premium requirement is stated up front');
  // The claim has to match what the app actually does — there is a server copy.
  assert.match(copy, /Your library stays yours/i, 'the storage claim is made');
  assert.match(copy, /not encrypted at rest/i, 'the caveat is not buried');
  assert.match(copy, /User Management/, 'the allowlist step is included');

  await fresh.close();
});

test('the Client ID field explains what is wrong before you submit', async () => {
  const fresh = await browser.newPage();
  await fresh.goto(`${BASE_URL}?t=validate`);
  await fresh.waitForSelector('#setup:not([hidden])');

  await fresh.fill('#clientId', 'https://open.spotify.com/');
  await fresh.waitForFunction(() => /URL/.test(document.getElementById('clientIdHint').textContent));

  await fresh.fill('#clientId', 'abc123');
  await fresh.waitForFunction(() => /32 letters and digits/.test(
    document.getElementById('clientIdHint').textContent,
  ));

  // Submitting a bad ID must not navigate away to Spotify.
  await fresh.click('#btnSignIn');
  await fresh.waitForSelector('#banner:not([hidden])');
  assert.match(await fresh.textContent('#banner'), /Client ID/);
  assert.ok(fresh.url().startsWith(BASE_URL), 'stayed on the page');

  await fresh.fill('#clientId', 'a'.repeat(32));
  await fresh.waitForFunction(() => /Looks right/.test(
    document.getElementById('clientIdHint').textContent,
  ));

  await fresh.close();
});

test('a synced crate renders as albums, deduplicated across months', async () => {
  await page.waitForSelector('.album');
  // 6 distinct albums across 24 playlists, not 24 x 4 entries.
  assert.equal(await page.locator('.album').count(), 6);

  const count = await page.textContent('#count');
  assert.match(count, /18 tracks/);
  assert.match(count, /6 albums/);
  assert.match(count, /24 playlists/);
});

test('an album filed in many months says so', async () => {
  const pill = page.locator('.album', { hasText: 'Kid A' }).locator('.pill.hot');
  // Says how many months, rather than an unexplained "filed 2×".
  assert.match(await pill.textContent(), /in \d+ months/);
});

test('free-text search narrows the grid', async () => {
  await page.fill('#q', 'bjork');
  await showsAlbums(page, ['Homogenic']);
  assert.match(await page.textContent('.album .album-artist'), /Björk/);
});

test('field-scoped search works from the UI', async () => {
  await page.fill('#q', 'artist:"Boards of Canada"');
  await showsAlbums(page, ['Music Has the Right to Children']);

  await page.fill('#q', 'year:1991');
  await showsAlbums(page, ['Laughing Stock']);
});

test('a query matching nothing shows the empty state, not a broken grid', async () => {
  await page.fill('#q', 'zzzznothing');
  await page.waitForSelector('.empty');
  assert.match(await page.textContent('.empty'), /Nothing matches/);
});

test('reset clears the query and restores every album', async () => {
  await page.click('#btnReset');
  await showsAlbums(page, ALL_ALBUMS);
  assert.equal(await page.inputValue('#q'), '');
});

test('clicking an artist facet appends a scoped term', async () => {
  await page.locator('#facetArtists .facet-item', { hasText: 'Slowdive' }).click();
  await showsAlbums(page, ['Souvlaki']);
  assert.equal(await page.inputValue('#q'), 'artist:"Slowdive"');
  await page.click('#btnReset');
});

test('a decade facet fills the release-year range', async () => {
  await page.locator('#facetDecades .facet-item', { hasText: '1990s' }).click();
  await showsAlbums(page, ['Homogenic', 'Music Has the Right to Children', 'Laughing Stock', 'Souvlaki']);
  assert.equal(await page.inputValue('#yearFrom'), '1990');
  assert.equal(await page.inputValue('#yearTo'), '1999');
  // The active filter is shown as a dismissible chip.
  assert.match(await page.textContent('#activeFilters'), /Released 1990–1999/);
  await page.click('#btnReset');
});

test('clicking a month tag pivots to that single playlist', async () => {
  await page.locator('.album').first().locator('.month-tag')
    .first()
    .click();
  await page.waitForSelector('#activeFilters:not([hidden])');
  assert.match(await page.textContent('#activeFilters'), /Playlist: Kuukausi/);

  // Dismissing the chip restores the full crate.
  await page.locator('#activeFilters .chip').first().click();
  await showsAlbums(page, ALL_ALBUMS);
});

test('the tracks view lists individual tracks', async () => {
  await page.click('.seg[data-view="tracks"]');
  await page.waitForSelector('.row');
  assert.equal(await page.locator('.row').count(), 18);
  await page.click('.seg[data-view="albums"]');
  await page.waitForSelector('.album');
});

test('expanding an album reveals its tracks', async () => {
  const album = page.locator('.album', { hasText: 'Souvlaki' });
  await album.locator('.linkbtn:not(.play)').click();
  await album.locator('.tracklist').waitFor();
  assert.equal(await album.locator('.tracklist li').count(), 3);
  await album.locator('.linkbtn:not(.play)').click();
});

test('selecting an album selects all of its tracks', async () => {
  await page.locator('.album', { hasText: 'Kid A' }).locator('.tick').click();
  await page.waitForSelector('#selectionInfo:not([hidden])');
  assert.match(await page.textContent('#selectionInfo'), /3 tracks selected/);
  assert.match(await page.textContent('#btnExport'), /Save 3 to a playlist/);

  await page.click('#btnClearSel');
  await page.waitForSelector('#selectionInfo[hidden]', { state: 'hidden' });
});

test('select-all covers every album currently matched', async () => {
  await page.fill('#q', 'artist:aphex');
  await showsAlbums(page, ['Drukqs']);
  await page.click('#btnSelectAll');
  assert.match(await page.textContent('#selectionInfo'), /3 tracks selected/);
  await page.click('#btnReset');
});

test('sorting by release year reorders the grid', async () => {
  await page.selectOption('#sort', 'releaseOld');
  await page.waitForFunction(
    () => document.querySelector('.album .album-title').textContent.includes('Laughing Stock'),
  );

  await page.selectOption('#sort', 'release');
  await page.waitForFunction(
    () => document.querySelector('.album .album-title').textContent.includes('Drukqs'),
  );
  await page.selectOption('#sort', 'relevance');
});

test('surprise me shuffles without losing anything', async () => {
  const order = async () => page.locator('.album .album-title').allTextContents();

  await page.click('#btnShuffle');
  const first = await order();
  await page.click('#btnShuffle');
  const second = await order();

  assert.equal(first.length, 6);
  assert.deepEqual([...first].sort(), [...second].sort(), 'same albums');
  await page.selectOption('#sort', 'relevance');
});

test('pressing / focuses the search box', async () => {
  // Click somewhere inert: the middle of the body is now a cover, and covers
  // open the action sheet.
  await page.locator('.topbar h1').click();
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
});

test('the playlist picker lists every playlist and filters by name', async () => {
  await page.click('#btnPlaylists');
  await page.waitForSelector('#pickerBackdrop:not([hidden])');
  assert.equal(await page.locator('.picker-row').count(), 24);

  await page.fill('#pickerFilter', '2020');
  await page.waitForFunction(() => document.querySelectorAll('.picker-row').length === 12);

  await page.click('#btnUnpickMatching');
  await page.waitForFunction(
    () => document.getElementById('pickerCount').textContent.includes('12 playlists selected'),
  );

  await page.click('#btnPickerClose');
  await page.waitForSelector('#pickerBackdrop[hidden]', { state: 'hidden' });
});

test('shift-click selects the whole range between two clicks', async () => {
  await page.click('#btnPlaylists');
  await page.waitForSelector('#pickerBackdrop:not([hidden])');

  await page.click('#btnUnpickMatching');
  await page.waitForFunction(
    () => document.getElementById('pickerCount').textContent.includes('0 playlists selected'),
  );

  const box = (i) => page.locator('.picker-row input[type=checkbox]').nth(i);

  await box(2).click();
  await box(6).click({ modifiers: ['Shift'] });
  await page.waitForFunction(
    () => document.getElementById('pickerCount').textContent.includes('5 playlists selected'),
  );
  for (const i of [2, 3, 4, 5, 6]) assert.equal(await box(i).isChecked(), true, `row ${i} checked`);
  for (const i of [0, 1, 7]) assert.equal(await box(i).isChecked(), false, `row ${i} unchecked`);

  // shift-click with an unchecking click clears the range too
  await box(6).click();
  await box(4).click({ modifiers: ['Shift'] });
  await page.waitForFunction(
    () => document.getElementById('pickerCount').textContent.includes('2 playlists selected'),
  );
  for (const i of [2, 3]) assert.equal(await box(i).isChecked(), true, `row ${i} still checked`);
  for (const i of [4, 5, 6]) assert.equal(await box(i).isChecked(), false, `row ${i} cleared`);

  await page.click('#btnPickerClose');
  await page.waitForSelector('#pickerBackdrop[hidden]', { state: 'hidden' });
});

test('the A–Z rail lights only the letters that have something in them', async () => {
  await page.click('#btnReset');
  await page.waitForSelector('.alpha');

  const lit = await page.locator('.alpha:not(.is-empty):not(.is-on)').allTextContents();
  // Aphex Twin, Björk + Boards of Canada, Radiohead, Slowdive, Talk Talk.
  assert.deepEqual(lit, ['A', 'B', 'R', 'S', 'T']);
  // 26 letters, Å Ä Ö, and '#', less the five that have results.
  assert.equal(await page.locator('.alpha.is-empty:disabled').count(), 25);
});

test('picking a letter narrows the grid to that initial', async () => {
  await page.click('.alpha:text-is("B")');
  await page.waitForFunction(() => document.querySelectorAll('.album').length === 2);

  const artists = await page.locator('.album .album-artist').allTextContents();
  assert.deepEqual([...artists].sort(), ['Björk', 'Boards of Canada'], 'Björk files under B');

  // Clicking the same letter again clears it.
  await page.click('.alpha.is-on:text-is("B")');
  await page.waitForFunction(() => document.querySelectorAll('.album').length === 6);
});

test('browsing by album re-buckets on the album name', async () => {
  await page.selectOption('#alphaKey', 'album');
  await page.waitForSelector('.alpha:not(.is-empty)');

  await page.click('.alpha:text-is("K")');
  await page.waitForFunction(() => document.querySelectorAll('.album').length === 1);
  assert.match(await page.textContent('.album .album-title'), /Kid A/);

  await page.click('#btnReset');
  await page.selectOption('#alphaKey', 'artist');
  await page.waitForFunction(() => document.querySelectorAll('.album').length === 6);
});

test('the picker shows a full year of months without scrolling', async () => {
  // A 13" MacBook viewport. Twelve rows is the point: a year at a glance.
  await page.setViewportSize({ width: 1470, height: 830 });
  await page.click('#btnPlaylists');
  await page.waitForSelector('.picker-row');

  const visible = await page.evaluate(() => {
    const box = document.getElementById('pickerList').getBoundingClientRect();
    return [...document.querySelectorAll('.picker-row')].filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
    }).length;
  });
  assert.ok(visible >= 12, `expected 12+ rows in view, got ${visible}`);

  // The modal itself must still fit the viewport rather than overflow it.
  const fits = await page.evaluate(() => {
    const m = document.querySelector('#pickerBackdrop .modal').getBoundingClientRect();
    return m.top >= -0.5 && m.bottom <= window.innerHeight + 0.5;
  });
  assert.ok(fits, 'the modal fits on screen');

  await page.click('#btnPickerClose');
});

test('the action sheet works on a phone', async () => {
  // iPhone-ish viewport.
  await page.setViewportSize({ width: 390, height: 700 });
  await page.click('#btnReset');
  await page.waitForSelector('.album');

  await page.locator('.album .album-art').first().click();
  await page.waitForSelector('#sheetBackdrop:not([hidden])');

  const fits = await page.evaluate(() => {
    const m = document.querySelector('#sheetBackdrop .modal').getBoundingClientRect();
    const play = document.getElementById('sheetPlay').getBoundingClientRect();
    return {
      onScreen: m.left >= -0.5 && m.right <= window.innerWidth + 0.5
        && m.bottom <= window.innerHeight + 0.5,
      // Anchored to the bottom, where a thumb reaches.
      atBottom: Math.abs(m.bottom - window.innerHeight) < 2,
      tapHeight: play.height,
    };
  });
  assert.ok(fits.onScreen, 'the sheet fits the viewport');
  assert.ok(fits.atBottom, 'the sheet sits at the bottom of the screen');
  assert.ok(fits.tapHeight >= 44, `tap targets are at least 44px, got ${fits.tapHeight}`);

  await page.keyboard.press('Escape');
  await page.waitForSelector('#sheetBackdrop[hidden]', { state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('the UI calls itself Personal Spotify', async () => {
  assert.equal(await page.textContent('.topbar h1'), 'Personal Spotify');
  assert.match(await page.title(), /Personal Spotify/);
});

test('browsing by year filed uses Spotify\u2019s own added_at dates', async () => {
  await page.click('#btnReset');
  await page.waitForSelector('.album');
  await page.selectOption('#alphaKey', 'filed');
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll('.alpha')].map((b) => b.textContent);
    return labels.length > 1 && labels.slice(1).every((l) => /^(\d{4}|\u2014)$/.test(l));
  });

  const years = await page.locator('.alpha:not(:text-is("All"))').allTextContents();
  // Newest first: the rail reads like a timeline, not an alphabet.
  assert.deepEqual(years, [...years].sort().reverse(), 'years run newest first');
  assert.ok(years.includes('2019'), `expected 2019 among ${years.join(',')}`);

  await page.click('.alpha:text-is("2019")');
  await page.waitForFunction(() => document.querySelectorAll('.album').length > 0);
  const shown = await page.locator('.album').count();
  assert.ok(shown > 0, 'the year bucket has albums in it');

  await page.click('#btnReset');
  await page.selectOption('#alphaKey', 'artist');
  await showsAlbums(page, ALL_ALBUMS);
});

test('nothing threw along the way', () => {
  assert.deepEqual(consoleErrors, []);
});
