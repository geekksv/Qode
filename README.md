# Qode

A free QR code generator that runs entirely in your browser.

The encoder is written from scratch in Go — ISO/IEC 18004, Reed–Solomon error
correction, all eight mask patterns, versions 1 to 40 — and compiled to
WebAssembly. Nothing you type is sent to a server, because there is no server
to send it to.

## What it does

**Fifteen content types.** Link, Text, E-mail, Call, SMS, WhatsApp, Wi-Fi,
V-card, Event, Location, App, Social, Image, Video, UPI Pay, Crypto.

Thirteen of them are entirely self-contained: the payload *is* the QR content,
so a phone acts on it with no internet connection at all, and the code keeps
working whether or not this site exists.

**Dynamic links without a database.** The destination is packed into the URL
fragment — the part after `#`, which browsers never transmit to any server —
so the redirect page decodes it locally in the scanner's own browser. There is
no lookup table, no account, and no record of where any code points.

**Bulk generation.** A CSV in, a ZIP of PNGs or SVGs out, parsed and bundled
in-tab with no row limit.

**Real vector export.** SVG output is genuine geometry, not a traced bitmap.

## Running it locally

No build tooling, no dependencies, no install step. Generate the environment
files, then serve `web/` with anything:

```bash
node scripts/build.js
npx serve web        # or: python -m http.server --directory web
```

`scripts/build.js` writes three gitignored files: `web/js/config.js`,
`web/sitemap.xml` and `web/robots.txt`. It reads `.env` (see `.env.example`).

## Rebuilding the engine

Only needed if you change the Go source under `cmd/` or `internal/`. Requires
Go on your PATH; the compiled `web/wasm/main.wasm` is committed so the site
deploys as a plain static bundle.

```bash
./build.sh
```

The encoder's output is verified module-for-module against a reference
implementation, including at version 40's maximum capacity:

```bash
go test ./...
python cross_verify.py     # needs: pip install qrcode
```

## Deploying

Push to GitHub and import the repo on Vercel. It needs no framework preset —
`vercel.json` already specifies the build command, the output directory and
the headers.

Set these in **Project Settings → Environment Variables**:

| Variable | Required | Purpose |
|---|---|---|
| `IMGBB_KEY` | For the Image type only | https://api.imgbb.com API key |
| `IMGBB_EXPIRY_SECONDS` | No | Auto-delete uploads after N seconds |
| `SITE_URL` | No | Overrides the canonical URL; derived automatically on Vercel |

Everything except the Image type works with no environment variables at all.

## A note on the ImgBB key

This is a static site with no backend, so anything it needs at runtime is
downloaded by the visitor and readable by anyone who views source. **The
ImgBB key is public.** Keeping it in `.env` stops it being scraped out of this
repository, which is worth doing — it does not make it secret in the browser.

So: use a key created solely for this site, never one that protects anything
else, and rotate it whenever the quota gets abused. Only a server-side proxy
could make it genuinely private, and that would mean giving up the no-backend
property the rest of the project is built on.

## Layout

```
cmd/wasm/          Go entry point, exports the encoder to JavaScript
cmd/verify/        CLI used by cross_verify.py
internal/qrcode/   The encoder: matrix, masking, Reed–Solomon, tables
internal/bulk/     CSV parsing
internal/archivezip/ ZIP bundling
scripts/build.js   Generates config.js, sitemap.xml, robots.txt from env
web/               The static site, deployed as-is
```

## Licence

MIT
