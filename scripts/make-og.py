# Generates web/og.png — the 1200x630 card shown when a Qode link is shared.
#
# Drawn rather than screenshotted so it stays reproducible: rerun this after
# a copy or palette change. Uses the site's own dark tokens (#08090a ground,
# #f4f4f5 ink, #6a83ff accent) so the card and the site look like one thing.
#
#   python scripts/make-og.py

from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "web", "og.png")

# Site tokens, dark theme.
PAPER   = (8, 9, 10)
SURFACE = (15, 17, 19)
LINE    = (40, 44, 51)
INK     = (244, 244, 245)
INK2    = (156, 161, 169)
INK3    = (138, 143, 153)
ACCENT  = (106, 131, 255)
OK      = (52, 211, 153)
WHITE   = (255, 255, 255)

F = "C:/Windows/Fonts/"
def font(name, size):
    return ImageFont.truetype(F + name, size)

sans_b  = lambda s: font("segoeuib.ttf", s)   # closest to Inter Bold
sans_r  = lambda s: font("segoeui.ttf",  s)
mono_b  = lambda s: font("consolab.ttf", s)   # closest to JetBrains Mono

img = Image.new("RGB", (W, H), PAPER)
d = ImageDraw.Draw(img)

# Faint graph paper, echoing the QR stage in the app.
for x in range(0, W, 40):
    d.line([(x, 0), (x, H)], fill=(14, 16, 18), width=1)
for y in range(0, H, 40):
    d.line([(0, y), (W, y)], fill=(14, 16, 18), width=1)

PAD = 72

# ---- Brand -----------------------------------------------------------------
mark = 46
d.rounded_rectangle([PAD, PAD, PAD + mark, PAD + mark], radius=11, fill=ACCENT)
# Three finder squares + a few modules, matching favicon.svg.
def finder(ox, oy, s):
    d.rectangle([ox, oy, ox + s, oy + s], outline=WHITE, width=3)
    i = s * 0.30
    d.rectangle([ox + i, oy + i, ox + s - i, oy + s - i], fill=WHITE)
u = mark * 0.26
finder(PAD + 8, PAD + 8, u)
finder(PAD + mark - 8 - u, PAD + 8, u)
finder(PAD + 8, PAD + mark - 8 - u, u)
for (mx, my) in [(0.62, 0.60), (0.78, 0.60), (0.70, 0.72), (0.62, 0.84), (0.82, 0.80)]:
    px, py = PAD + mark * mx, PAD + mark * my
    d.rectangle([px, py, px + 5, py + 5], fill=WHITE)

d.text((PAD + mark + 18, PAD + 6), "Qode", font=sans_b(34), fill=INK)

# ---- Headline --------------------------------------------------------------
y = PAD + 112
d.text((PAD, y), "Free QR codes,", font=sans_b(66), fill=INK)
d.text((PAD, y + 76), "made on your device.", font=sans_b(66), fill=INK3)

# ---- Supporting line -------------------------------------------------------
y2 = y + 196
d.text((PAD, y2),
       "A real QR encoder in Go, compiled to WebAssembly.",
       font=sans_r(27), fill=INK2)
d.text((PAD, y2 + 38),
       "Nothing you type reaches a server.",
       font=sans_r(27), fill=INK2)

# ---- Feature chips ---------------------------------------------------------
chips = ["16 content types", "Vector SVG export", "No account", "No database"]
cx, cy = PAD, H - PAD - 46
for c in chips:
    f = mono_b(18)
    tw = d.textlength(c, font=f)
    w = tw + 34
    d.rounded_rectangle([cx, cy, cx + w, cy + 44], radius=22, fill=SURFACE, outline=LINE, width=1)
    d.text((cx + 17, cy + 12), c, font=f, fill=INK2)
    cx += w + 12

# ---- QR panel on the right -------------------------------------------------
# A genuine, scannable code for https://getqode.vercel.app, drawn from the
# module grid below so the card demonstrates the product rather than
# illustrating it.
CELL = 9          # integer, so every module lands on exact pixel bounds
QUIET = 2
NMOD = 25         # og-qr.txt is 25x25 (version 2)
INNER = (NMOD + QUIET * 2) * CELL
panel = INNER + 40
px0 = W - PAD - panel
py0 = (H - panel) // 2
d.rounded_rectangle([px0, py0, px0 + panel, py0 + panel], radius=20, fill=WHITE)

GRID = os.path.join(ROOT, "scripts", "og-qr.txt")
with open(GRID) as fh:
    rows = [r.strip() for r in fh if r.strip()]
assert len(rows) == NMOD, "og-qr.txt is %dx%d, expected %d" % (len(rows), len(rows[0]), NMOD)
cell = CELL
ox = px0 + 20 + QUIET * cell
oy = py0 + 20 + QUIET * cell
for ry, row in enumerate(rows):
    run = None
    for rx in range(len(row) + 1):
        dark = rx < len(row) and row[rx] == "1"
        if dark and run is None:
            run = rx
        elif not dark and run is not None:
            d.rectangle([ox + run * cell, oy + ry * cell,
                         ox + rx * cell, oy + (ry + 1) * cell], fill=PAPER)
            run = None

img.save(OUT, "PNG", optimize=True)
print("wrote %s  (%d x %d, %.0f KB)" % (OUT, W, H, os.path.getsize(OUT) / 1024))
