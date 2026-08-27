"""Generate the synthetic, metadata-free GitHub social-preview asset.

The Marketplace demo GIF is captured and audited separately by
``capture-marketplace-demo.js`` so this script cannot overwrite it.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"
COLORS = {
    "background": "#090d18",
    "panel": "#111827",
    "border": "#334155",
    "text": "#f8fafc",
    "muted": "#a7b3c7",
    "blue": "#5b8def",
    "green": "#37c978",
}


def font_path(bold=False):
    candidates = [
        Path("C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    raise RuntimeError("No supported UI font was found.")


def ui_font(size, bold=False):
    return ImageFont.truetype(font_path(bold), size=size)


FONTS = {
    "hero": ui_font(42, True),
    "title": ui_font(28, True),
    "body": ui_font(23),
    "body_bold": ui_font(23, True),
    "small": ui_font(17),
}


def rounded(draw, box, fill, outline=None, radius=14, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text(draw, xy, value, style="body", fill=None, anchor=None):
    draw.text(xy, value, font=FONTS[style], fill=fill or COLORS["text"], anchor=anchor)


def social_preview():
    image = Image.new("RGB", (1280, 640), COLORS["background"])
    draw = ImageDraw.Draw(image)
    text(draw, (64, 56), "Codex Note Helper", "hero")
    text(draw, (64, 118), "Markdown headings → reviewable Codex CLI notes", "title", COLORS["muted"])
    labels = [
        ("1", "Write a heading", "# Hamiltonian simulation"),
        ("2", "Generate", "Structured proposal"),
        ("3", "Review", "Structurally validated diff"),
        ("4", "Decide", "Apply or Discard"),
    ]
    for index, (number, heading, detail) in enumerate(labels):
        x1 = 64 + index * 298
        x2 = x1 + 260
        rounded(draw, (x1, 205, x2, 500), COLORS["panel"], COLORS["border"], 18, 2)
        rounded(draw, (x1 + 24, 231, x1 + 80, 287), COLORS["blue"], radius=28)
        text(draw, (x1 + 52, 259), number, "body_bold", "#ffffff", "mm")
        text(draw, (x1 + 24, 329), heading, "body_bold")
        text(draw, (x1 + 24, 380), detail, "small", COLORS["muted"])
        if index < 3:
            text(draw, (x2 + 19, 353), "→", "title", COLORS["blue"], "mm")
    text(draw, (64, 568), "Read-only generation • structural validation • explicit review", "body", COLORS["green"])
    return image


def main():
    MEDIA.mkdir(parents=True, exist_ok=True)
    social_preview().save(MEDIA / "social-preview.png", optimize=True)


if __name__ == "__main__":
    main()
