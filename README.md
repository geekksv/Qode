<div align="center">

<img src="web/og.png" alt="Qode — free QR codes, made on your device" width="820">

<br>

**A QR code generator that runs entirely in your browser.**

No account. No database. No subscription. Nothing you type reaches a server.

[**Open Qode →**](https://getqode.vercel.app)

<br>

![Go](https://img.shields.io/badge/Go-WebAssembly-00ADD8?style=flat-square&logo=go&logoColor=white)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-2ea44f?style=flat-square)
![Spec](https://img.shields.io/badge/ISO%2FIEC-18004-6a83ff?style=flat-square)
![Licence](https://img.shields.io/badge/licence-MIT-blue?style=flat-square)

</div>

---

## Why this exists

Every QR generator asks you to sign up, watermarks your downloads, caps how
many codes you can make, or charges a monthly fee to keep a printed code
working. None of that is technically necessary.

A QR code is an *encoding*. Turning text into a grid of black and white
squares is pure computation — it needs no server, no account and no
storage. Qode does that computation in your browser and nothing else.

The encoder is written from scratch in Go: Reed–Solomon error correction,
all eight mask patterns, versions 1 through 40, byte mode. It compiles to
WebAssembly and ships as a single file.

<div align="center">
<img src="docs/studio.png" alt="The Qode studio" width="900">
</div>

---

## What it does

|  |  |
|---|---|
| **16 content types** | Link · Text · E-mail · Call · SMS · WhatsApp · Wi-Fi · V-card · Event · Location · App · Social · Image · Video · UPI Pay · Crypto |
| **Styling** | Three module shapes, three eye shapes, gradients, colour presets, 16 built-in logos, four logo animations |
| **Export** | True vector SVG, or PNG at 1200 px. No watermark, no limit |
| **Dynamic links** | Change where a printed code points, without a database |
| **Bulk** | CSV in, ZIP out, no row limit, parsed in the tab |
| **Accessibility** | WCAG AA contrast, full keyboard navigation, reduced-motion support |

Thirteen of the sixteen types are **entirely self-contained** — the payload
*is* the QR content. A phone acts on them with no internet connection, and
they keep working whether or not this site exists.

---

## The two interesting parts

### Encoding happens on your device

There is no `POST /api/generate`. The Go encoder runs in your browser via
WebAssembly, so a Wi-Fi password, a private phone number or an unreleased
URL never leaves the machine you typed it on.

The studio shows this as it happens: *"Encoded in 4.00 ms by Go/WASM ·
v4 · 33×33 · mask 2 · zero network calls"*. A server-backed generator
cannot print that line.

### Dynamic links without a database

Competitors sell "dynamic" QR codes on a subscription, because changing a
printed code's destination requires a server that remembers it:

```
Them:   QR ──► their server ──► database lookup ──► your destination
```

Qode packs the destination into the URL *fragment* — the part after `#`,
which browsers never transmit to any server:

```
https://getqode.vercel.app/r#aHR0cHM6Ly9hY21lLm5vdGlvbi5zaXRlL21lbnU
                             └── your destination, base64url ──┘
```

`/r` is a static page. Its JavaScript reads the fragment out of its own
address bar, decodes it locally, and redirects. The server receives a
request for `/r` and nothing more — it is structurally incapable of knowing
where any code points.

```
Qode:   QR ──► your destination        (decoded on the scanner's phone)
```

What makes the code *editable* is the second half: the wizard points it at
a page **you** control — a published Notion page, a Google Doc, your own
site. You edit that page; the printed code never changes.

Only `http` and `https` are ever followed. A hand-crafted `javascript:` or
`data:` fragment is refused with a named error.

---

## Running it locally

No build tooling, no package manager, no install step.

```bash
git clone https://github.com/geekksv/Qode.git
cd Qode
node scripts/build.js
npx serve web          # or: python -m http.server --directory web
```

`scripts/build.js` writes three gitignored files from your environment:
`web/js/config.js`, `web/sitemap.xml` and `web/robots.txt`. Copy
`.env.example` to `.env` first if you want the Image type to work.

### Rebuilding the encoder

Only needed if you change Go source under `cmd/` or `internal/`. The
compiled `web/wasm/main.wasm` is committed so the site deploys as a plain
static bundle.

```bash
./build.sh              # requires Go on PATH
```

### Verifying the encoder

Output is checked module-for-module against a reference implementation,
including at version 40's maximum capacity:

```bash
go test ./...
python cross_verify.py  # pip install qrcode
```

---

## Deploying

Import the repo on Vercel. No framework preset — `vercel.json` already
declares the build command, output directory, cache policy and security
headers.

Set these under **Project Settings → Environment Variables**:

| Variable | Required | Purpose |
|---|---|---|
| `IMGBB_KEY` | Image type only | [api.imgbb.com](https://api.imgbb.com) key |
| `IMGBB_EXPIRY_SECONDS` | No | Auto-delete uploads after N seconds |
| `SITE_URL` | No | Overrides the canonical URL; derived automatically on Vercel |

Everything except the Image type works with no environment variables at all.

No deployment URL is hardcoded anywhere: canonicals are relative, the
sitemap and `robots.txt` are generated at build time, and `og:image` URLs
are substituted from the build environment. Renaming the project or adding
a custom domain needs **no code change** — just push any commit so the
build regenerates those files.

---

## A note on the ImgBB key

This is a static site with no backend, so anything it needs at runtime is
downloaded by the visitor and readable by anyone who views source.
**The ImgBB key is public.**

Keeping it in `.env` stops it being scraped out of this repository, which is
worth doing on its own. It does not make it secret in the browser.

So: use a key created solely for this site, never one that protects anything
else, and rotate it when the quota gets abused. Only a server-side proxy
could make it genuinely private, and that would mean giving up the
no-backend property the rest of the project is built on.

The Image type is also the one feature that sends anything off your device.
The UI says so plainly at the point of use.

---

## Project structure

```
cmd/wasm/             Go entry point; exports the encoder to JavaScript
cmd/verify/           CLI used by cross_verify.py
internal/qrcode/      The encoder — matrix, masking, Reed–Solomon, tables
internal/bulk/        CSV parsing
internal/archivezip/  ZIP bundling
scripts/build.js      Generates config.js, sitemap.xml, robots.txt from env
scripts/make-og.py    Regenerates the social card
web/                  The static site, deployed as-is
  ├── index.html        Studio
  ├── wizard.html       Dynamic Link wizard
  ├── bulk.html         Bulk CSV generation
  ├── r.html            Redirect target — no WASM, no web font, ~4 KB
  ├── css/styles.css    One stylesheet, token-driven, light + dark
  ├── js/               Vanilla JS, no framework
  └── wasm/main.wasm    The compiled encoder
```

The QR code on the social card above is real, generated by this project's
own encoder. Scanning it opens the site.

---

## Licence

MIT — see [LICENSE](LICENSE).
