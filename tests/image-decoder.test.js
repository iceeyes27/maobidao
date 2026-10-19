import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import omggif from 'omggif';
import { validateImageDecode } from '../src/archive/image-decoder.js';

// Node's test runner has no .wasm loader. Only this test compiles the exact
// dependency binary; production Wrangler supplies a precompiled Module instead.
const wasmKey = `__archiveImageTestWasm_${crypto.randomUUID().replaceAll('-', '')}`;
const hook = registerHooks({ load(url, context, next) {
  if (!url.endsWith('/@jsquash/webp/codec/dec/webp_dec.wasm')) return next(url, context);
  globalThis[wasmKey] ??= new WebAssembly.Module(readFileSync(new URL(url)));
  return { format: 'module', shortCircuit: true, source: `export default globalThis[${JSON.stringify(wasmKey)}];` };
} });
after(() => { hook.deregister(); delete globalThis[wasmKey]; });

const failure = code => error => error.name === 'CollectorError' && error.code === code;
const incomplete = failure('IMAGE_INCOMPLETE');
const large = failure('RESOURCE_TOO_LARGE');
const join = parts => Uint8Array.from(Buffer.concat(parts.map(part => Buffer.from(part))));
function be32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function le32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function le24(value) { return Uint8Array.of(value, value >> 8, value >> 16); }
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const payload = join([Buffer.from(type), data]);
  return join([be32(data.length), payload, be32(crc(payload))]);
}
function png({ width = 1, height = 1, depth = 8, color = 6, interlace = 0,
  raw = Uint8Array.of(0, 255, 0, 0, 255), compressed = deflateSync(Uint8Array.from(raw)), before = [], after: following = [] } = {}) {
  return join([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', join([be32(width), be32(height), [depth, color, 0, 0, interlace]])),
    ...before, chunk('IDAT', compressed), ...following, chunk('IEND', [])]);
}
function gif({ width = 2, height = 2, frames = 2, tiny = false, palette = [0x000000, 0xffffff, 0xff0000, 0x00ff00], values } = {}) {
  const buffer = new Uint8Array(20_000);
  const writer = new omggif.GifWriter(buffer, width, height, { palette });
  for (let frame = 0; frame < frames; frame++) {
    const w = tiny ? 1 : width, h = tiny ? 1 : height;
    writer.addFrame(0, 0, w, h, values || Uint8Array.from({ length: w * h }, (_, index) => (index + frame) % palette.length), { delay: 1 });
  }
  return buffer.slice(0, writer.end());
}
// Synthetic 2x2 RGBA pixels encoded with @jsquash/webp@1.5.0 (quality 80).
const WEBP_LOSSY = Uint8Array.from(Buffer.from('UklGRmYAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAA/4D//wBWUDggOgAAALABAJ0BKgIAAgABQCYlAE6AId+00gAA/vQX/MFZaX/Ir/+rQ3miA7Ao9namZlORzvSpVfF3YjjJIAA=', 'base64'));
const WEBP_LOSSLESS = Uint8Array.from(Buffer.from('UklGRjoAAABXRUJQVlA4TC4AAAAvAUAAEB8gFkzm79udhpCA4P9dnZCA4P9dnYCE8FyWC7xlqRJKAgRAUUYi+h8M', 'base64'));
function riffChunk(type, bytes) { return join([Buffer.from(type), le32(bytes.length), bytes, ...(bytes.length & 1 ? [[0]] : [])]); }
function riff(chunks) { const body = join([Buffer.from('WEBP'), ...chunks]); return join([Buffer.from('RIFF'), le32(body.length), body]); }
function animatedWebp({ frames = 2, badLast = false } = {}) {
  const parts = [riffChunk('VP8X', join([[2, 0, 0, 0], le24(1), le24(1)])), riffChunk('ANIM', new Uint8Array(6))];
  for (let index = 0; index < frames; index++) {
    const payload = badLast && index === frames - 1 ? riffChunk('VP8L', WEBP_LOSSLESS.subarray(20, 25)) : WEBP_LOSSLESS.subarray(12);
    parts.push(riffChunk('ANMF', join([le24(0), le24(0), le24(1), le24(1), le24(10), [0], payload])));
  }
  return riff(parts);
}

test('PNG fully decodes RGB, RGBA, grayscale, indexed, 16-bit and Adam7 samples', async () => {
  const samples = [png(), png({ color: 2, raw: [0, 255, 0, 0] }), png({ color: 0, raw: [0, 126] }),
    png({ color: 3, depth: 1, width: 4, raw: [0, 0b01010000], before: [chunk('PLTE', [0, 0, 0, 255, 255, 255])] }),
    png({ color: 2, depth: 16, raw: [0, 255, 255, 0, 0, 128, 128] }), png({ interlace: 1 })];
  for (const sample of samples) assert.equal(await validateImageDecode(sample, 'image/png'), true);
});

test('PNG verifies all chunk CRCs, including otherwise ignored metadata', async () => {
  const bytes = png({ before: [chunk('tEXt', Buffer.from('name\0value'))] });
  bytes[42] ^= 1;
  await assert.rejects(validateImageDecode(bytes, 'image/png'), incomplete);
});

test('PNG rejects a corrupt zlib checksum even when the PNG chunk CRC is valid', async () => {
  const compressed = deflateSync(Uint8Array.of(0, 255, 0, 0, 255));
  compressed[compressed.length - 1] ^= 1;
  await assert.rejects(validateImageDecode(png({ compressed }), 'image/png'), incomplete);
});

test('PNG rejects additional compressed-stream bytes even when the PNG container is valid', async () => {
  await assert.rejects(validateImageDecode(png({ compressed: join([deflateSync(Uint8Array.of(0, 255, 0, 0, 255)), [0]]) }), 'image/png'), incomplete);
});

test('PNG rejects truncated chunks, missing IEND and trailing bytes', async () => {
  const bytes = png();
  for (const sample of [bytes.subarray(0, bytes.length - 1), bytes.subarray(0, bytes.length - 12), join([bytes, [0]])]) {
    await assert.rejects(validateImageDecode(sample, 'image/png'), incomplete);
  }
});

test('PNG rejects valid zlib streams with incomplete rows or invalid filter values', async () => {
  for (const raw of [[0, 255], [5, 255, 0, 0, 255]]) await assert.rejects(validateImageDecode(png({ raw }), 'image/png'), incomplete);
});

test('PNG bounds a compressed expansion before the pixel decoder allocates it', async () => {
  await assert.rejects(validateImageDecode(png({ raw: new Uint8Array(1_000_000) }), 'image/png'), large);
});

test('PNG rejects invalid palette indices after actual pixel reconstruction', async () => {
  await assert.rejects(validateImageDecode(png({ color: 3, raw: [0, 2], before: [chunk('PLTE', [0, 0, 0, 255, 255, 255])] }), 'image/png'), incomplete);
});

test('PNG validates but never inflates optional compressed profiles', async () => {
  const profile = chunk('iCCP', join([Buffer.from('profile\0'), [0], deflateSync(new Uint8Array(2_000_000))]));
  assert.equal(await validateImageDecode(png({ before: [profile] }), 'image/png'), true);
});

test('PNG rejects unsupported APNG rather than validating its first frame only', async () => {
  await assert.rejects(validateImageDecode(png({ before: [chunk('acTL', join([be32(2), be32(0)]))] }), 'image/png'), incomplete);
});

test('PNG rejects oversized dimensions before any inflation or raster allocation', async () => {
  await assert.rejects(validateImageDecode(png({ width: 100_000, height: 100_000 }), 'image/png'), large);
  await assert.rejects(validateImageDecode(png({ width: 2048, height: 2048, depth: 16 }), 'image/png'), large);
});

test('PNG decodes a raster at the supported four-megapixel limit', async () => {
  const raw = new Uint8Array((2048 * 4 + 1) * 2048);
  assert.equal(await validateImageDecode(png({ width: 2048, height: 2048, raw }), 'image/png'), true);
});

test('PNG refuses packed Adam7 pixels because the dependency cannot reliably decode them', async () => {
  await assert.rejects(validateImageDecode(png({ color: 0, depth: 1, interlace: 1, raw: [0, 128] }), 'image/png'), incomplete);
});

test('JPEG strict decoding reconstructs a synthetic baseline image', async () => {
  const bytes = jpeg.encode({ data: new Uint8Array(7 * 5 * 4).fill(123), width: 7, height: 5 }, 80).data;
  assert.equal(await validateImageDecode(bytes, 'image/jpeg'), true);
});

test('JPEG reconstructs a progressive image containing ten separate entropy scans', async () => {
  // Synthetic 8x8 red image, generated with Pillow's progressive JPEG encoder.
  const bytes = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABigy4/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
  assert.equal(await validateImageDecode(bytes, 'image/jpeg'), true);
});

test('JPEG rejects missing EOI, entropy truncation with a forged EOI and trailing data', async () => {
  const bytes = jpeg.encode({ data: new Uint8Array(8 * 8 * 4).fill(123), width: 8, height: 8 }).data;
  const scan = bytes.findIndex((value, index) => value === 255 && bytes[index + 1] === 0xda);
  const entropy = scan + 2 + (bytes[scan + 2] << 8 | bytes[scan + 3]);
  for (const sample of [bytes.subarray(0, bytes.length - 2), join([bytes.subarray(0, entropy), [255, 217]]), join([bytes, [0]])]) {
    await assert.rejects(validateImageDecode(sample, 'image/jpeg'), incomplete);
  }
});

test('JPEG limits advertised dimensions before invoking the decoder', async () => {
  const bytes = Uint8Array.from(jpeg.encode({ data: new Uint8Array(16), width: 2, height: 2 }).data);
  const frame = bytes.findIndex((value, index) => value === 255 && bytes[index + 1] === 0xc0);
  bytes.set([255, 255, 255, 255], frame + 5);
  await assert.rejects(validateImageDecode(bytes, 'image/jpeg'), large);
});

test('GIF decodes all animation frames through the real RGBA decoder', async () => {
  assert.equal(await validateImageDecode(gif(), 'image/gif'), true);
  assert.equal(await validateImageDecode(gif({ width: 16, height: 16 }), 'image/gif'), true);
});

test('GIF rejects a damaged second frame that omggif would otherwise only warn about', async () => {
  const bytes = gif();
  const frame = new omggif.GifReader(bytes).frameInfo(1);
  bytes[frame.data_offset + 2] = 255;
  await assert.rejects(validateImageDecode(bytes, 'image/gif'), incomplete);
});

test('GIF rejects missing EOI even if the container trailer remains intact', async () => {
  const bytes = gif({ width: 1, height: 1, frames: 1 });
  const frame = new omggif.GifReader(bytes).frameInfo(0);
  bytes[frame.data_offset + frame.data_length - 2] = 0;
  await assert.rejects(validateImageDecode(bytes, 'image/gif'), incomplete);
});

test('GIF rejects missing trailers, trailing bytes and truncated palette/subblocks', async () => {
  const bytes = gif();
  for (const sample of [bytes.subarray(0, bytes.length - 1), join([bytes, [0x3b]]), bytes.subarray(0, 15)]) {
    await assert.rejects(validateImageDecode(sample, 'image/gif'), incomplete);
  }
});

test('GIF rejects palette references that cannot produce valid pixels', async () => {
  const bytes = gif({ width: 1, height: 1, frames: 1, palette: [0, 0xffffff], values: [3] });
  await assert.rejects(validateImageDecode(bytes, 'image/gif'), incomplete);
});

test('GIF enforces frame count and aggregate canvas work independently', async () => {
  await assert.rejects(validateImageDecode(gif({ width: 1, height: 1, frames: 101 }), 'image/gif'), large);
  await assert.rejects(validateImageDecode(gif({ width: 2048, height: 2048, frames: 5, tiny: true }), 'image/gif'), large);
});

test('WebP actually decodes lossless and lossy/alpha samples with bundled libwebp', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('A codec must not load WASM from the network'));
  assert.equal(await validateImageDecode(WEBP_LOSSLESS, 'image/webp'), true);
  assert.equal(await validateImageDecode(WEBP_LOSSY, 'image/webp'), true);
});

test('WebP decodes every ANMF frame and rejects corruption in the later frame', async () => {
  assert.equal(await validateImageDecode(animatedWebp(), 'image/webp'), true);
  await assert.rejects(validateImageDecode(animatedWebp({ badLast: true }), 'image/webp'), incomplete);
});

test('WebP rejects truncation and inconsistent RIFF lengths', async () => {
  for (const bytes of [WEBP_LOSSLESS.subarray(0, WEBP_LOSSLESS.length - 1), join([WEBP_LOSSLESS, [0]])]) {
    await assert.rejects(validateImageDecode(bytes, 'image/webp'), incomplete);
  }
});

test('WebP checks pixel and frame limits before the WASM decoder', async () => {
  const bytes = WEBP_LOSSLESS.slice();
  bytes.set([255, 255, 255, 15], 21);
  await assert.rejects(validateImageDecode(bytes, 'image/webp'), large);
  await assert.rejects(validateImageDecode(animatedWebp({ frames: 101 }), 'image/webp'), large);
});

test('signatures, unsupported formats and compressed byte limits cannot be mistaken for success', async () => {
  await assert.rejects(validateImageDecode(png(), 'image/jpeg'), incomplete);
  await assert.rejects(validateImageDecode(new Uint8Array(6 * 1024 * 1024 + 1), 'image/png'), large);
  await assert.rejects(validateImageDecode(new Uint8Array(12), 'image/png'), incomplete);
  await assert.rejects(validateImageDecode(join([[0, 0, 0, 24], Buffer.from('ftypavif'), new Uint8Array(12)]), 'image/avif'), incomplete);
  await assert.rejects(validateImageDecode({}, 'image/png'), incomplete);
  assert.equal(await validateImageDecode(png().buffer, 'IMAGE/PNG; charset=binary'), true);
});

test('tiny container blocks cannot amplify a small file into unbounded object allocations', async () => {
  await assert.rejects(validateImageDecode(png({ before: Array.from({ length: 4096 }, () => chunk('tEXt', [])) }), 'image/png'), large);
  await assert.rejects(validateImageDecode(riff(Array.from({ length: 4097 }, () => riffChunk('JUNK', []))), 'image/webp'), large);
  const bytes = gif({ width: 1, height: 1, frames: 1 });
  const comments = join([[0x21, 0xfe], new Uint8Array(32769 * 2).map((_, index) => index % 2 === 0 ? 1 : 0), [0]]);
  await assert.rejects(validateImageDecode(join([bytes.subarray(0, bytes.length - 1), comments, [0x3b]]), 'image/gif'), large);
});
