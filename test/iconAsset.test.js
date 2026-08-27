const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const repoRoot = path.join(__dirname, "..");
const iconPath = path.join(repoRoot, "media", "icon.png");
const expectedSha256 =
  "bbcd61d1da8e21779efaeba708c73708d12b056a12c66c942b5d16f7764910d8";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function parsePng(buffer) {
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "icon must have the complete PNG signature"
  );

  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    assert.ok(offset + 12 <= buffer.length, "truncated PNG chunk header");
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    assert.ok(chunkEnd <= buffer.length, "truncated PNG chunk data");
    const typeBytes = buffer.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const storedCrc = buffer.readUInt32BE(offset + 8 + length);
    assert.equal(
      storedCrc,
      crc32(Buffer.concat([typeBytes, data])),
      `invalid ${type} CRC`
    );
    chunks.push({ type, data });
    offset = chunkEnd;
    if (type === "IEND") {
      assert.equal(length, 0, "IEND must be empty");
      assert.equal(offset, buffer.length, "data found after IEND");
      break;
    }
  }

  assert.equal(offset, buffer.length, "PNG is missing IEND");
  return chunks;
}

function decodeRgbaScanlines(chunks, width, height) {
  const compressed = Buffer.concat(
    chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data)
  );
  const inflated = zlib.inflateSync(compressed);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  assert.equal(inflated.length, height * (stride + 1));

  const decoded = Buffer.alloc(width * height * bytesPerPixel);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    assert.ok(filter <= 4, `unsupported PNG filter ${filter}`);
    const rowOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const encoded = inflated[sourceOffset + column];
      const left = column >= bytesPerPixel
        ? decoded[rowOffset + column - bytesPerPixel]
        : 0;
      const above = row > 0 ? decoded[rowOffset + column - stride] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel
        ? decoded[rowOffset + column - stride - bytesPerPixel]
        : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) predictor = paeth(left, above, upperLeft);
      decoded[rowOffset + column] = (encoded + predictor) & 0xff;
    }
    sourceOffset += stride;
  }
  return decoded;
}

test("extension icon is a minimal, private, high-resolution RGBA PNG", () => {
  const icon = fs.readFileSync(iconPath);
  assert.ok(icon.length <= 256 * 1024, "icon must remain at most 256 KiB");
  assert.equal(
    crypto.createHash("sha256").update(icon).digest("hex"),
    expectedSha256,
    "icon bytes changed without an intentional asset review"
  );

  const chunks = parsePng(icon);
  const types = chunks.map(({ type }) => type);
  assert.equal(types[0], "IHDR");
  assert.equal(types.at(-1), "IEND");
  assert.equal(types.filter((type) => type === "IHDR").length, 1);
  assert.equal(types.filter((type) => type === "IEND").length, 1);
  assert.ok(types.includes("IDAT"));
  assert.ok(
    types.every((type) => ["IHDR", "IDAT", "IEND"].includes(type)),
    `unexpected metadata or ancillary chunk: ${types.join(", ")}`
  );

  const header = chunks[0].data;
  assert.equal(header.length, 13);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.equal(width, 256);
  assert.equal(height, 256);
  assert.equal(header[8], 8, "icon must use 8-bit channels");
  assert.equal(header[9], 6, "icon must use RGBA color");
  assert.equal(header[10], 0, "icon must use standard compression");
  assert.equal(header[11], 0, "icon must use standard filtering");
  assert.equal(header[12], 0, "icon must not be interlaced");

  const pixels = decodeRgbaScanlines(chunks, width, height);
  let transparentPixels = 0;
  let opaquePixels = 0;
  const transparentMargin = 8;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha === 0) {
        transparentPixels += 1;
        assert.equal(
          red | green | blue,
          0,
          "fully transparent pixels must not hide RGB content"
        );
      }
      if (alpha === 255) opaquePixels += 1;
      if (
        x < transparentMargin ||
        y < transparentMargin ||
        x >= width - transparentMargin ||
        y >= height - transparentMargin
      ) {
        assert.equal(alpha, 0, "outer icon margin must be fully transparent");
      }
    }
  }
  assert.ok(transparentPixels > 0, "icon must retain transparent corners");
  assert.ok(opaquePixels > width * height * 0.5, "icon must not be mostly halo");
});
