"""Builds icon, cover and screenshots from sample-data panel shots.

Usage: python3 scripts/make_images.py <shots dir> <out dir>. Shots come from `orca plugin shot . --scenario
"<name>" --theme <dark|light> --width 380` (Orca hidden), named <scenario-with-dashes>-<theme>.png.
Needs Pillow and JetBrainsMono Nerd Font in ~/Library/Fonts.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SHOTS = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
FONTS = Path.home() / "Library/Fonts"
BOLD = ImageFont.truetype(str(FONTS / "JetBrainsMonoNerdFont-Bold.ttf"), 76)
REG = ImageFont.truetype(str(FONTS / "JetBrainsMonoNerdFont-Regular.ttf"), 34)
SMALL = ImageFont.truetype(str(FONTS / "JetBrainsMonoNerdFont-Regular.ttf"), 26)

BG_TOP, BG_BOTTOM = (22, 24, 38), (40, 30, 72)
A, B = (124, 140, 255), (64, 214, 190)  # two accounts: indigo, teal
W, H = 1600, 1000


def gradient(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    return img


def person(d: ImageDraw.ImageDraw, cx: float, cy: float, s: float, color, ring) -> None:
    """Head + shoulders glyph, with a ring so overlaps stay readable."""
    for grow, fill in ((s * 0.07, ring), (0, color)):
        r = s * 0.2 + grow
        d.ellipse([cx - r, cy - s * 0.3 - r, cx + r, cy - s * 0.3 + r], fill=fill)
        w = s * 0.38 + grow
        d.chord([cx - w, cy + s * 0.02 - grow, cx + w, cy + s * 0.78 + grow], 180, 360, fill=fill)


def icon(size: int = 512) -> Image.Image:
    mask = Image.new("L", (size, size))
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=255)
    img = gradient(size, size).convert("RGBA")
    d = ImageDraw.Draw(img)
    person(d, size * 0.38, size * 0.5, size * 0.62, A, BG_TOP)
    person(d, size * 0.64, size * 0.6, size * 0.62, B, BG_BOTTOM)
    img.putalpha(mask)
    return img.resize((256, 256), Image.LANCZOS)


def framed(shot: Path, crop_h: int, scale: float = 1.0, top: int = 0) -> Image.Image:
    """Panel shot cropped to rows top..crop_h, rounded, on a soft shadow."""
    p = Image.open(shot).convert("RGBA")
    p = p.crop((0, top, p.width, min(crop_h, p.height)))
    if scale != 1.0:
        p = p.resize((round(p.width * scale), round(p.height * scale)), Image.LANCZOS)
    m = Image.new("L", p.size)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, p.width - 1, p.height - 1], radius=18, fill=255)
    p.putalpha(m)
    pad = 40
    out = Image.new("RGBA", (p.width + pad * 2, p.height + pad * 2))
    sh = Image.new("L", out.size)
    ImageDraw.Draw(sh).rounded_rectangle([pad, pad + 12, pad + p.width, pad + p.height + 12], radius=18, fill=150)
    out.paste((0, 0, 0, 255), (0, 0), sh.filter(ImageFilter.GaussianBlur(18)))
    out.alpha_composite(p, (pad, pad))
    return out


def canvas() -> Image.Image:
    return gradient(W, H).convert("RGBA")


def save(img: Image.Image, name: str) -> None:
    img.convert("RGB").save(OUT / name, optimize=True)
    print(name, img.size, (OUT / name).stat().st_size // 1024, "KB")


icon().save(OUT / "icon.png", optimize=True)
print("icon.png", (OUT / "icon.png").stat().st_size // 1024, "KB")

# Cover: name and pitch on the left, the panel on the right.
c = canvas()
d = ImageDraw.Draw(c)
c.alpha_composite(icon().resize((150, 150), Image.LANCZOS), (110, 200))
d.text((110, 390), "Agent Accounts", font=BOLD, fill=(240, 242, 255))
for i, line in enumerate(["Pick the Claude Code and Codex", "account each repo, workspace", "or tab runs on.", "", "Move a running tab to another", "account. Your agents can too."]):
    d.text((112, 510 + i * 50), line, font=REG, fill=(196, 200, 230))
c.alpha_composite(framed(SHOTS / "tabs-on-two-accounts-dark.png", 905, 0.98), (1010, 20))
save(c, "cover.png")

# Screenshot 1: dark and light side by side.
c = canvas()
c.alpha_composite(framed(SHOTS / "codex-account-added-dark.png", 900), (330, 10))
c.alpha_composite(framed(SHOTS / "codex-account-added-light.png", 900), (810, 10))
save(c, "panel.png")

# Screenshot 2: tabs on two accounts, each movable.
c = canvas()
d = ImageDraw.Draw(c)
d.text((110, 340), "Move a running tab", font=ImageFont.truetype(str(FONTS / "JetBrainsMonoNerdFont-Bold.ttf"), 52), fill=(240, 242, 255))
for i, line in enumerate(["Stops its Claude and resumes", "the conversation, with its", "history, on the other account."]):
    d.text((112, 430 + i * 44), line, font=REG, fill=(196, 200, 230))
c.alpha_composite(framed(SHOTS / "tabs-on-two-accounts-dark.png", 905, 1.6, top=515), (860, 170))
save(c, "tabs.png")

# Screenshot 3: the same workspace name in two repos.
c = canvas()
d = ImageDraw.Draw(c)
d.text((110, 380), "Same name, two repos?", font=ImageFont.truetype(str(FONTS / "JetBrainsMonoNerdFont-Bold.ttf"), 52), fill=(240, 242, 255))
for i, line in enumerate(["It shows both and lets you", "pick in the right one,", "never guesses."]):
    d.text((112, 470 + i * 44), line, font=REG, fill=(196, 200, 230))
c.alpha_composite(framed(SHOTS / "name-in-two-repos-dark.png", 1029, 0.9), (960, 15))
save(c, "two-repos.png")
