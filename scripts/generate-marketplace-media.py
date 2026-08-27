"""Generate synthetic, metadata-free Marketplace visuals.

The frames deliberately avoid screenshots so local paths, accounts, notifications,
and real note content cannot be captured in release assets.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "media"
WIDTH = 1280
HEIGHT = 720

COLORS = {
    "background": "#090d18",
    "panel": "#111827",
    "panel_alt": "#151e2e",
    "border": "#334155",
    "text": "#f8fafc",
    "muted": "#a7b3c7",
    "blue": "#5b8def",
    "green": "#37c978",
    "green_bg": "#123923",
    "red": "#f07178",
    "red_bg": "#3a1d24",
    "yellow": "#f2cc60",
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
    "code": ui_font(21),
    "small": ui_font(17),
    "small_bold": ui_font(17, True),
}


def rounded(draw, box, fill, outline=None, radius=14, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text(draw, xy, value, style="body", fill=None, anchor=None):
    draw.text(xy, value, font=FONTS[style], fill=fill or COLORS["text"], anchor=anchor)


def base_frame(step, title):
    image = Image.new("RGB", (WIDTH, HEIGHT), COLORS["background"])
    draw = ImageDraw.Draw(image)
    rounded(draw, (36, 28, WIDTH - 36, HEIGHT - 28), COLORS["panel"], COLORS["border"], 18, 2)
    rounded(draw, (36, 28, WIDTH - 36, 84), "#0d1422", COLORS["border"], 18, 2)
    draw.rectangle((36, 66, WIDTH - 36, 84), fill="#0d1422")
    for index, color in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        draw.ellipse((58 + index * 28, 49, 72 + index * 28, 63), fill=color)
    text(draw, (WIDTH // 2, 56), "Codex Note Helper — synthetic demo", "small_bold", COLORS["muted"], "mm")
    rounded(draw, (58, 104, 308, 151), COLORS["blue"], radius=22)
    text(draw, (183, 127), f"STEP {step} OF 4", "small_bold", "#ffffff", "mm")
    text(draw, (58, 177), title, "hero")
    return image, draw


def editor_shell(draw, box, label="demo-note.md"):
    x1, y1, x2, y2 = box
    rounded(draw, box, COLORS["panel_alt"], COLORS["border"], 12, 2)
    draw.rectangle((x1 + 1, y1 + 1, x2 - 1, y1 + 42), fill="#0d1422")
    text(draw, (x1 + 20, y1 + 22), label, "small", COLORS["muted"], "lm")
    return x1 + 26, y1 + 68


def code_line(draw, x, y, number, value, color=None, prefix=""):
    text(draw, (x, y), str(number), "small", "#65748b", "rm")
    text(draw, (x + 20, y), f"{prefix}{value}", "code", color or COLORS["text"], "lm")


def frame_heading():
    image, draw = base_frame(1, "Start with a Markdown heading")
    x, y = editor_shell(draw, (58, 220, 1222, 630))
    code_line(draw, x + 28, y, 1, "# Hamiltonian simulation", COLORS["blue"])
    code_line(draw, x + 28, y + 42, 2, "")
    rounded(draw, (690, 310, 1135, 424), "#0d1422", COLORS["border"], 12, 1)
    text(draw, (912, 342), "Only selected sections are included", "body_bold", anchor="mm")
    text(draw, (912, 382), "All selected content is sent to your configured Codex CLI", "small", COLORS["muted"], "mm")
    text(draw, (58, 672), "Illustrative demo • no real account, path, or note data", "small", COLORS["muted"], "lm")
    return image


def frame_generating():
    image, draw = base_frame(2, "Generate a structured proposal")
    x, y = editor_shell(draw, (58, 220, 1222, 630))
    code_line(draw, x + 28, y, 1, "# Hamiltonian simulation", COLORS["blue"])
    rounded(draw, (318, 350, 962, 468), "#0d1422", COLORS["blue"], 16, 2)
    text(draw, (370, 389), "Codex Note Helper", "body_bold", COLORS["text"], "lm")
    text(draw, (370, 430), "Validating structured note updates…", "body", COLORS["muted"], "lm")
    for i in range(3):
        draw.ellipse((845 + i * 28, 412, 857 + i * 28, 424), fill=COLORS["blue"] if i == 0 else COLORS["border"])
    text(draw, (58, 672), "Read-only sandbox • ephemeral run • web search off by default", "small", COLORS["muted"], "lm")
    return image


def frame_diff(show_actions=False):
    image, draw = base_frame(3, "Review the structurally validated diff")
    left = (58, 220, 625, 602)
    right = (655, 220, 1222, 602)
    lx, ly = editor_shell(draw, left, "Before")
    rx, ry = editor_shell(draw, right, "Proposed")
    code_line(draw, lx + 28, ly, 1, "# Hamiltonian simulation", COLORS["blue"])
    code_line(draw, lx + 28, ly + 42, 2, "")
    code_line(draw, rx + 28, ry, 1, "# Hamiltonian simulation", COLORS["blue"])
    draw.rectangle((rx, ry + 29, right[2] - 18, ry + 151), fill=COLORS["green_bg"])
    code_line(draw, rx + 28, ry + 52, 2, "A quantum-algorithm technique that", COLORS["green"], "+ ")
    code_line(draw, rx + 28, ry + 91, 3, "approximates time evolution of a", COLORS["green"], "+ ")
    code_line(draw, rx + 28, ry + 130, 4, "Hamiltonian under bounded error.", COLORS["green"], "+ ")
    if show_actions:
        rounded(draw, (330, 622, 950, 690), "#0d1422", COLORS["blue"], 16, 2)
        text(draw, (365, 656), "Review pending", "body_bold", COLORS["text"], "lm")
        rounded(draw, (600, 634, 740, 678), COLORS["green"], radius=10)
        text(draw, (670, 656), "Apply", "small_bold", "#07140d", "mm")
        rounded(draw, (758, 634, 910, 678), COLORS["red_bg"], COLORS["red"], 10, 1)
        text(draw, (834, 656), "Discard", "small_bold", COLORS["red"], "mm")
    else:
        text(draw, (58, 672), "No generated change is applied automatically", "small", COLORS["muted"], "lm")
    return image


def frame_applied():
    image, draw = base_frame(4, "Apply explicitly when the diff is ready")
    x, y = editor_shell(draw, (58, 220, 1222, 630))
    code_line(draw, x + 28, y, 1, "# Hamiltonian simulation", COLORS["blue"])
    code_line(draw, x + 28, y + 48, 2, "A quantum-algorithm technique that approximates", COLORS["text"])
    code_line(draw, x + 28, y + 88, 3, "time evolution of a Hamiltonian under bounded error.", COLORS["text"])
    rounded(draw, (750, 478, 1138, 554), COLORS["green_bg"], COLORS["green"], 14, 2)
    text(draw, (944, 516), "Applied as one undoable edit", "body_bold", COLORS["green"], "mm")
    text(draw, (58, 672), "The note remains unsaved until you choose to save it", "small", COLORS["muted"], "lm")
    return image


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
    frames = [frame_heading(), frame_generating(), frame_diff(), frame_diff(True), frame_applied()]
    frames[0].save(
        MEDIA / "demo.gif",
        save_all=True,
        append_images=frames[1:],
        duration=[2600, 2600, 3000, 3800, 3600],
        loop=0,
        optimize=True,
        disposal=2,
    )
    social_preview().save(MEDIA / "social-preview.png", optimize=True)


if __name__ == "__main__":
    main()
