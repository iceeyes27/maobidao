import jpeg from 'jpeg-js';
import { convertIndexedToRgb, decode as decodePng } from 'fast-png';
import omggif from 'omggif';
import { assertImage, CollectorError } from './collector-security.js';

// Decode in the image Durable Object, never on the Free Worker's 10ms path.
// These independent limits bound compressed input, allocations and animation work.
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_PIXELS = 4 * 1024 * 1024;
const MAX_RASTER_BYTES = 16 * 1024 * 1024;
const MAX_FRAMES = 100;
const MAX_ANIMATION_PIXELS = 16 * 1024 * 1024;
const MAX_CONTAINER_CHUNKS = 4096;
const MAX_GIF_SUBBLOCKS = 32768;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const text = new TextDecoder('ascii');
let webpDecoder;

function invalid(message = '文章图片无法完整解码，采集未完成') {
  throw new CollectorError('IMAGE_INCOMPLETE', message);
}

function tooLarge() {
  throw new CollectorError('RESOURCE_TOO_LARGE', '图片解码所需的像素、内存或动画帧数超过允许范围');
}

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) invalid();
  if (width * height > MAX_PIXELS) tooLarge();
  return width * height;
}

function animationBudget(frames, pixels) {
  if (frames > MAX_FRAMES || pixels > MAX_ANIMATION_PIXELS) tooLarge();
}

function u16(bytes, offset) { return bytes[offset] | bytes[offset + 1] << 8; }
function u24(bytes, offset) { return u16(bytes, offset) | bytes[offset + 2] << 16; }
function u32(bytes, offset) { return (u24(bytes, offset) | bytes[offset + 3] << 24) >>> 0; }
function be32(bytes, offset) { return ((bytes[offset] << 24) | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0; }
function name(bytes, offset, length = 4) { return text.decode(bytes.subarray(offset, offset + length)); }
function join(parts, size = parts.reduce((sum, part) => sum + part.length, 0)) {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

// PNG decoders may ignore damaged ancillary chunks or inflate unbounded profiles.
// Check every CRC, then give the decoder only bounded pixel-related chunks.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset++) crc = CRC_TABLE[(crc ^ bytes[offset]) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

function pngLayout(bytes) {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) invalid();
  const kept = [PNG_SIGNATURE], compressed = [];
  let width, height, depth, color, channels, interlace, paletteSize = 0;
  let offset = 8, chunkCount = 0, dataStarted = false, dataEnded = false, transparency = false, ended = false;
  while (offset < bytes.length) {
    if (++chunkCount > MAX_CONTAINER_CHUNKS) tooLarge();
    if (offset + 12 > bytes.length) invalid();
    const length = be32(bytes, offset), type = name(bytes, offset + 4);
    const start = offset + 8, end = start + length;
    if (end + 4 > bytes.length || !/^[A-Za-z]{4}$/.test(type) || (bytes[offset + 6] & 32)) invalid();
    if (crc32(bytes, offset + 4, end) !== be32(bytes, end)) invalid('图片 PNG 校验和不正确，采集未完成');
    if (offset === 8 && type !== 'IHDR') invalid();
    if (dataStarted && type !== 'IDAT') dataEnded = true;
    if (type === 'IHDR') {
      if (width !== undefined || offset !== 8 || length !== 13) invalid();
      width = be32(bytes, start); height = be32(bytes, start + 4);
      dimensions(width, height);
      depth = bytes[start + 8]; color = bytes[start + 9]; interlace = bytes[start + 12];
      const validDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
      if (!validDepths[color]?.includes(depth) || bytes[start + 10] || bytes[start + 11] || interlace > 1) invalid();
      // fast-png's Adam7 path assumes whole-byte samples. Refuse packed Adam7
      // rather than claiming success after decoding its rows incorrectly.
      if (interlace && depth < 8) invalid('暂不支持完整校验低位深交错 PNG，采集未完成');
      if (width * height * channels * Math.max(depth / 8, 1) > MAX_RASTER_BYTES) tooLarge();
    } else if (type === 'PLTE') {
      if (paletteSize || dataStarted || length === 0 || length > 768 || length % 3 || color === 0 || color === 4) invalid();
      paletteSize = length / 3;
      if (color === 3 && paletteSize > 1 << depth) invalid();
    } else if (type === 'tRNS') {
      if (transparency || dataStarted || !({ 0: length === 2, 2: length === 6, 3: paletteSize > 0 && length > 0 && length <= paletteSize })[color]) invalid();
      transparency = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !paletteSize)) invalid();
      dataStarted = true;
      compressed.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      if (length || !dataStarted || end + 4 !== bytes.length) invalid();
      ended = true;
    } else if (['acTL', 'fcTL', 'fdAT'].includes(type)) {
      invalid('暂不支持完整校验 APNG 动画，采集未完成');
    } else if (!(bytes[offset + 4] & 32)) invalid();
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) kept.push(bytes.subarray(offset, end + 4));
    offset = end + 4;
  }
  if (!ended) invalid();
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let inflatedSize = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    if (w && h) inflatedSize += (Math.ceil(w * channels * depth / 8) + 1) * h;
  }
  if (inflatedSize > MAX_RASTER_BYTES + height * 7) tooLarge();
  return { width, height, color, paletteSize, inflatedSize, compressed, kept };
}

async function checkPngInflation(parts, expectedSize) {
  // Native deflate checks the zlib trailer/Adler checksum. Cancel as soon as the
  // actual output exceeds the dimension-derived bound, before decoder allocation.
  // Small compressed writes also bound each native transform's temporary output;
  // feeding a whole highly compressible input can allocate too much before read().
  let part = 0, offset = 0;
  const source = new ReadableStream({ pull(controller) {
    while (part < parts.length && offset === parts[part].length) { part++; offset = 0; }
    if (part === parts.length) { controller.close(); return; }
    const end = Math.min(parts[part].length, offset + 1024);
    controller.enqueue(parts[part].subarray(offset, end));
    offset = end;
  } });
  const reader = source.pipeThrough(new DecompressionStream('deflate')).getReader();
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expectedSize) tooLarge();
    }
    if (size !== expectedSize) invalid();
  } finally { await reader.cancel().catch(() => {}); }
}

async function png(bytes) {
  const layout = pngLayout(bytes);
  await checkPngInflation(layout.compressed, layout.inflatedSize);
  const decoded = decodePng(join(layout.kept), { checkCrc: true });
  if (decoded.width !== layout.width || decoded.height !== layout.height || !decoded.data?.length) invalid();
  if (layout.color === 3 && convertIndexedToRgb(decoded).length < layout.width * layout.height * 3) invalid();
}

function jpegDimensions(bytes) {
  let offset = 2, width, height, scans = 0, ended = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) { ended = offset === bytes.length; break; }
    if (marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) invalid();
    const length = bytes[offset] << 8 | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (width !== undefined || length < 8 || bytes[offset + 2] !== 8) invalid();
      height = bytes[offset + 3] << 8 | bytes[offset + 4]; width = bytes[offset + 5] << 8 | bytes[offset + 6];
      dimensions(width, height);
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalid();
      for (let component = 0; component < components; component++) {
        const sampling = bytes[offset + 9 + component * 3];
        if ((sampling >> 4) < 1 || (sampling >> 4) > 4 || (sampling & 15) < 1 || (sampling & 15) > 4) invalid();
      }
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) || marker === 0xdc) invalid();
    offset += length;
    if (marker === 0xda) {
      if (width === undefined) invalid();
      if (++scans > 64) tooLarge();
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { offset++; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || next >= 0xd0 && next <= 0xd7) { offset += 2; continue; }
        break;
      }
    }
  }
  if (!ended || !scans || width === undefined) invalid();
  return { width, height };
}

function decodeJpeg(bytes) {
  const expected = jpegDimensions(bytes);
  const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
    maxResolutionInMP: MAX_PIXELS / 1_000_000, maxMemoryUsageInMB: 48 });
  if (decoded.width !== expected.width || decoded.height !== expected.height || decoded.data.length !== expected.width * expected.height * 4) invalid();
}

function gifLayout(bytes) {
  let offset = 6;
  const take = size => { if (offset + size > bytes.length) invalid(); const start = offset; offset += size; return start; };
  const screen = take(7), width = u16(bytes, screen), height = u16(bytes, screen + 2);
  const pixels = dimensions(width, height);
  let globalPalette = 0, transparent = null, ended = false;
  if (bytes[screen + 4] & 128) { globalPalette = 1 << ((bytes[screen + 4] & 7) + 1); take(globalPalette * 3); }
  const frames = [];
  const blocks = (collect = true) => {
    const parts = [];
    let count = 0;
    while (true) {
      const size = bytes[take(1)];
      if (!size) break;
      if (++count > MAX_GIF_SUBBLOCKS) tooLarge();
      const start = take(size);
      if (collect) parts.push(bytes.subarray(start, start + size));
    }
    return collect ? join(parts) : null;
  };
  while (offset < bytes.length) {
    const marker = bytes[take(1)];
    if (marker === 0x3b) { ended = offset === bytes.length; break; }
    if (marker === 0x21) {
      const label = bytes[take(1)];
      if (label === 0xf9) {
        const start = take(6);
        if (bytes[start] !== 4 || bytes[start + 5] !== 0 || bytes[start + 1] & 0xe0 || (bytes[start + 1] >> 2 & 7) > 3) invalid();
        transparent = bytes[start + 1] & 1 ? bytes[start + 4] : null;
      } else if (label === 0xff || label === 0xfe) { blocks(false); }
      else invalid('GIF 包含不支持完整校验的图形扩展，采集未完成');
      continue;
    }
    if (marker !== 0x2c) invalid();
    const start = take(9), x = u16(bytes, start), y = u16(bytes, start + 2);
    const frameWidth = u16(bytes, start + 4), frameHeight = u16(bytes, start + 6), flags = bytes[start + 8];
    dimensions(frameWidth, frameHeight);
    if (x + frameWidth > width || y + frameHeight > height || flags & 0x18) invalid();
    let palette = globalPalette;
    if (flags & 128) { palette = 1 << ((flags & 7) + 1); take(palette * 3); }
    if (!palette || transparent !== null && transparent >= palette) invalid();
    const minCodeSize = bytes[take(1)], compressed = blocks();
    frames.push({ width: frameWidth, height: frameHeight, palette, minCodeSize, compressed });
    animationBudget(frames.length, frames.length * pixels);
    transparent = null;
  }
  if (!ended || !frames.length) invalid();
  return { width, height, frames };
}

// omggif deliberately tolerates truncated streams. A compact dictionary validator
// supplies strict EOI/count/index checks; omggif still performs the actual RGBA decode.
function checkGifLzw(frame) {
  const { minCodeSize: minimum, compressed, palette } = frame;
  if (minimum < 2 || minimum > 8 || !compressed.length) invalid();
  const clear = 1 << minimum, eoi = clear + 1;
  const lengths = new Uint16Array(4096), first = new Uint16Array(4096), maximum = new Uint16Array(4096);
  for (let value = 0; value < clear; value++) { lengths[value] = 1; first[value] = maximum[value] = value; }
  let size = minimum + 1, next = eoi + 1, previous = -1, bit = 0, written = 0;
  const expected = frame.width * frame.height;
  while (bit + size <= compressed.length * 8) {
    let code = 0;
    for (let shift = 0; shift < size; shift++, bit++) code |= (compressed[bit >> 3] >> (bit & 7) & 1) << shift;
    if (code === clear) { size = minimum + 1; next = eoi + 1; previous = -1; continue; }
    if (code === eoi) {
      if (written !== expected || Math.ceil(bit / 8) !== compressed.length) invalid();
      return;
    }
    if (code > next || code === next && previous < 0 || code >= 4096) invalid();
    const special = code === next;
    const length = special ? lengths[previous] + 1 : lengths[code];
    const firstValue = special ? first[previous] : first[code];
    const maxValue = special ? maximum[previous] : maximum[code];
    if (!length || maxValue >= palette || written + length > expected) invalid();
    written += length;
    if (previous >= 0 && next < 4096) {
      lengths[next] = lengths[previous] + 1;
      first[next] = first[previous]; maximum[next] = Math.max(maximum[previous], firstValue);
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    previous = code;
  }
  invalid();
}

function gif(bytes) {
  const layout = gifLayout(bytes);
  for (const frame of layout.frames) checkGifLzw(frame);
  const reader = new omggif.GifReader(bytes);
  if (reader.width !== layout.width || reader.height !== layout.height || reader.numFrames() !== layout.frames.length) invalid();
  const pixels = new Uint8Array(layout.width * layout.height * 4);
  for (let frame = 0; frame < layout.frames.length; frame++) {
    pixels.fill(0);
    reader.decodeAndBlitFrameRGBA(frame, pixels);
  }
}

function riffChunks(bytes, start = 12, end = bytes.length) {
  const chunks = [];
  while (start < end) {
    if (chunks.length >= MAX_CONTAINER_CHUNKS) tooLarge();
    if (start + 8 > end) invalid();
    const length = u32(bytes, start + 4), limit = start + 8 + length, padded = limit + (length & 1);
    if (padded > end || (length & 1) && bytes[limit] !== 0) invalid();
    chunks.push({ type: name(bytes, start), data: bytes.subarray(start + 8, limit), raw: bytes.subarray(start, padded) });
    start = padded;
  }
  return chunks;
}

function webpDimensions(chunk) {
  const bytes = chunk.data;
  let width, height;
  if (chunk.type === 'VP8 ') {
    if (bytes.length < 10 || bytes[0] & 1 || bytes[3] !== 0x9d || bytes[4] !== 1 || bytes[5] !== 0x2a) invalid();
    width = u16(bytes, 6) & 0x3fff; height = u16(bytes, 8) & 0x3fff;
  } else {
    if (bytes.length < 5 || bytes[0] !== 0x2f || bytes[4] >> 5) invalid();
    const bits = u32(bytes, 1);
    width = (bits & 0x3fff) + 1; height = (bits >>> 14 & 0x3fff) + 1;
  }
  dimensions(width, height);
  return { width, height };
}

function stillWebp(chunks, expected) {
  const image = chunks.filter(chunk => chunk.type === 'VP8 ' || chunk.type === 'VP8L');
  const alpha = chunks.filter(chunk => chunk.type === 'ALPH');
  if (image.length !== 1 || alpha.length > 1 || alpha.length && (image[0].type !== 'VP8 ' || chunks.indexOf(alpha[0]) > chunks.indexOf(image[0]))) invalid();
  const actual = webpDimensions(image[0]);
  if (expected && (expected.width !== actual.width || expected.height !== actual.height)) invalid();
  const parts = [];
  if (alpha.length) {
    const extended = new Uint8Array(18);
    extended.set([86, 80, 56, 88, 10, 0, 0, 0, 16]);
    for (const [offset, value] of [[12, actual.width - 1], [15, actual.height - 1]]) {
      extended[offset] = value; extended[offset + 1] = value >> 8; extended[offset + 2] = value >> 16;
    }
    parts.push(extended, alpha[0].raw);
  }
  parts.push(image[0].raw);
  const length = 4 + parts.reduce((sum, part) => sum + part.length, 0);
  const header = new Uint8Array([82, 73, 70, 70, length & 255, length >> 8 & 255, length >> 16 & 255, length >>> 24, 87, 69, 66, 80]);
  return { bytes: join([header, ...parts]), ...actual };
}

function webpLayout(bytes) {
  if (u32(bytes, 4) + 8 !== bytes.length) invalid();
  const chunks = riffChunks(bytes), extended = chunks.filter(chunk => chunk.type === 'VP8X');
  let canvas;
  if (extended.length) {
    const header = extended[0].data;
    if (extended.length !== 1 || chunks[0] !== extended[0] || header.length !== 10 || header[0] & 0xc1 || header[1] || header[2] || header[3]) invalid();
    canvas = { width: u24(header, 4) + 1, height: u24(header, 7) + 1 };
    dimensions(canvas.width, canvas.height);
  }
  const animated = extended.length && (extended[0].data[0] & 2);
  if (!animated) {
    if (chunks.some(chunk => chunk.type === 'ANIM' || chunk.type === 'ANMF')) invalid();
    return [stillWebp(chunks, canvas)];
  }
  if (chunks.some(chunk => ['ALPH', 'VP8 ', 'VP8L'].includes(chunk.type))) invalid();
  const animations = chunks.filter(chunk => chunk.type === 'ANIM');
  if (animations.length !== 1 || animations[0].data.length !== 6) invalid();
  const frames = [];
  let pixels = 0;
  for (const chunk of chunks.filter(chunk => chunk.type === 'ANMF')) {
    if (chunks.indexOf(chunk) < chunks.indexOf(animations[0]) || chunk.data.length < 16) invalid();
    const data = chunk.data, x = u24(data, 0) * 2, y = u24(data, 3) * 2;
    const size = { width: u24(data, 6) + 1, height: u24(data, 9) + 1 };
    dimensions(size.width, size.height);
    if (x + size.width > canvas.width || y + size.height > canvas.height || data[15] & 0xfc) invalid();
    const frameChunks = riffChunks(data, 16);
    if (frameChunks.some(part => !['ALPH', 'VP8 ', 'VP8L'].includes(part.type))) invalid();
    pixels += size.width * size.height;
    animationBudget(frames.length + 1, pixels);
    frames.push(stillWebp(frameChunks, size));
  }
  if (!frames.length) invalid();
  return frames;
}

async function webp(bytes) {
  const frames = webpLayout(bytes);
  if (!webpDecoder) {
    // Wrangler bundles this literal import as CompiledWasm: no runtime fetch or
    // WebAssembly.compile is used. jSquash's official Workers init accepts it.
    webpDecoder = Promise.all([
      import('@jsquash/webp/decode.js'), import('@jsquash/webp/codec/dec/webp_dec.wasm'),
    ]).then(async ([codec, module]) => { await codec.init(module.default); return codec.default; });
  }
  const decode = await webpDecoder;
  for (const frame of frames) {
    const decoded = await decode(frame.bytes.buffer);
    if (decoded.width !== frame.width || decoded.height !== frame.height || decoded.data?.length !== frame.width * frame.height * 4) invalid();
  }
}

/** Verify complete pixels, not merely a signature or advertised dimensions. */
export async function validateImageDecode(input, contentType) {
  try {
    const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
    if (!bytes || typeof contentType !== 'string') invalid();
    if (bytes.length > MAX_BYTES) tooLarge();
    const type = assertImage(bytes, contentType);
    if (type === 'image/png') await png(bytes);
    else if (type === 'image/jpeg') decodeJpeg(bytes);
    else if (type === 'image/gif') gif(bytes);
    else if (type === 'image/webp') await webp(bytes);
    else invalid('暂不支持完整校验此图片格式，采集未完成');
    return true;
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    if (error instanceof RangeError || /maxMemoryUsageInMB|maxResolutionInMP|out of memory|allocation failed/i.test(error?.message || '')) tooLarge();
    invalid();
  }
}
