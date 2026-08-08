import { db } from './db.js';
import {
  api, SpotifyError, setWaitReporter, cooldownRemaining, describeDuration,
  cancelInFlight, resetCancel, setPacing, BULK_PACING_MS, clearCooldown, setCooldown,
  setRateBudget,
} from './api.js';
import * as auth from './auth.js';
import * as cloud from './cloud.js';
import {
  buildLibrary, groupAlbums, search, sortResults, facets, SORTS,
  alphaCounts, initialOf, artUrl, filedYearOf, yearCounts, byBucket,
} from './library.js';

// --- tiny DOM helper -------------------------------------------------------
// Building nodes instead of innerHTML means a track called
// `<script>alert(1)</script>` is just an oddly named track.

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const $ = (id) => document.getElementById(id);

// --- formatting ------------------------------------------------------------

function duration(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function monthLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', year: 'numeric' });
}

function dateLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// --- state -----------------------------------------------------------------

const PAGE = 60;
const LS_PREFS = 'crate.prefs';
const LS_DEVICE = 'crate.deviceId';

// Spotify takes the whole URI list as the queue in one call; a few hundred is
// more than anyone listens through in a sitting and keeps the request small.
const PLAY_CAP = 200;
// Queueing costs one request per track, so this one has to stay modest.
const QUEUE_CAP = 50;

const state = {
  cached: [],          // playlist records from IndexedDB, tracks included
  catalog: [],         // every playlist on the account (picker source)
  selectedPlaylists: new Set(),
  library: { tracks: [] },
  view: 'albums',
  sort: 'relevance',
  query: '',
  filters: { playlistIds: null, yearFrom: null, yearTo: null, addedFrom: null, addedTo: null },
  selection: new Set(),
  expanded: new Set(),
  shuffleSeed: 1,
  rendered: PAGE,
  items: [],
  matched: [],
  lastSync: null,
  cancelSync: false,
  me: null,
  devices: [],
  deviceId: localStorage.getItem(LS_DEVICE) || '',
  alphaKey: 'artist',  // which name the A–Z rail indexes
  letter: null,        // selected bucket, or null for everything
};

// The name an item files under, per browse key. Albums and tracks both carry
// an artist line, so one function covers both views.
function alphaNameOf(item) {
  if (state.alphaKey === 'artist') return item.artistLine || '';
  if (state.alphaKey === 'album') return item.albumName || item.name || '';
  return item.name || '';
}

// The rail bucket an item belongs to: a letter, or a filing year. `added_at`
// comes straight from Spotify per track, so no playlist-name guessing is
// needed — the dates are exact even where the naming never settled.
function bucketOf(item) {
  return state.alphaKey === 'filed' ? filedYearOf(item) : initialOf(alphaNameOf(item));
}

function savePrefs() {
  localStorage.setItem(LS_PREFS, JSON.stringify({ view: state.view, sort: state.sort }));
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_PREFS));
    if (p && p.view) state.view = p.view;
    if (p && p.sort) state.sort = p.sort;
  } catch { /* first run */ }
}

// --- banners ---------------------------------------------------------------

let bannerTimer = null;

// `actions` put buttons in the banner: some refusals are ours, and the user
// needs a way out that does not involve a console on a phone.
function banner(message, kind = 'error', actions = null) {
  const el = $('banner');
  clearTimeout(bannerTimer);
  if (!message) { el.hidden = true; return; }
  el.textContent = '';
  el.append(h('span', { text: message }));

  const list = Array.isArray(actions) ? actions : [actions].filter(Boolean);
  if (list.length) {
    el.append(h(
      'span',
      { class: 'banner-actions' },
      list.map((a, i) => h('button', {
        id: a.id || (i === 0 ? 'bannerAction' : `bannerAction${i + 1}`),
        class: 'btn btn-small',
        text: a.label,
        onclick: a.onClick,
      })),
    ));
  }
  el.className = kind === 'ok' || kind === 'warn' ? `banner ${kind}` : 'banner';
  el.hidden = false;
  if (kind === 'ok') bannerTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function describeError(err) {
  if (err && err.cancelled) return 'Cancelled.';
  if (err instanceof SpotifyError && err.status === 403) {
    return `Spotify refused the request (403). If your developer app is in development mode, `
      + `add your own Spotify account under the app's "User Management" settings. (${err.message})`;
  }
  return err && err.message ? err.message : String(err);
}

// --- progress overlay ------------------------------------------------------

function showProgress(title) {
  state.cancelSync = false;
  resetCancel();
  $('progressTitle').textContent = title;
  $('progressText').textContent = '';
  $('progressBar').style.width = '0%';
  $('progressBackdrop').hidden = false;
}

function setProgress(text, done, total) {
  $('progressText').textContent = text;
  if (total > 0) $('progressBar').style.width = `${Math.round((done / total) * 100)}%`;
}

function hideProgress() {
  $('progressBackdrop').hidden = true;
}

// Spotify's backoff can run for minutes. Say so, and put the old line back
// afterwards so the caller's own progress text is not lost.
let textBeforeWait = null;
setWaitReporter((secondsLeft) => {
  const el = $('progressText');
  if (!el) return;
  if (secondsLeft > 0) {
    if (textBeforeWait === null) textBeforeWait = el.textContent;
    el.textContent = `Spotify rate-limited us — retrying in ${secondsLeft}s`;
  } else {
    el.textContent = textBeforeWait || '';
    textBeforeWait = null;
  }
});

// --- sync ------------------------------------------------------------------

async function loadCache() {
  state.cached = await db.getAllPlaylists();
  const saved = await db.getMeta('selectedPlaylistIds');
  state.selectedPlaylists = new Set(saved || state.cached.map((p) => p.id));
  state.lastSync = await db.getMeta('lastSync');
  state.library = buildLibrary(
    state.cached.filter((p) => state.selectedPlaylists.has(p.id)),
  );
}

async function fetchCatalog() {
  const held = cooldownRemaining();
  if (held) {
    throw new SpotifyError(
      429,
      `Spotify is rate-limiting this app — waiting ${describeDuration(held)}.`,
    );
  }
  showProgress('Reading your playlists');
  setPacing(BULK_PACING_MS);
  try {
    state.catalog = await api.myPlaylists((n, total) => {
      setProgress(`${n} of ${total || '?'} playlists`, n, total);
    });
    await db.setMeta('catalog', state.catalog);
  } finally {
    setPacing(0);
    hideProgress();
  }
  return state.catalog;
}

async function sync({ full = false } = {}) {
  const held = cooldownRemaining();
  if (held) {
    banner(
      `Spotify is still rate-limiting this app — waiting ${describeDuration(held)}.`
      + ' Syncing now would probably extend it.',
      'warn',
      [
        { id: 'btnAskLimit', label: 'Ask Spotify', onClick: checkRateLimit },
        {
          id: 'bannerAction',
          label: 'Try anyway',
          onClick: () => { clearCooldown(); banner(''); sync({ full }); },
        },
      ],
    );
    return;
  }

  const wanted = [...state.selectedPlaylists];
  if (!wanted.length) {
    banner('No playlists selected yet — pick the monthly ones first.');
    return;
  }

  showProgress('Syncing your crate');
  setPacing(BULK_PACING_MS);

  // A first sync on a new device fetches everything. Say why it is slow before
  // the silence starts looking like a hang.
  const firstRun = state.cached.length === 0 && wanted.length > 10;
  if (firstRun) {
    const mins = Math.max(1, Math.round((wanted.length * 2 * BULK_PACING_MS) / 60000));
    setProgress(
      `First sync of ${plural(wanted.length, 'playlist', 'playlists')} — deliberately`
      + ` paced to stay under Spotify's rate limit. Roughly ${mins} min. Leave this open.`,
      0,
      0,
    );
  }

  try {
    if (!state.catalog.length) {
      state.catalog = (await db.getMeta('catalog')) || [];
    }
    // Which account the token actually belongs to: a 403 never says, and it
    // has to match the account allowlisted on the developer app.
    try {
      const who = await api.me();
      console.info('[crate] signed in as', JSON.stringify({
        id: who && who.id, name: who && who.display_name, product: who && who.product,
      }));
    } catch (err) {
      console.warn('[crate] could not read the account:', err && err.message);
    }

    // Refresh the catalog so snapshot IDs (and any new months) are current.
    setProgress('Checking for changes…', 0, 0);
    state.catalog = await api.myPlaylists();
    await db.setMeta('catalog', state.catalog);

    const byId = new Map(state.catalog.map((p) => [p.id, p]));
    const cachedById = new Map(state.cached.map((p) => [p.id, p]));

    // Drop anything no longer in the crate so it stops polluting search.
    for (const cached of state.cached) {
      if (!state.selectedPlaylists.has(cached.id)) {
        await db.deletePlaylist(cached.id);
      }
    }

    let done = 0;
    let fetched = 0;
    let limitHit = null;
    const skipped = [];

    for (const id of wanted) {
      if (state.cancelSync) break;

      const meta = byId.get(id);
      const cached = cachedById.get(id);
      done += 1;

      if (!meta) {
        // Deleted or no longer visible on the account; keep whatever we cached.
        continue;
      }

      // snapshot_id changes whenever a playlist's contents change. Unchanged
      // playlists cost nothing, which is what makes a 180-playlist resync cheap.
      const unchanged = cached && cached.snapshotId === meta.snapshotId && !full;
      if (unchanged) {
        setProgress(`${meta.name} — unchanged (${done}/${wanted.length})`, done, wanted.length);
        continue;
      }

      setProgress(`${meta.name} (${done}/${wanted.length})`, done, wanted.length);
      try {
        const tracks = await api.playlistTracks(id);
        await db.putPlaylist({ ...meta, tracks, syncedAt: new Date().toISOString() });
        fetched += 1;
      } catch (err) {
        // A rate limit is not a property of this playlist: carrying on would
        // attempt the remaining 190 and deepen the penalty. Stop the run.
        if (err instanceof SpotifyError && err.status === 429) {
          limitHit = err;
          break;
        }
        // One unreadable playlist must not cost the other 179. Spotify 403s
        // editorial and algorithmic lists for apps in development mode, and a
        // playlist can vanish mid-sync; keep going and report it at the end.
        skipped.push({ name: meta.name, reason: err && err.message ? err.message : String(err) });
      }
    }

    state.lastSync = new Date().toISOString();
    await db.setMeta('lastSync', state.lastSync);
    await db.setMeta('selectedPlaylistIds', [...state.selectedPlaylists]);
    await loadCache();
    // Best effort: a failed upload must never look like a failed sync.
    pushToCloud().catch((err) => console.warn('[crate] cloud push failed:', err && err.message));

    if (limitHit) {
      // Everything fetched so far is already saved, and a later run resumes
      // from there, so this is a pause rather than a failure.
      banner(
        `${limitHit.message} Kept the ${plural(fetched, 'playlist', 'playlists')} already read`
        + ' — syncing again later picks up where this stopped.',
        'warn',
        { label: 'Ask Spotify', onClick: checkRateLimit },
      );
      return;
    }

    const unchanged = wanted.length - fetched - skipped.length;
    let message = state.cancelSync
      ? 'Sync cancelled — kept what had already been fetched.'
      : `Synced ${plural(wanted.length - skipped.length, 'playlist', 'playlists')}`
        + ` (${fetched} refetched, ${unchanged} unchanged),`
        + ` ${plural(state.library.tracks.length, 'unique track', 'unique tracks')}.`;
    if (skipped.length) {
      const names = skipped.slice(0, 3).map((s) => s.name).join(', ');
      message += ` Skipped ${plural(skipped.length, 'playlist', 'playlists')} Spotify would not`
        + ` return: ${names}${skipped.length > 3 ? `, and ${skipped.length - 3} more` : ''}`
        + ` (${skipped[0].reason}).`;
    }
    banner(message, skipped.length ? 'warn' : 'ok');
  } catch (err) {
    banner(describeError(err));
  } finally {
    setPacing(0);
    hideProgress();
    render();
  }
}

// --- playlist picker -------------------------------------------------------

let pickerDraft = new Set();
let pickerAnchorId = null; // last plainly-clicked row; shift-click ranges from here
let pickerScope = 'all';   // all | in | out

// Already fetched and searchable, as opposed to merely ticked in this session.
function inCrate(id) {
  return state.cached.some((p) => p.id === id);
}

function visiblePlaylists() {
  const filter = $('pickerFilter').value.trim().toLowerCase();
  return state.catalog.filter((p) => {
    if (filter && !p.name.toLowerCase().includes(filter)) return false;
    if (pickerScope === 'in') return inCrate(p.id);
    if (pickerScope === 'out') return !inCrate(p.id);
    return true;
  });
}

function renderPicker() {
  const list = $('pickerList');
  list.textContent = '';

  const visible = visiblePlaylists();

  for (const btn of $('pickerScope').querySelectorAll('button')) {
    btn.classList.toggle('is-on', btn.dataset.scope === pickerScope);
  }

  if (!visible.length) {
    list.append(h('div', {
      class: 'empty',
      text: pickerScope === 'out'
        ? 'Every playlist that matches is already in your crate.'
        : 'No playlists match that filter.',
    }));
  }

  visible.forEach((p, idx) => {
    const box = h('input', {
      type: 'checkbox',
      id: `pick-${p.id}`,
      checked: pickerDraft.has(p.id),
      // click, not change: only MouseEvent carries shiftKey
      onclick: (e) => {
        const on = e.target.checked;
        const anchor = visible.findIndex((v) => v.id === pickerAnchorId);
        if (e.shiftKey && anchor !== -1) {
          const [lo, hi] = anchor < idx ? [anchor, idx] : [idx, anchor];
          for (let i = lo; i <= hi; i++) {
            if (on) pickerDraft.add(visible[i].id);
            else pickerDraft.delete(visible[i].id);
          }
          renderPicker();
          return;
        }
        if (on) pickerDraft.add(p.id);
        else pickerDraft.delete(p.id);
        pickerAnchorId = p.id;
        updatePickerCount();
      },
    });
    list.append(h(
      'div',
      { class: 'picker-row' },
      box,
      h('label', { for: `pick-${p.id}`, text: p.name }),
      inCrate(p.id)
        ? h('span', { class: 'in-crate', title: 'Already synced into your crate', text: 'in crate' })
        : null,
      h('span', { class: 'n', text: `${p.total}` }),
    ));
  });

  updatePickerCount();
}

function updatePickerCount() {
  const ticked = state.catalog.filter((p) => pickerDraft.has(p.id));
  const tracks = ticked.reduce((sum, p) => sum + p.total, 0);
  // Split the count so it is obvious what this save would actually change.
  const already = ticked.filter((p) => inCrate(p.id)).length;
  const added = ticked.length - already;
  const dropped = state.cached.filter((p) => !pickerDraft.has(p.id)).length;

  $('pickerCount').textContent = [
    `${plural(pickerDraft.size, 'playlist', 'playlists')} selected`,
    `${already} in crate`,
    added ? `${added} new` : null,
    dropped ? `${dropped} to remove` : null,
    `about ${plural(tracks, 'track', 'tracks')}`,
  ].filter(Boolean).join(' · ');
}

async function openPicker() {
  try {
    if (!state.catalog.length) {
      state.catalog = (await db.getMeta('catalog')) || [];
    }
    if (!state.catalog.length) await fetchCatalog();
  } catch (err) {
    banner(describeError(err));
    return;
  }
  pickerDraft = new Set(state.selectedPlaylists);
  pickerAnchorId = null;
  pickerScope = 'all';
  $('pickerFilter').value = '';
  renderPicker();
  $('pickerBackdrop').hidden = false;
  $('pickerFilter').focus();
}

// "Matching" means what is on screen, so the scope tabs narrow it too.
function matchingIds() {
  return visiblePlaylists().map((p) => p.id);
}

// --- rendering -------------------------------------------------------------

function tickButton(isOn, onToggle, label) {
  return h('button', {
    class: 'tick',
    'aria-pressed': isOn ? 'true' : 'false',
    'aria-label': label,
    title: label,
    onclick: (e) => { e.stopPropagation(); onToggle(); },
  }, '✓');
}

function monthTags(sources) {
  const shown = sources.slice(-3).reverse();
  const extra = sources.length - shown.length;

  return h(
    'div',
    { class: 'months' },
    shown.map((s) => h('button', {
      class: 'month-tag',
      title: `Only show ${s.playlistName}${s.addedAt ? ` · added ${new Date(s.addedAt).toLocaleDateString()}` : ''}`,
      onclick: () => filterToPlaylist(s.playlistId),
      text: s.playlistName,
    })),
    extra > 0 ? h('span', { class: 'month-tag', text: `+${extra} more` }) : null,
  );
}

function albumCard(album) {
  const trackIds = album.tracks.map((t) => t.id);
  const allSelected = trackIds.every((id) => state.selection.has(id));
  const isOpen = state.expanded.has(album.id);
  const filings = album.sourceList.length;

  const art = album.image
    // Spotify's smallest art is 64px; the grid renders at ~180. Ask for 300.
    ? h('img', { src: artUrl(album.image, 'medium'), alt: '', loading: 'lazy' })
    : h('div', { class: 'noart', text: '♫' });

  return h(
    'article',
    { class: `album${allSelected ? ' is-selected' : ''}` },
    h(
      'div',
      {
        // The whole cover is the target: a 22px tick is a poor tap on a phone,
        // and the toolbar with the play controls scrolls out of reach.
        class: 'album-art',
        role: 'button',
        tabindex: '0',
        'aria-label': `Actions for ${album.name || 'this album'}`,
        onclick: () => openSheet(album),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(album); }
        },
      },
      tickButton(allSelected, () => {
        if (allSelected) trackIds.forEach((id) => state.selection.delete(id));
        else trackIds.forEach((id) => state.selection.add(id));
        render();
      }, allSelected ? 'Deselect album' : 'Select album'),
      art,
    ),
    h(
      'div',
      { class: 'album-meta' },
      album.id.startsWith('noalbum:')
        ? h('div', { class: 'album-title', text: album.name || 'Unknown album' })
        : h('a', {
          class: 'album-title',
          href: `https://open.spotify.com/album/${album.id}`,
          target: '_blank',
          rel: 'noreferrer',
          text: album.name || 'Unknown album',
        }),
      h('div', { class: 'album-artist', text: album.artistLine }),
      h(
        'div',
        { class: 'album-sub' },
        album.year ? h('span', { class: 'pill', text: album.year }) : null,
        h('span', {
          class: filings > 1 ? 'pill hot' : 'pill',
          title: filings > 1
            ? `Filed in ${filings} different monthly playlists`
            : 'The month you filed this in',
          text: filings > 1 ? `in ${filings} months` : monthLabel(album.lastAdded),
        }),
        h('span', { class: 'pill', text: plural(album.tracks.length, 'track', 'tracks') }),
      ),
      monthTags(album.sourceList),
      h(
        'div',
        { class: 'album-actions' },
        ...playButtons(album.tracks, album.name || 'this album'),
        h('button', {
          class: 'linkbtn',
          text: isOpen ? 'Hide tracks' : `Show ${album.tracks.length} track${album.tracks.length === 1 ? '' : 's'}`,
          onclick: () => {
            if (isOpen) state.expanded.delete(album.id);
            else state.expanded.add(album.id);
            render();
          },
        }),
      ),
      isOpen ? h(
        'ul',
        { class: 'tracklist' },
        album.tracks.map((t) => h(
          'li',
          {},
          h('a', {
            href: `https://open.spotify.com/track/${t.id}`,
            target: '_blank',
            rel: 'noreferrer',
            text: t.name,
          }),
          h('span', { class: 'dur', text: duration(t.durationMs) }),
        )),
      ) : null,
    ),
  );
}

function trackRow(t) {
  const selected = state.selection.has(t.id);
  const last = t.sources[t.sources.length - 1];

  return h(
    'div',
    { class: `row${selected ? ' is-selected' : ''}` },
    tickButton(selected, () => {
      if (selected) state.selection.delete(t.id);
      else state.selection.add(t.id);
      render();
    }, selected ? 'Deselect track' : 'Select track'),
    t.albumImage
      ? h('img', { src: t.albumImage, alt: '', loading: 'lazy' })
      : h('div', { class: 'cell', text: '' }),
    h('div', { class: 'cell' }, h('a', {
      href: `https://open.spotify.com/track/${t.id}`,
      target: '_blank',
      rel: 'noreferrer',
      text: t.name,
    })),
    h('div', { class: 'cell sub', text: t.artistLine }),
    h('div', { class: 'cell playcell' }, ...playButtons([t], t.name)),
    h('div', { class: 'num hide-sm', text: t.year || '' }),
    h(
      'div',
      { class: 'cell sub hide-sm', title: `Filed ${dateLabel(last && last.addedAt)}` },
      h('button', {
        class: 'linkbtn',
        title: 'Only show this playlist',
        onclick: () => filterToPlaylist(last.playlistId),
        text: last ? last.playlistName : '',
      }),
      t.sources.length > 1 ? h('span', { class: 'sub', text: ` +${t.sources.length - 1}` }) : null,
    ),
    h('div', { class: 'num', text: duration(t.durationMs) }),
  );
}

function renderAlpha() {
  const bar = $('alphaBar');
  bar.hidden = !state.library.tracks.length;
  if (bar.hidden) return;

  // Browsing by track name is meaningless when the rows are albums.
  const keySel = $('alphaKey');
  const trackOpt = keySel.querySelector('option[value="track"]');
  trackOpt.hidden = state.view === 'albums';
  $('alphaRail').classList.toggle('is-years', state.alphaKey === 'filed');
  if (state.view === 'albums' && state.alphaKey === 'track') state.alphaKey = 'album';
  keySel.value = state.alphaKey;

  const rail = $('alphaRail');
  rail.textContent = '';

  const total = [...state.alphaCounts.values()].reduce((a, b) => a + b, 0);
  rail.append(h('button', {
    class: `alpha${state.letter ? '' : ' is-on'}`,
    text: 'All',
    title: `${total} shown`,
    onclick: () => { state.letter = null; render(); },
  }));

  for (const [letter, n] of state.alphaCounts) {
    // eslint-disable-next-line no-continue
    rail.append(h('button', {
      // An empty letter stays visible but unclickable: the gap is information.
      class: `alpha${state.letter === letter ? ' is-on' : ''}${n ? '' : ' is-empty'}`,
      text: letter,
      title: n ? `${plural(n, 'result', 'results')}` : 'nothing here',
      disabled: !n,
      'aria-pressed': state.letter === letter ? 'true' : 'false',
      onclick: () => {
        state.letter = state.letter === letter ? null : letter;
        state.rendered = PAGE;
        render();
      },
    }));
  }
}

function renderFacets() {
  const f = facets(state.matched);

  const artistBox = $('facetArtists');
  artistBox.textContent = '';
  if (f.artists.length > 1) {
    artistBox.append(h('h3', { text: 'Artists here' }));
    artistBox.append(h(
      'ul',
      {},
      f.artists.map(([name, n]) => h('li', {}, h('button', {
        class: 'facet-item',
        title: name,
        onclick: () => addTerm(`artist:"${name}"`),
      }, h('span', { class: 'lbl', text: name }), h('span', { class: 'n', text: n })))),
    ));
  }

  const decadeBox = $('facetDecades');
  decadeBox.textContent = '';
  if (f.decades.length > 1) {
    decadeBox.append(h('h3', { text: 'Decades' }));
    decadeBox.append(h(
      'ul',
      {},
      f.decades.map(([decade, n]) => h('li', {}, h('button', {
        class: 'facet-item',
        onclick: () => {
          $('yearFrom').value = decade;
          $('yearTo').value = decade + 9;
          readFilters();
          render();
        },
      }, h('span', { class: 'lbl', text: `${decade}s` }), h('span', { class: 'n', text: n })))),
    ));
  }
}

function renderActiveFilters() {
  const box = $('activeFilters');
  box.textContent = '';
  const chips = [];

  if (state.filters.playlistIds && state.filters.playlistIds.size) {
    const names = state.cached
      .filter((p) => state.filters.playlistIds.has(p.id))
      .map((p) => p.name);
    chips.push([`Playlist: ${names.join(', ') || '?'}`, () => {
      state.filters.playlistIds = null;
      render();
    }]);
  }

  const { yearFrom, yearTo, addedFrom, addedTo } = state.filters;
  if (yearFrom !== null || yearTo !== null) {
    chips.push([`Released ${yearFrom ?? '…'}–${yearTo ?? '…'}`, () => {
      $('yearFrom').value = '';
      $('yearTo').value = '';
      readFilters();
      render();
    }]);
  }
  if (addedFrom !== null || addedTo !== null) {
    chips.push([`Filed ${addedFrom ?? '…'}–${addedTo ?? '…'}`, () => {
      $('addedFrom').value = '';
      $('addedTo').value = '';
      readFilters();
      render();
    }]);
  }

  for (const [label, onClear] of chips) {
    box.append(h('button', { class: 'chip', onclick: onClear },
      h('span', { text: label }), h('span', { class: 'x', text: '×' })));
  }
  box.hidden = chips.length === 0;
}

function renderResults() {
  const box = $('results');
  box.textContent = '';

  if (!state.library.tracks.length) {
    box.append(h(
      'div',
      { class: 'empty' },
      h('h2', { text: 'Your crate is empty' }),
      h('p', { text: 'Choose which playlists belong in it, then sync.' }),
      h(
        'p',
        {},
        h('button', { class: 'btn btn-primary', onclick: openPicker, text: 'Choose playlists' }),
      ),
      // Reading from Spotify takes minutes on a new device; this takes one request.
      h(
        'p',
        {},
        h('button', {
          id: 'btnRestore',
          class: 'btn btn-quiet btn-small',
          onclick: () => { pullFromCloud(); },
          text: 'Restore from another device',
        }),
        h('button', {
          id: 'btnCheckLimit',
          class: 'btn btn-quiet btn-small',
          onclick: checkRateLimit,
          text: 'Check rate limit',
        }),
      ),
    ));
    return;
  }

  if (!state.items.length) {
    box.append(h(
      'div',
      { class: 'empty' },
      h('h2', { text: 'Nothing matches' }),
      h('p', { text: 'Try fewer words, or drop a filter.' }),
    ));
    return;
  }

  const slice = state.items.slice(0, state.rendered);

  if (state.view === 'albums') {
    box.append(h('div', { class: 'grid' }, slice.map(albumCard)));
  } else {
    box.append(h('div', { class: 'rows' }, slice.map(trackRow)));
  }

  if (state.items.length > state.rendered) {
    box.append(h('div', { class: 'empty' }, h('button', {
      class: 'btn',
      text: `Show more (${(state.items.length - state.rendered).toLocaleString()} left)`,
      onclick: () => { state.rendered += PAGE; render(); },
    })));
  }
}

function selectedTrackIds() {
  if (state.selection.size) {
    // Keep the on-screen order rather than Set insertion order.
    const inOrder = [];
    const seen = new Set();
    const pool = state.view === 'albums'
      ? state.items.flatMap((a) => a.tracks)
      : state.items;
    for (const t of pool) {
      if (state.selection.has(t.id) && !seen.has(t.id)) { seen.add(t.id); inOrder.push(t.id); }
    }
    // Anything selected then filtered out of view still counts.
    for (const id of state.selection) if (!seen.has(id)) inOrder.push(id);
    return inOrder;
  }
  return state.view === 'albums'
    ? state.items.flatMap((a) => a.tracks).map((t) => t.id)
    : state.items.map((t) => t.id);
}

function renderCounts() {
  const nAlbums = state.view === 'albums'
    ? state.items.length
    : groupAlbums(state.matched).length;

  $('count').textContent = state.library.tracks.length
    ? `${plural(state.matched.length, 'track', 'tracks')} · ${plural(nAlbums, 'album', 'albums')}`
      // Count what the library was actually built from, not what was selected:
      // a playlist Spotify refuses to serve contributes nothing.
      + ` · from ${plural(
        state.cached.filter((p) => state.selectedPlaylists.has(p.id)).length,
        'playlist',
        'playlists',
      )}`
      + (state.lastSync ? ` · synced ${dateLabel(state.lastSync)}` : '')
    : '';

  const hasSel = state.selection.size > 0;
  $('selectionInfo').hidden = !hasSel;
  $('selectionInfo').textContent = hasSel ? `${plural(state.selection.size, 'track', 'tracks')} selected` : '';
  $('btnClearSel').hidden = !hasSel;
  $('btnSelectAll').hidden = !state.items.length;
  $('btnExport').hidden = !state.items.length;
  $('btnPlayAll').hidden = !state.items.length;
  $('btnQueueAll').hidden = !state.items.length;
  $('btnPlayAll').textContent = hasSel ? 'Play selection' : 'Play these';
  $('btnQueueAll').textContent = hasSel ? 'Queue selection' : 'Queue these';
  $('btnExport').textContent = hasSel
    ? `Save ${state.selection.size} to a playlist`
    : 'Save these results as a playlist';
}

function render() {
  state.matched = search(state.library.tracks, state.query, state.filters);

  const base = state.view === 'albums' ? groupAlbums(state.matched) : state.matched;
  // Count before the bucket filter, so the rail always shows the shape of the
  // current search rather than of the bucket you already picked.
  state.alphaCounts = state.alphaKey === 'filed'
    ? yearCounts(base)
    : alphaCounts(base.map(alphaNameOf));
  if (state.letter && !state.alphaCounts.get(state.letter)) state.letter = null;

  state.items = sortResults(
    byBucket(base, state.letter, bucketOf),
    state.sort,
    state.shuffleSeed,
  );

  renderAlpha();
  renderActiveFilters();
  renderResults();
  renderFacets();
  renderCounts();
}

// --- interactions ----------------------------------------------------------

function addTerm(term) {
  const q = $('q').value.trim();
  if (q.includes(term)) return;
  $('q').value = q ? `${q} ${term}` : term;
  state.query = $('q').value;
  state.rendered = PAGE;
  $('btnClear').hidden = !state.query;
  render();
}

function filterToPlaylist(id) {
  state.filters.playlistIds = new Set([id]);
  state.rendered = PAGE;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function numOrNull(input) {
  const v = parseInt(input.value, 10);
  return Number.isFinite(v) ? v : null;
}

function readFilters() {
  state.filters.yearFrom = numOrNull($('yearFrom'));
  state.filters.yearTo = numOrNull($('yearTo'));
  state.filters.addedFrom = numOrNull($('addedFrom'));
  state.filters.addedTo = numOrNull($('addedTo'));
  state.rendered = PAGE;
}

// --- rate-limit check ------------------------------------------------------

// The browser cannot read Retry-After, so the server reads it for us and we
// believe that number instead of guessing at a cooldown.
async function checkRateLimit() {
  banner('Asking Spotify…', 'warn');
  try {
    const r = await cloud.probeSpotify();
    if (r.ok) {
      clearCooldown();
      // A device with nothing selected cannot sync; sending it to Sync just
      // produces "No playlists selected yet".
      const ready = state.selectedPlaylists.size > 0;
      banner('Spotify is answering again.', 'ok', ready
        ? { label: 'Sync now', onClick: () => { banner(''); sync(); } }
        : { label: 'Choose playlists', onClick: () => { banner(''); openPicker(); } });
      return;
    }

    if (r.status === 429 && r.retryAfterSeconds) {
      setCooldown(r.retryAfterSeconds);
      const at = new Date(r.retryAt);
      banner(
        `Spotify is rate-limiting this app for another ${describeDuration(r.retryAfterSeconds)}`
        + ` — until about ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        + ' Nothing to do but wait; asking again does not help.',
        'warn',
      );
      return;
    }

    banner(`Spotify answered ${r.status}. Not a rate limit.`, 'warn');
  } catch (err) {
    banner(describeError(err));
  }
}

// --- cross-device copy -----------------------------------------------------

const LS_PUSHED = 'crate.pushedSync';

async function pushToCloud() {
  const payload = cloud.snapshotOf(state.cached, state.selectedPlaylists, state.lastSync);
  const { bytes } = await cloud.push(payload);
  // Remember what was uploaded so a reload does not re-send 7MB for nothing.
  localStorage.setItem(LS_PUSHED, state.lastSync || '');
  console.info('[crate] cloud copy updated,', Math.round(bytes / 1024), 'kB');
}

// Tying the upload to a sync means you cannot back up while rate-limited —
// precisely when the copy matters most. Any load with unsaved changes does it,
// and with a stored pass this costs Spotify nothing.
async function backUpIfStale() {
  if (!state.cached.length || !state.lastSync) return;
  if (localStorage.getItem(LS_PUSHED) === state.lastSync) return;
  try {
    // Never overwrite a copy written after our own data was synced: that copy
    // came from another device and knows things this one does not.
    const stored = await cloud.storedAt();
    if (stored && new Date(stored) > new Date(state.lastSync)) {
      console.warn('[crate] stored copy is newer than this device; not overwriting it');
      banner(
        'Another device has a newer crate saved. Sync here to catch up, or restore it.',
        'warn',
        { label: 'Restore it', onClick: () => { banner(''); pullFromCloud(); } },
      );
      return;
    }
    await pushToCloud();
  } catch (err) {
    console.warn('[crate] cloud backup skipped:', err && err.message);
  }
}

async function pullFromCloud({ quiet = false } = {}) {
  showProgress('Fetching your saved crate');
  try {
    const data = await cloud.pull();
    if (!data) {
      // On boot this is the ordinary case, not a problem worth a banner.
      if (!quiet) banner('Nothing saved yet — sync on a device that has your crate first.');
      return false;
    }

    setProgress(`${plural(data.playlists.length, 'playlist', 'playlists')}…`, 0, 0);
    for (const p of data.playlists) {
      // eslint-disable-next-line no-await-in-loop
      await db.putPlaylist(p);
    }
    await db.setMeta('selectedPlaylistIds', data.selectedPlaylistIds || data.playlists.map((p) => p.id));
    if (data.lastSync) await db.setMeta('lastSync', data.lastSync);

    await loadCache();
    // We now hold exactly what the store holds: nothing to push back, and no
    // reason to warn that the store is ahead of us.
    localStorage.setItem(LS_PUSHED, state.lastSync || '');
    banner(
      `Restored ${plural(state.library.tracks.length, 'track', 'tracks')} from your saved crate`
      + ' — no Spotify requests needed.',
      'ok',
    );
    return true;
  } catch (err) {
    if (!quiet) banner(describeError(err));
    else console.warn('[crate] cloud restore skipped:', err && err.message);
    return false;
  } finally {
    hideProgress();
    render();
  }
}

// --- album action sheet ----------------------------------------------------

function closeSheet() {
  $('sheetBackdrop').hidden = true;
}

function openSheet(album) {
  const trackIds = album.tracks.map((t) => t.id);
  const allSelected = trackIds.every((id) => state.selection.has(id));
  const isOpen = state.expanded.has(album.id);

  $('sheetTitle').textContent = album.name || 'Unknown album';
  $('sheetArtist').textContent = album.artistLine || '';

  const art = $('sheetArt');
  art.hidden = !album.image;
  if (album.image) art.src = artUrl(album.image, 'medium');

  $('sheetPlay').onclick = () => { closeSheet(); playNow(album.tracks); };
  $('sheetQueue').onclick = () => { closeSheet(); queueTracks(album.tracks); };

  $('sheetSelect').textContent = allSelected ? 'Deselect album' : 'Select album';
  $('sheetSelect').onclick = () => {
    if (allSelected) trackIds.forEach((id) => state.selection.delete(id));
    else trackIds.forEach((id) => state.selection.add(id));
    closeSheet();
    render();
  };

  $('sheetTracks').textContent = isOpen
    ? 'Hide tracks'
    : `Show ${plural(album.tracks.length, 'track', 'tracks')}`;
  $('sheetTracks').onclick = () => {
    if (isOpen) state.expanded.delete(album.id);
    else state.expanded.add(album.id);
    closeSheet();
    render();
  };

  const link = $('sheetOpen');
  const external = !album.id.startsWith('noalbum:');
  link.hidden = !external;
  if (external) link.href = `https://open.spotify.com/album/${album.id}`;

  $('sheetBackdrop').hidden = false;
  $('sheetPlay').focus();
}

// --- playback --------------------------------------------------------------

function describePlaybackError(err) {
  if (err instanceof SpotifyError && err.status === 404) {
    return 'No active Spotify device. Open Spotify on a phone, desktop or speaker,'
      + ' play something for a second, then pick it from the device list.';
  }
  if (err instanceof SpotifyError && err.status === 403) {
    return `Spotify refused playback: ${err.message}.`
      + ' Controlling playback over the Web API needs a Premium account.';
  }
  return describeError(err);
}

async function loadDevices() {
  try {
    state.devices = await api.devices();
    if (!state.devices.some((d) => d.id === state.deviceId)) {
      const active = state.devices.find((d) => d.isActive);
      state.deviceId = active ? active.id : '';
      localStorage.setItem(LS_DEVICE, state.deviceId);
    }
  } catch (err) {
    console.warn('[crate] could not list devices:', err && err.message);
    state.devices = [];
  }
  renderDevices();
}

function renderDevices() {
  const sel = $('device');
  sel.textContent = '';
  if (!state.devices.length) {
    sel.append(h('option', { value: '', text: 'No devices — open Spotify' }));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const d of state.devices) {
    sel.append(h('option', {
      value: d.id,
      text: `${d.name}${d.isActive ? ' (active)' : ''}`,
      selected: d.id === state.deviceId,
    }));
  }
}

// The clicked tracks lead; everything still on screen follows, so one click on
// a search result plays the search.
function playQueueFrom(tracks) {
  const lead = tracks.map((t) => t.uri);
  const leadIds = new Set(tracks.map((t) => t.id));
  const rest = matchedTracks()
    .filter((t) => !leadIds.has(t.id))
    .map((t) => t.uri);
  return [...lead, ...rest].slice(0, PLAY_CAP);
}

function matchedTracks() {
  return state.view === 'albums'
    ? state.items.flatMap((a) => a.tracks || [])
    : state.matched;
}

async function playNow(tracks) {
  const uris = playQueueFrom(tracks);
  if (!uris.length) return;
  try {
    await api.play(uris, state.deviceId || undefined);
    banner(
      `Playing ${tracks.length === 1 ? tracks[0].name : plural(tracks.length, 'track', 'tracks')}`
      + `, then ${plural(uris.length - tracks.length, 'more track', 'more tracks')} from these`
      + ' results.',
      'ok',
    );
  } catch (err) {
    banner(describePlaybackError(err));
  }
  loadDevices();
}

async function queueTracks(tracks) {
  const uris = tracks.map((t) => t.uri).slice(0, QUEUE_CAP);
  if (!uris.length) return;
  const dropped = tracks.length - uris.length;
  try {
    if (uris.length > 4) showProgress('Queueing');
    await api.queue(uris, state.deviceId || undefined, (done, total) => {
      setProgress(`${done} of ${total} tracks`, done, total);
    });
    hideProgress();
    banner(
      `Queued ${plural(uris.length, 'track', 'tracks')}`
      + `${dropped ? `; skipped ${dropped} past the ${QUEUE_CAP}-track limit` : ''}.`,
      'ok',
    );
  } catch (err) {
    hideProgress();
    banner(describePlaybackError(err));
  }
  loadDevices();
}

// The bar acts on a selection when there is one, otherwise on everything shown.
function selectedOrMatchedTracks() {
  if (!state.selection.size) return matchedTracks();
  const byId = new Map(state.library.tracks.map((t) => [t.id, t]));
  return selectedTrackIds().map((id) => byId.get(id)).filter(Boolean);
}

function playButtons(tracks, label) {
  return [
    h('button', {
      class: 'linkbtn play',
      title: 'Play now',
      'aria-label': `Play ${label} now`,
      text: '▶',
      onclick: () => playNow(tracks),
    }),
    h('button', {
      class: 'linkbtn play',
      title: 'Add to queue',
      'aria-label': `Add ${label} to the queue`,
      text: '＋',
      onclick: () => queueTracks(tracks),
    }),
  ];
}

async function exportPlaylist() {
  const ids = selectedTrackIds();
  if (!ids.length) return;

  const byId = new Map(state.library.tracks.map((t) => [t.id, t]));
  const uris = ids.map((id) => byId.get(id)).filter(Boolean).map((t) => t.uri);

  // Spotify caps a playlist at 10,000 tracks.
  const capped = uris.slice(0, 10000);
  const suffix = state.query ? ` — ${state.query}` : '';
  const name = window.prompt(
    `Name for the new playlist (${plural(capped.length, 'track', 'tracks')}):`,
    `Personal Spotify${suffix}`.slice(0, 100),
  );
  if (name === null) return;

  showProgress('Creating playlist');
  try {
    if (!state.me) state.me = await api.me();
    const playlist = await api.createPlaylist(state.me.id, {
      name: name.trim() || 'Personal Spotify',
      description: `Built with Personal Spotify from ${state.selectedPlaylists.size} playlists`
        + `${state.query ? ` · query: ${state.query}` : ''}`,
      isPublic: false,
    });
    await api.addTracks(playlist.id, capped, (done, total) => {
      setProgress(`${done} of ${total} tracks`, done, total);
    });
    hideProgress();
    banner(`Created “${playlist.name}” with ${plural(capped.length, 'track', 'tracks')}.`, 'ok');
    if (playlist.external_urls && playlist.external_urls.spotify) {
      window.open(playlist.external_urls.spotify, '_blank', 'noreferrer');
    }
  } catch (err) {
    banner(describeError(err));
  } finally {
    hideProgress();
  }
}

// --- wiring ----------------------------------------------------------------

function showSetup(show) {
  $('setup').hidden = !show;
  $('app').hidden = show;
  for (const id of ['btnPlaylists', 'btnSync', 'btnSignOut']) $(id).hidden = show;
  const bar = $('device').parentElement;
  if (bar) {
    $('device').hidden = show;
    bar.querySelector('.devicepick').hidden = show;
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function wire() {
  $('redirectUri').textContent = auth.redirectUri();
  if (window.location.protocol === 'file:') {
    $('redirectHint').textContent = 'Heads up: Spotify will not accept a file:// redirect. '
      + 'Serve this folder over http://127.0.0.1 instead — see the README.';
    $('redirectHint').className = 'hint bad';
  } else if (!/^https:|^http:\/\/(127\.0\.0\.1|\[::1\])/.test(window.location.origin)) {
    $('redirectHint').textContent = 'Spotify only accepts https:// or http://127.0.0.1 redirect URIs.';
    $('redirectHint').className = 'hint bad';
  }

  $('clientId').value = auth.getClientId();

  // Say what is wrong while they are still looking at the field, rather than
  // after a failed round trip to Spotify.
  const checkClientId = () => {
    const raw = $('clientId').value.trim();
    const hint = $('clientIdHint');
    if (!raw) {
      hint.textContent = '';
      hint.className = 'hint';
    } else if (/^[0-9a-f]{32}$/i.test(raw)) {
      hint.textContent = 'Looks right.';
      hint.className = 'hint ok';
    } else if (raw.startsWith('http')) {
      hint.textContent = 'That is a URL — you want the Client ID from the app\u2019s Settings page.';
      hint.className = 'hint bad';
    } else {
      hint.textContent = `A Client ID is 32 letters and digits; this is ${raw.length}.`;
      hint.className = 'hint bad';
    }
    return /^[0-9a-f]{32}$/i.test(raw);
  };
  $('clientId').addEventListener('input', checkClientId);
  $('clientId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnSignIn').click();
  });
  checkClientId();

  $('btnCopyRedirect').onclick = async () => {
    await navigator.clipboard.writeText(auth.redirectUri());
    banner('Redirect URI copied.', 'ok');
  };

  $('btnSignIn').onclick = async () => {
    const id = $('clientId').value.trim();
    if (!checkClientId()) {
      $('clientId').focus();
      banner(id
        ? 'That does not look like a Spotify Client ID (32 letters and digits).'
        : 'Paste your Client ID first — step 5 above.');
      return;
    }
    auth.setClientId(id);
    try {
      await auth.login();
    } catch (err) {
      banner(describeError(err));
    }
  };

  $('btnSignOut').onclick = () => {
    auth.logout();
    showSetup(true);
    banner('Signed out. Your cached crate is still here.', 'ok');
  };

  $('btnPlaylists').onclick = openPicker;
  $('btnSync').onclick = () => sync();

  // search
  const onQuery = debounce(() => {
    state.query = $('q').value;
    state.rendered = PAGE;
    $('btnClear').hidden = !state.query;
    render();
  }, 120);
  $('q').addEventListener('input', onQuery);

  $('btnClear').onclick = () => {
    $('q').value = '';
    state.query = '';
    state.rendered = PAGE;
    $('btnClear').hidden = true;
    render();
    $('q').focus();
  };

  // view toggle
  for (const seg of document.querySelectorAll('.seg')) {
    seg.onclick = () => {
      document.querySelectorAll('.seg').forEach((s) => s.classList.remove('is-active'));
      seg.classList.add('is-active');
      state.view = seg.dataset.view;
      state.rendered = PAGE;
      savePrefs();
      render();
    };
  }

  // sort
  const sortSel = $('sort');
  for (const [key, def] of Object.entries(SORTS)) {
    sortSel.append(h('option', { value: key, text: def.label }));
  }
  sortSel.value = state.sort;
  sortSel.onchange = () => {
    state.sort = sortSel.value;
    state.rendered = PAGE;
    savePrefs();
    render();
  };

  for (const id of ['yearFrom', 'yearTo', 'addedFrom', 'addedTo']) {
    $(id).addEventListener('input', debounce(() => { readFilters(); render(); }, 200));
  }

  $('btnShuffle').onclick = () => {
    state.shuffleSeed = Math.floor(Math.random() * 1e9) + 1;
    state.sort = 'random';
    sortSel.value = 'random';
    state.rendered = PAGE;
    render();
  };

  $('btnReset').onclick = () => {
    $('q').value = '';
    ['yearFrom', 'yearTo', 'addedFrom', 'addedTo'].forEach((id) => { $(id).value = ''; });
    state.query = '';
    state.filters.playlistIds = null;
    readFilters();
    state.selection.clear();
    state.expanded.clear();
    state.letter = null;
    $('btnClear').hidden = true;
    render();
  };

  $('btnSelectAll').onclick = () => {
    const pool = state.view === 'albums'
      ? state.items.flatMap((a) => a.tracks)
      : state.items;
    pool.forEach((t) => state.selection.add(t.id));
    render();
  };

  $('btnClearSel').onclick = () => { state.selection.clear(); render(); };
  $('btnExport').onclick = exportPlaylist;

  $('sheetClose').onclick = closeSheet;
  $('sheetBackdrop').onclick = (e) => {
    // Only the backdrop itself, never a click that bubbled out of the dialog.
    if (e.target === $('sheetBackdrop')) closeSheet();
  };

  $('device').onchange = (e) => {
    state.deviceId = e.target.value;
    localStorage.setItem(LS_DEVICE, state.deviceId);
  };
  $('alphaKey').onchange = (e) => {
    state.alphaKey = e.target.value;
    state.letter = null;
    state.rendered = PAGE;
    render();
  };
  $('btnPlayAll').onclick = () => playNow(selectedOrMatchedTracks());
  $('btnQueueAll').onclick = () => queueTracks(selectedOrMatchedTracks());

  // picker
  $('btnPickerClose').onclick = () => { $('pickerBackdrop').hidden = true; };
  $('pickerFilter').addEventListener('input', debounce(renderPicker, 150));
  $('pickerScope').onclick = (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    pickerScope = btn.dataset.scope;
    pickerAnchorId = null; // ranges must not span a list the user cannot see
    renderPicker();
  };
  $('btnPickMatching').onclick = () => {
    matchingIds().forEach((id) => pickerDraft.add(id));
    renderPicker();
  };
  $('btnUnpickMatching').onclick = () => {
    matchingIds().forEach((id) => pickerDraft.delete(id));
    renderPicker();
  };
  $('btnPickerSave').onclick = async () => {
    state.selectedPlaylists = new Set(pickerDraft);
    await db.setMeta('selectedPlaylistIds', [...state.selectedPlaylists]);
    $('pickerBackdrop').hidden = true;
    await sync();
  };

  $('btnCancelSync').onclick = () => {
    state.cancelSync = true;
    // Interrupt whatever is in flight — a backoff wait, a page fetch, pacing.
    cancelInFlight();
  };

  // Infinite scroll: cheaper than virtualising, and good enough for 60 at a time.
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.items.length > state.rendered) {
      state.rendered += PAGE;
      render();
    }
  }, { rootMargin: '600px' });
  io.observe($('sentinel'));

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('q') && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      $('q').focus();
      $('q').select();
    } else if (e.key === 'Escape') {
      // Innermost first: the sheet can sit over the rest.
      if (!$('sheetBackdrop').hidden) closeSheet();
      else if (!$('pickerBackdrop').hidden) $('pickerBackdrop').hidden = true;
      else if (document.activeElement === $('q')) $('btnClear').click();
    }
  });
}

const BUILD = 'v26.08.08.2';

// Exposed so tests can shrink the window; harmless in a browser.
window.__crateRateBudget = setRateBudget;

async function start() {
  console.info(`[crate] build ${BUILD}`);
  loadPrefs();
  wire();

  document.querySelectorAll('.seg').forEach((s) => {
    s.classList.toggle('is-active', s.dataset.view === state.view);
  });
  $('sort').value = state.sort;

  try {
    await auth.handleRedirect();
  } catch (err) {
    banner(describeError(err));
  }

  await loadCache();

  if (!auth.isLoggedIn()) {
    // The cache still works offline, so show it rather than a login wall.
    if (state.library.tracks.length) {
      showSetup(false);
      $('brandSub').textContent = 'offline — sign in again to sync';
      render();
    } else {
      showSetup(true);
    }
    return;
  }

  showSetup(false);
  $('brandSub').textContent = state.lastSync
    ? `${plural(state.library.tracks.length, 'track', 'tracks')} across `
      + `${plural(state.selectedPlaylists.size, 'playlist', 'playlists')}`
    : 'your monthly playlists, as one library';

  render();

  if (!state.cached.length) {
    // Before anything touches Spotify: a device with nothing cached would
    // otherwise re-read every playlist, minutes of paced requests that can end
    // in a lockout. If this account has a saved copy, one request replaces it.
    const restored = await pullFromCloud({ quiet: true });
    if (!restored) {
      banner('Signed in. Now choose which playlists make up your crate.', 'ok');
      await openPicker();
    }
  }

  // Devices are a Spotify call, so it waits until the crate is in hand.
  loadDevices();
  backUpIfStale();
}

start();
