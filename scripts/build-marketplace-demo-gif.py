"""Build and verify a metadata-minimal GIF from audited isolated VS Code frames."""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageSequence, __version__ as PILLOW_VERSION


WIDTH = 1280
HEIGHT = 720
FRAME_NAMES = (
    "01-edit-preview.png",
    "02-generating-a.png",
    "03-generating-b.png",
    "04-review.png",
    "05-apply-pressed.png",
    "06-applied.png",
)
DURATIONS_MS = (2200, 500, 700, 3300, 250, 3500)
ALLOWED_PNG_CHUNKS = {b"IHDR", b"IDAT", b"IEND"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture-dir", type=Path, required=True)
    return parser.parse_args()


def png_chunks(payload: bytes) -> list[bytes]:
    if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError("A captured frame is not a PNG file.")
    chunks: list[bytes] = []
    cursor = 8
    while cursor < len(payload):
        if cursor + 12 > len(payload):
            raise RuntimeError("A captured PNG is truncated.")
        length = struct.unpack(">I", payload[cursor : cursor + 4])[0]
        chunk_type = payload[cursor + 4 : cursor + 8]
        end = cursor + 12 + length
        if end > len(payload):
            raise RuntimeError("A captured PNG chunk is truncated.")
        chunks.append(chunk_type)
        cursor = end
        if chunk_type == b"IEND":
            if cursor != len(payload):
                raise RuntimeError("A captured PNG has trailing data.")
            return chunks
    raise RuntimeError("A captured PNG has no IEND chunk.")


def skip_sub_blocks(payload: bytes, cursor: int) -> int:
    while True:
        if cursor >= len(payload):
            raise RuntimeError("The GIF has a truncated data block.")
        size = payload[cursor]
        cursor += 1
        if size == 0:
            return cursor
        cursor += size
        if cursor > len(payload):
            raise RuntimeError("The GIF has a truncated data sub-block.")


def inspect_gif_blocks(payload: bytes) -> tuple[int, list[int], list[int]]:
    if payload[:6] not in {b"GIF87a", b"GIF89a"}:
        raise RuntimeError("The candidate is not a GIF file.")
    if len(payload) < 13:
        raise RuntimeError("The GIF logical screen descriptor is truncated.")
    width, height = struct.unpack("<HH", payload[6:10])
    if (width, height) != (WIDTH, HEIGHT):
        raise RuntimeError("The GIF canvas size is unexpected.")
    packed = payload[10]
    cursor = 13
    if packed & 0x80:
        cursor += 3 * (2 ** ((packed & 0x07) + 1))

    frame_count = 0
    durations: list[int] = []
    disposals: list[int] = []
    pending_duration = 0
    pending_disposal = 0
    while cursor < len(payload):
        marker = payload[cursor]
        cursor += 1
        if marker == 0x3B:
            if cursor != len(payload):
                raise RuntimeError("The GIF has data after its trailer.")
            return frame_count, durations, disposals
        if marker == 0x21:
            if cursor >= len(payload):
                raise RuntimeError("The GIF extension block is truncated.")
            label = payload[cursor]
            cursor += 1
            if label == 0xF9:
                if cursor + 6 > len(payload) or payload[cursor] != 4:
                    raise RuntimeError("The GIF graphic-control block is invalid.")
                gce = payload[cursor + 1 : cursor + 5]
                pending_disposal = (gce[0] >> 2) & 0x07
                pending_duration = struct.unpack("<H", gce[1:3])[0] * 10
                if payload[cursor + 5] != 0:
                    raise RuntimeError("The GIF graphic-control terminator is invalid.")
                cursor += 6
                continue
            if label in {0xFE, 0x01}:
                raise RuntimeError("The GIF contains a forbidden text extension.")
            if label != 0xFF:
                raise RuntimeError("The GIF contains an unknown extension block.")
            if cursor >= len(payload):
                raise RuntimeError("The GIF application block is truncated.")
            block_size = payload[cursor]
            cursor += 1
            if cursor + block_size > len(payload):
                raise RuntimeError("The GIF application identifier is truncated.")
            identifier = payload[cursor : cursor + block_size]
            cursor += block_size
            if identifier != b"NETSCAPE2.0":
                raise RuntimeError("The GIF contains a forbidden application extension.")
            if payload[cursor : cursor + 5] != b"\x03\x01\x00\x00\x00":
                raise RuntimeError("The GIF loop extension payload is invalid.")
            cursor += 5
            continue
        if marker != 0x2C:
            raise RuntimeError("The GIF contains an unknown top-level block.")
        if cursor + 9 > len(payload):
            raise RuntimeError("The GIF image descriptor is truncated.")
        left, top, frame_width, frame_height = struct.unpack(
            "<HHHH", payload[cursor : cursor + 8]
        )
        image_packed = payload[cursor + 8]
        cursor += 9
        if (left, top, frame_width, frame_height) != (0, 0, WIDTH, HEIGHT):
            raise RuntimeError("Every GIF frame must cover the complete canvas.")
        if image_packed & 0x80:
            cursor += 3 * (2 ** ((image_packed & 0x07) + 1))
        if cursor >= len(payload):
            raise RuntimeError("The GIF image data is truncated.")
        cursor += 1
        cursor = skip_sub_blocks(payload, cursor)
        if pending_duration <= 0 or pending_disposal != 2:
            raise RuntimeError("Every GIF frame must have duration and disposal=2.")
        frame_count += 1
        durations.append(pending_duration)
        disposals.append(pending_disposal)
        pending_duration = 0
        pending_disposal = 0
    raise RuntimeError("The GIF has no trailer.")


def load_source_frames(capture_dir: Path) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for name in FRAME_NAMES:
        frame_path = capture_dir / name
        payload = frame_path.read_bytes()
        chunks = png_chunks(payload)
        unexpected = set(chunks).difference(ALLOWED_PNG_CHUNKS)
        if unexpected:
            raise RuntimeError(f"{name} contains an unexpected PNG chunk.")
        with Image.open(frame_path) as image:
            if image.size != (WIDTH, HEIGHT):
                raise RuntimeError(f"{name} has unexpected dimensions {image.size}.")
            frames.append(image.convert("RGB"))
    return frames


def shared_palette(frames: list[Image.Image]) -> Image.Image:
    sample = Image.new("RGB", (WIDTH // 2, (HEIGHT // 2) * len(frames)))
    for index, frame in enumerate(frames):
        sample.paste(frame.resize((WIDTH // 2, HEIGHT // 2)), (0, index * (HEIGHT // 2)))
    return sample.quantize(colors=128, method=Image.Quantize.MEDIANCUT)


def build_gif(capture_dir: Path, frames: list[Image.Image]) -> Path:
    palette = shared_palette(frames)
    quantized = [
        frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames
    ]
    candidate = capture_dir / "demo-candidate.gif"
    quantized[0].save(
        candidate,
        save_all=True,
        append_images=quantized[1:],
        duration=list(DURATIONS_MS),
        loop=0,
        optimize=False,
        disposal=2,
    )
    return candidate


def contact_sheet_font() -> ImageFont.ImageFont:
    candidate = Path("C:/Windows/Fonts/segoeuib.ttf")
    if candidate.is_file():
        return ImageFont.truetype(str(candidate), 18)
    return ImageFont.load_default()


def verify_and_render_audit(candidate: Path) -> dict[str, object]:
    capture_dir = candidate.parent
    payload = candidate.read_bytes()
    frame_count, block_durations, disposals = inspect_gif_blocks(payload)
    if frame_count != len(FRAME_NAMES):
        raise RuntimeError("The GIF frame count is unexpected.")
    if tuple(block_durations) != DURATIONS_MS:
        raise RuntimeError("The GIF frame durations are unexpected.")

    decoded: list[Image.Image] = []
    decoded_durations: list[int] = []
    with Image.open(candidate) as image:
        forbidden_info = set(image.info).intersection(
            {"comment", "xmp", "icc_profile", "exif"}
        )
        if forbidden_info:
            raise RuntimeError("The GIF contains forbidden image metadata.")
        for index, frame in enumerate(ImageSequence.Iterator(image), start=1):
            decoded_durations.append(int(frame.info.get("duration", 0)))
            rendered = frame.convert("RGBA").convert("RGB")
            if rendered.size != (WIDTH, HEIGHT):
                raise RuntimeError("A decoded GIF frame has unexpected dimensions.")
            audit_path = capture_dir / f"audit-frame-{index:02d}.png"
            rendered.save(audit_path, format="PNG", optimize=True)
            if set(png_chunks(audit_path.read_bytes())).difference(ALLOWED_PNG_CHUNKS):
                raise RuntimeError("An extracted audit frame contains metadata.")
            decoded.append(rendered)
    if tuple(decoded_durations) != DURATIONS_MS:
        raise RuntimeError("Decoded GIF durations do not match the script.")

    thumbnail_width = WIDTH // 2
    thumbnail_height = HEIGHT // 2
    label_height = 34
    rows = (len(decoded) + 1) // 2
    sheet = Image.new(
        "RGB",
        (WIDTH, rows * (thumbnail_height + label_height)),
        "#090d18",
    )
    draw = ImageDraw.Draw(sheet)
    font = contact_sheet_font()
    labels = (
        "EDIT + PREVIEW",
        "GENERATING",
        "GENERATING",
        "REVIEW",
        "APPLY CLICK",
        "APPLIED + UNSAVED",
    )
    for index, (frame, label) in enumerate(zip(decoded, labels, strict=True)):
        column = index % 2
        row = index // 2
        x = column * thumbnail_width
        y = row * (thumbnail_height + label_height)
        sheet.paste(frame.resize((thumbnail_width, thumbnail_height)), (x, y + label_height))
        draw.text((x + 12, y + 7), label, font=font, fill="#f8fafc")
    contact_sheet = capture_dir / "contact-sheet.png"
    sheet.save(contact_sheet, format="PNG", optimize=True)

    report = {
        "status": "pass",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "dimensions": [WIDTH, HEIGHT],
        "frames": frame_count,
        "durations_ms": block_durations,
        "disposals": disposals,
        "total_duration_ms": sum(block_durations),
        "pillow_version": PILLOW_VERSION,
        "allowed_application_extension": "NETSCAPE2.0",
        "forbidden_metadata": [],
    }
    (capture_dir / "audit-report.json").write_text(
        json.dumps(report, ensure_ascii=True, indent=2) + "\n",
        encoding="utf8",
    )
    return report


def main() -> None:
    args = parse_args()
    capture_dir = args.capture_dir.resolve()
    frames = load_source_frames(capture_dir)
    candidate = build_gif(capture_dir, frames)
    report = verify_and_render_audit(candidate)
    print(
        json.dumps(
            {
                "status": report["status"],
                "frames": report["frames"],
                "bytes": report["bytes"],
                "sha256": report["sha256"],
            }
        )
    )


if __name__ == "__main__":
    main()
