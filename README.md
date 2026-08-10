# Crate

Fifteen years of monthly Spotify playlists are a great archive and a terrible
library: they are sorted by when you filed something, which is the one thing you
never remember. Crate takes those playlists, folds them into a single searchable
collection, and lets you dig through it by artist, album, year or month.

It is a static page. No build step, no account anywhere but Spotify. Your
playlists are cached in your own browser (IndexedDB) and searched locally, so
typing is instant and works offline once synced.

There is one small serverless function (`api/crate.js`), and it is optional: it
keeps a copy of your synced crate so a second device does not have to re-read
everything from Spotify. Host the folder without it and everything else still
works — the app just logs that the backup was skipped.

## What it does

- **Albums, not tracks.** You triage albums, but playlists store tracks — so the
  default view groups tracks back into the album they came from.
- **Deduplicates across months.** A record you filed in March 2019 and again in
  July 2021 is one result that tells you both, instead of two entries fifteen
  months apart. Sort by *Filed most often* to find the ones you kept returning to.
- **Keeps the chronology as a dimension, not a prison.** Every result shows which
  monthly playlists it came from; click one to pivot back into that month.
- **Search that understands the fields.** `artist:` `album:` `track:`
  `playlist:` `year:1998` `year:1990-1999` `"exact phrase"`, all combining with AND.
  Diacritics fold both ways, so `bjork` finds Björk.
- **Facets from the current results** — the artists and decades actually present
  in what you are looking at, as one-click filters.
- **Shuffle** for when you want the crate to surprise you rather than answer you.
- **Save any result set back to Spotify** as a new private playlist.
- **A cross-device copy**, if you deploy the function. A first sync on a new
  device is several hundred Spotify requests and tends to land in the rate
  limit; restoring the saved copy is one request.

## Setup

Spotify requires every app to be registered, even a personal one. This takes
about a minute and is a one-time cost.

1. **Serve the folder.** Spotify only accepts `https://` or `http://127.0.0.1`
   redirect URIs, so opening `index.html` from disk will not work:

   ```sh
   npm run serve          # or: python3 -m http.server 8765 --bind 127.0.0.1
   ```

   Then open <http://127.0.0.1:8765/>.

2. **Register an app** at the [Spotify developer dashboard](https://developer.spotify.com/dashboard):
   *Create app* → any name → set the **Redirect URI** to exactly
   `http://127.0.0.1:8765/` (the app shows you the exact string, with a copy
   button) → tick **Web API** → save.

   You do **not** need a new app per tool. A Spotify app accepts several
   redirect URIs, so if you are near the app limit, open an existing app and
   just add this one's URI to its list — then reuse that Client ID. The Client
   ID is not a secret; PKCE exists precisely so a browser app never needs the
   client secret.

3. **Paste the Client ID** from the app's settings into Crate and sign in.

4. **Pick your playlists.** Filter by name (e.g. type `2019`, or whatever you
   call your monthly lists), *Select matching*, repeat, then **Save and sync**.

## Deploying

Any static host works — Vercel, Netlify, GitHub Pages, an S3 bucket. There is
nothing to build; the repo root is the site.

`vercel.json` disables the build step and installs production dependencies only
(`npm install --omit=dev`). The `--omit=dev` matters: a plain install would see
Playwright in `devDependencies` and spend several minutes downloading Chromium
to deploy a page that needs no build at all.

Two things to get right:

- **Register the deployed URL as a redirect URI**, exactly as the app displays
  it (`https://your-app.vercel.app/`, trailing slash included). Spotify matches
  the string literally.
- **Use the production URL, not a preview one.** Vercel gives every deployment
  its own hostname, and those will not match the registered redirect URI, so
  sign-in fails on previews. Only the stable production domain will work unless
  you register each preview URL too.

Deploying publicly is safe: the page contains no credentials. The Client ID and
tokens are entered and stored in each visitor's own browser, so anyone else who
opens the URL just sees an empty setup screen.

Note that the browser cache is per-device. Syncing on your laptop does not
populate your phone — each device syncs its own copy from Spotify, unless you
set up the cross-device copy below.

### The cross-device copy (optional)

`api/crate.js` stores one JSON file per Spotify account so a new device can
restore the crate in a single request instead of several hundred. It needs two
things on Vercel:

- **A Blob store**, connected to the project (*Storage* → *Create* → *Blob* →
  *Connect*). That sets `BLOB_READ_WRITE_TOKEN`, which `@vercel/blob` picks up
  on its own.
- **`CRATE_SIGNING_SECRET`**, any long random string, set as an environment
  variable. Generate one with `openssl rand -base64 32`.

The secret signs a pass the function hands back after it has verified your token
with Spotify once. Later calls present the pass instead of a token, which is the
whole point: when Spotify is rate-limiting your account, `/v1/me` is refused too,
so verifying every request against Spotify would block the one path that exists
to route around the rate limit.

Without both of these the function returns errors, the app catches them, and you
are back to a plain static page that syncs from Spotify on each device.

Skip this section entirely on hosts that only serve static files (GitHub Pages,
S3) — there is nowhere for the function to run.

### If Spotify returns 403

New developer apps start in *development mode*, which only permits accounts you
have explicitly listed. Add your own account under the app's **User Management**
settings.

## Syncing

The first sync fetches every selected playlist: roughly one request per 100
tracks, so ~180 monthly playlists costs a couple of hundred requests and a
minute or two.

After that it is nearly free. Spotify stamps each playlist with a `snapshot_id`
that changes only when its contents change, so a resync re-fetches only the
months you actually touched — typically one or two.

## Privacy

The access token and the client ID live in this browser only, and are never sent
anywhere but Spotify. Signing out clears the token and leaves the cache, so you
can still search offline. To wipe the local cache entirely, clear site data for
the origin.

If the cross-device copy is deployed, one more thing leaves the browser: the
crate itself — playlist and track metadata, no credentials — is uploaded to the
Blob store of whoever runs the deployment. It is a private blob, reachable only
through the function and only with a valid token or pass for that Spotify
account, but it is not encrypted at rest. On a personal deployment that store is
yours. On someone else's, it is theirs. The setup screen says as much before you
sign in.

The app requests read access to your playlists, plus playlist-modify so the
"save as playlist" button can create new ones. It never modifies or deletes an
existing playlist.

## Tests

```sh
npm test            # search, grouping, ranking and sorting logic (node --test)

npm run serve &     # the browser suites drive the real page in Chromium
npm run test:ui     # the UI, against a crate seeded into IndexedDB
npm run test:sync   # the sync path, against a mocked Spotify Web API

npm run test:all    # all three
```

Neither browser suite touches a real account: `test:ui` seeds a fake synced crate
into IndexedDB and blocks all network access to Spotify, and `test:sync` answers
the Spotify endpoints itself so it can exercise pagination, `snapshot_id`
refetching, rate-limit handling and export.

The browser suites need Playwright's Chromium (`npx playwright install
chromium`); `npm test` needs nothing but Node.

## Layout

| File | What it does |
| --- | --- |
| `index.html`, `app.css` | The page and its styling |
| `js/auth.js` | Spotify OAuth via PKCE — no client secret, no backend |
| `js/api.js` | Web API client: pagination, 429 backoff, 401 refresh-and-retry |
| `js/db.js` | IndexedDB cache, one record per playlist |
| `js/library.js` | The actual library: dedup, album grouping, query parsing, ranking, facets |
| `js/cloud.js` | Client for the cross-device copy: pass handling, push, pull, rate-limit probe |
| `js/main.js` | State, sync orchestration and rendering |
| `api/crate.js` | The one serverless function: stores a crate per Spotify account |
