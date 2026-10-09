<p align="center">
  <img src="public/logo.svg" alt="" width="88" height="88">
</p>

<h1 align="center">trydash</h1>

<p align="center">
  A local dashboard for <a href="https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/">TryCloudflare</a> quick tunnels.<br>
  Expose a dev service in one click, keep an eye on every tunnel and read their logs in one place.
</p>

<p align="center">
  <b>English</b> · <a href="README.it.md">Italiano</a> · <a href="https://mikzero.github.io/trydash/">Website</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/images/screenshot-dark.png">
    <img src="site/images/screenshot-light.png" alt="trydash: the tunnel list on the left, the selected tunnel’s logs in the middle, the details of one line on the right" width="880">
  </picture>
</p>

---

## Why

`cloudflared tunnel --url http://localhost:3000` is great, but with two or three services running you end up with several terminals to watch, URLs to copy around and logs that are hard to read. trydash starts and manages quick tunnels for you:

- **many tunnels at once**, each with its status (starting, live, stopped, exited), URL and error count;
- **one click** to create, stop, restart or remove a tunnel. To create one, just type the port: `3000` becomes `http://127.0.0.1:3000`;
- **readable logs**: colored levels, filters, highlighted search, infinite scrolling and a “follow the tail” mode;
- **stopped tunnels stay readable**: you can go back to their logs and restart them. The URL changes on every start, which is a limit of quick tunnels;
- **light and dark** themes, a **mobile** layout, keyboard shortcuts.

The interface is in Italian. Error messages are in English or Italian, following your browser (see [Error language](#error-language)). Below, Italian labels are followed by their translation.

## Features

### Email access

Open **Accesso via email** (“Email access”) in the create form and type the allowed addresses: `mario@client.com` for one person, `*@company.com` for a whole domain. Separate them with commas, semicolons, spaces or new lines. A list pasted from Outlook with names (`Mario Rossi <mario@client.com>; …`) works too: trydash keeps only the addresses. At most 20 entries.

trydash starts the tunnel with `--allowed-mail` and marks it with 🔒 in the sidebar. Whoever opens the URL must first sign in with one of the allowed addresses.

The last addresses you used show up as clickable suggestions (“recenti”, recent). They stay in your browser only (`localStorage`), never on the server.

### Traffic

trydash starts every tunnel with `--metrics` and reads the `cloudflared` metrics every 2 seconds:

- **in the sidebar**, a bar of the requests in flight against the 200 limit: orange from 150, red at 200;
- **in the tunnel header**, the requests in flight, the total requests, errors, connections to Cloudflare and a small chart of the last 5 minutes.

If the metrics stop answering, the numbers turn grey with “dati non aggiornati” (stale data). When the tunnel is stopped, the final totals stay.

### Origin options

Under **Opzioni origine** (“Origin options”):

- **Host header**, that is `--http-host-header`, for servers that only answer to a specific host name;
- **Non verificare TLS** (“Don’t verify TLS”), that is `--no-tls-verify`, for an https origin with a self-signed certificate;
- **Origine HTTP/2** (“HTTP/2 origin”), that is `--http2-origin`.

Email and options stay the same when you restart the tunnel. The preview under the field shows the equivalent `cloudflared` command. You can copy it as is: entries with `*` are already quoted.

### Try with Hello World

The **Prova con Hello World** button runs `cloudflared tunnel --hello-world`, which serves a test page. It lets you check that `cloudflared` and the network work, even without a local server.

### Warnings

| When | What you see |
|---|---|
| the origin doesn’t answer (in the last 60 s) | a “Il tuo server su :3000 non risponde — è avviato?” banner (“Your server on :3000 isn’t responding — is it running?”) with **Riavvia** (Restart) and **Prova con Hello World** |
| 150 or more requests in flight | a banner about the 200 limit: extra requests get `429` |
| `--no-tls-verify` on | a “Certificato dell’origine non verificato” label (origin certificate not verified) and ⚠ in the sidebar |
| protected tunnel | a label with the allowed addresses and 🔒 in the sidebar |
| Restart | the first click shows “Nuovo URL — conferma” (New URL — confirm): a restarted quick tunnel changes URL |
| always, in the form | “Solo per prove · niente SSE · nessuna garanzia di uptime” (testing only · no SSE · no uptime guarantee) |

### Error language

Error messages are in English or Italian, following the browser language. This also applies to API responses: the server reads the `Accept-Language` header. The rest of the interface is in Italian. The texts live in `public/js/i18n-en.js` and `public/js/i18n-it.js`.

## Installation

The easiest way is the ready-made executable: a single file, without Bun or any other dependency. You only need [`cloudflared`](https://developers.cloudflare.com/tunnel/downloads/) on your `PATH`. If it’s missing, the dashboard shows the commands to install it.

1. From the repository’s **Releases** page, or from the [website](https://mikzero.github.io/trydash/#download), download the file for your system:

   | System | File |
   |---|---|
   | Linux x64 | `trydash-<version>-linux-x64` |
   | Linux ARM64 | `trydash-<version>-linux-arm64` |
   | macOS Apple Silicon | `trydash-<version>-darwin-arm64` |
   | macOS Intel | `trydash-<version>-darwin-x64` |
   | Windows x64 | `trydash-<version>-windows-x64.exe` |

2. Optional: check the file with `SHA256SUMS`, published in the same release:

   ```sh
   sha256sum -c SHA256SUMS --ignore-missing
   ```

3. Run it:

   ```sh
   chmod +x trydash-1.0.0-linux-x64          # Linux and macOS
   xattr -d com.apple.quarantine trydash-1.0.0-darwin-arm64   # macOS only, see below
   ./trydash-1.0.0-linux-x64
   ```

   On Windows, just run the `.exe` file, from a terminal or with a double click.

`./trydash-… --version` prints the version. The [environment variables](#environment-variables) are the same as when running from source.

**macOS and Windows show a warning** because the binaries aren’t signed. On macOS, the `xattr` command lifts the Gatekeeper block on the downloaded file. On Windows, if SmartScreen shows up, choose “More info” and then “Run anyway”.

## Development requirements

- [Bun](https://bun.sh) ≥ 1.1
- [`cloudflared`](https://developers.cloudflare.com/tunnel/downloads/) on your `PATH`

No npm dependencies.

## Running from source

```sh
git clone https://github.com/mikzero/trydash.git
cd trydash
bun start            # or: bun server.js
```

Open the printed address, usually <http://127.0.0.1:8787>, type your service’s port and press **Crea** (Create).

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Port of the dashboard, which only listens on `127.0.0.1`. |
| `DASHBOARD_SEED` | — | With `1`, loads a sample session from the logs in `test/fixtures/`. Handy to try the interface without opening tunnels. |
| `DASHBOARD_PROBE` | `auto` | `present` or `missing` pretend that `cloudflared` is there or not, without running it. |
| `DASHBOARD_PROBE_VERSION` | — | Version text shown when `DASHBOARD_PROBE=present`. |

To try the dashboard without touching the network:

```sh
DASHBOARD_SEED=1 DASHBOARD_PROBE=present bun server.js
```

## Shortcuts

| Key | Action |
|---|---|
| `j` / `↓` | next line |
| `k` / `↑` | previous line |
| `/` | search the logs |
| `Esc` | clear the search, close the details or the menu |

## Good to know about quick tunnels

Quick tunnels are meant for **testing and development**. From the [Cloudflare documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/):

- the `*.trycloudflare.com` URL is random and **changes on every start**;
- at most **200 concurrent requests** per tunnel; beyond that, the response is `429`;
- **Server-Sent Events** aren’t supported;
- **no uptime guarantee**. For production you need a named Cloudflare Tunnel.

## Security

- The dashboard only listens on `127.0.0.1`, so other machines can’t reach it.
- Other pages open in your browser can’t control it. Requests with a `Host` other than `127.0.0.1`/`localhost` are refused, which blocks DNS rebinding. The same goes for changing requests (`POST`, `DELETE`) with an `Origin` from another site. Local scripts without an `Origin`, like `curl`, keep working.
- **A tunnel makes the service you expose public**: anyone with the URL can reach it. To limit it to specific people, use email access. Either way, don’t expose services with real data or admin panels without protection.
- trydash doesn’t ask for or store credentials, tokens or accounts. Logs stay in memory and disappear when you close the server.
- Origins with credentials in the URL (`http://user:pass@…`) are refused.

## API

The frontend uses a small JSON API, also handy for scripts:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/state` | state of `cloudflared` and of every session |
| `GET` | `/api/probe?fresh=1` | check `cloudflared` again |
| `POST` | `/api/sessions` | create a tunnel, body `{ "origin": "3000", "options": { … } }` (see below) |
| `POST` | `/api/sessions/:id/stop` | stop the tunnel |
| `POST` | `/api/sessions/:id/restart` | restart a stopped or exited tunnel |
| `DELETE` | `/api/sessions/:id` | stop and remove the session |
| `GET` | `/api/sessions/:id/logs?offset=&limit=&levels=error,warn&q=text` | a page of logs, filtered (at most 200 lines) |
| `GET` | `/api/sessions/:id/entries/:index` | a single log line |

`options` is optional:

```json
{
  "mode": "origin",
  "allowedMail": "mario@client.com, *@company.com",
  "hostHeader": "app.local",
  "noTlsVerify": false,
  "http2Origin": false
}
```

With `"mode": "hello"` the origin is ignored and the tunnel serves the Hello World page. Error responses look like `{ "error": "…", "key": "options.mailInvalid", "params": { … } }`.

## Local build

```sh
bun run build                                 # executable for the current system, in dist/
bun run build -- --all --version 1.0.0        # all 5 systems
bun run build -- --target bun-linux-arm64     # one specific system
```

The build generates `build/entry.js`, which embeds every file in `public/`, and compiles it with `bun build --compile`. The executables and `SHA256SUMS` end up in `dist/`. Each executable is about 85 MB, because it contains the Bun runtime. `build/` and `dist/` are ignored by git.

## Releasing a version

Releases start from a **git tag**. The `.github/workflows/release.yml` workflow runs on tags that start with `v` and does, in order:

1. the tests (`bun test`);
2. the build of the 5 executables, with the version taken from the tag;
3. a smoke test of the Linux executable: `--version`, start-up, answers from `/` and `/api/state`;
4. the GitHub Release, with the executables, `SHA256SUMS` and the **tag message as notes**.

If a step fails, no release is created.

```sh
git checkout main && git pull
bun test                                          # local check
bun scripts/release-notes.js v1.1.0               # draft in release-notes.md
# read and polish release-notes.md
git tag -a v1.1.0 -F release-notes.md --cleanup=verbatim
git push origin v1.1.0                            # starts the workflow
```

Follow the progress in **Actions** on GitHub, or with `gh run watch`.

Once the release is out, move the website’s direct links to the new version and push to `main`: the site republishes itself. A test checks that every link uses the same version.

```sh
sed -i 's/1\.0\.0/1.1.0/g' site/index.html site/it/index.html   # old → new version
bun test test/site.test.js
```

### Release notes (the tag message)

The annotated tag message becomes the text of the Release. It’s Markdown, written **in English**:

```markdown
trydash 1.1.0                      ← first line: Release title

One or two sentences on what this version brings.

## ⚠️ Breaking changes             ← only if there are any (MAJOR version)
- …

## ✨ New
- **ui**: …

## 🐛 Fixes
- **server**: …

## 🔒 Security                      ← optional
- …

## 🧰 Maintenance                   ← ci, docs, test, refactor
- …
```

GitHub appends a **Full Changelog** link comparing with the previous version.

`scripts/release-notes.js` drafts the notes from the commits since the last tag. It relies on [Conventional Commits](https://www.conventionalcommits.org/en/), the commit message style of the project:

| Commit | Section |
|---|---|
| `feat(ui): …` | New |
| `fix(server): …` | Fixes |
| `feat!: …` | Breaking changes |
| `ci:`, `docs:`, `test:`, `refactor:`, others | Maintenance |

The draft is a starting point. Rewrite the entries for people who use trydash, not for people who read the code, and add a Security section when needed.

Two things to know about the `git tag` command:
- **`--cleanup=verbatim` is required.** Without it, git treats lines starting with `#` as comments and drops the Markdown headings.
- **A tag without a message** (`git tag v1.1.0`) still publishes the Release, but only with GitHub’s automatic notes.

To read a tag’s message: `git tag -l --format='%(contents)' v1.0.0`.

### Picking the version number

Tags follow [semantic versioning](https://semver.org/), `vMAJOR.MINOR.PATCH`:

| Bump | When | Example |
|---|---|---|
| **PATCH** | fixes that don’t change the expected behavior | `v1.0.0` → `v1.0.1` |
| **MINOR** | new features, backward compatible | `v1.0.1` → `v1.1.0` |
| **MAJOR** | breaking changes (API, environment variables, behavior) | `v1.4.2` → `v2.0.0` |

- **Pre-releases:** a tag with a hyphen, like `v1.1.0-rc.1` or `v2.0.0-beta.2`, creates a release marked as *pre-release*, which GitHub doesn’t show as the “latest”. Use it to try a version before publishing it for real.
- **Annotated tags** (`git tag -a`) record author, date and message. They’re the right ones for releases.
- **Only tag `main`**, after the tests are green.
- **Don’t move or reuse a published tag.** Whoever downloaded `v1.0.0` must be able to count on it staying the same. If a release has a bug, publish the next one (`v1.0.1`). If the workflow failed before publishing, you can delete the tag (`git push origin :refs/tags/v1.0.0` and `git tag -d v1.0.0`), fix things and create it again.
- **List of versions:** `git tag --sort=-v:refname`, or `gh release list`.

## Website

The landing page lives in `site/`: static HTML, CSS and JavaScript, no build. It comes in two languages: English in `site/index.html`, the main page, and Italian in `site/it/index.html`. The texts written by the scripts live in `site/i18n.js`. An Italian browser landing on the English page is sent to the Italian one, unless the visitor already picked a language from the EN/IT switch. A test checks that both pages have the same structure. The `.github/workflows/pages.yml` workflow publishes it to GitHub Pages on every push to `main` that touches it. To look at it, just open `site/index.html` in a browser.

`site/images/logo.svg`, `site/favicon.svg` and `site/favicon.png` are copies of the ones in `public/`: a test checks they stay the same.

The download links are direct links to the release files, written in the HTML, and they work without JavaScript too. The main button suggests the file for the visitor’s system. If the GitHub API reports a newer release, the page updates the links by itself.

## Layout

```
server.js            HTTP server and API (Bun, node:* modules only)
src/assets.js        reads project files (from disk or embedded in the binary)
src/runtime.js       starts/stops cloudflared and reads its stream
src/traffic.js       polls the cloudflared metrics
src/load-dashboard.js loads the shared libraries in the server
scripts/build.js     builds the standalone executables
scripts/release-notes.js drafts release notes from the commits
site/                landing page (GitHub Pages) in English, site/it/ in Italian
.github/workflows/   automatic release on v* tags and website publishing
public/js/           shared libraries (parse, sessions, window, i18n…) and the interface
public/css/app.css   light/dark "Paper" theme
test/                tests with bun test
```

## Tests

```sh
bun test
```

The tests use fake processes and never start `cloudflared`. The build test compiles an executable for the current system and runs it from another folder: it takes a couple of seconds.

## License

trydash is free software, released under the [GNU GPL v3.0 or later](LICENSE).

---

trydash is an independent project and isn’t affiliated with Cloudflare. “Cloudflare” and “TryCloudflare” are trademarks of their respective owners.
