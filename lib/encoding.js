import { issue } from './errors.js';

const encodings = new Map([
  ['utf-8', 'utf-8'], ['utf8', 'utf-8'],
  ['utf-16le', 'utf-16le'], ['utf16le', 'utf-16le'],
  ['utf-16be', 'utf-16be'], ['utf16be', 'utf-16be'],
  ['gbk', 'gbk'], ['cp936', 'gbk'],
]);

export function getEncoding(value = 'auto') {
  if (value === 'auto') return undefined;
  const encoding = typeof value === 'string' && encodings.get(value.toLowerCase());
  if (encoding) return encoding;
  throw issue('EINVAL', 'Expected auto, utf-8, utf-16le, utf-16be, gbk, or cp936.');
}

export function getBom(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { encoding: 'utf-16le', length: 2 };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return { encoding: 'utf-16be', length: 2 };
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf-8', length: 3 };
  }
  return { length: 0 };
}

export function detectUtf16(buffer, position) {
  const length = Math.min(buffer.length, 1024);
  if (length < 4) return undefined;
  const zeros = [0, 0];
  for (let index = 0; index < length; index++) {
    if (buffer[index] === 0) zeros[(position + index) % 2]++;
  }
  const pairs = Math.ceil(length / 2);
  const otherSideLimit = Math.max(1, pairs * 0.05);
  if (zeros[1] >= pairs * 0.6 && zeros[0] <= otherSideLimit && zeros[1] >= 4 * zeros[0]) return 'utf-16le';
  if (zeros[0] >= pairs * 0.6 && zeros[1] <= otherSideLimit && zeros[0] >= 4 * zeros[1]) return 'utf-16be';
}

function trimLeadingFragment(buffer, encoding, position, origin) {
  if (position <= origin) return buffer;
  if (encoding === 'utf-8') {
    let start = 0;
    while (start < 3 && (buffer[start] & 0xc0) === 0x80) start++;
    return buffer.subarray(start);
  }
  if (encoding === 'gbk') return buffer;

  const align = (position - origin) % 2;
  const high = buffer[align + (encoding === 'utf-16le' ? 1 : 0)];
  const hasLowSurrogate = buffer.length >= align + 2 && high >= 0xdc && high <= 0xdf;
  return buffer.subarray(align + (hasLowSurrogate ? 2 : 0));
}

const decoders = new Map();

export function decodeText(buffer, encoding, { position = 0, origin = 0, more = false } = {}) {
  const trimmed = trimLeadingFragment(buffer, encoding, position, origin);
  try {
    let decoder = more ? undefined : decoders.get(encoding);
    if (!decoder) {
      decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
      if (!more) decoders.set(encoding, decoder);
    }
    const content = decoder.decode(trimmed, { stream: more });
    // NUL and disallowed C0 controls distinguish many binary files that otherwise decode as GBK.
    if (!/[\x00-\x08\x0E-\x1A\x1C-\x1F\x7F]/u.test(content)) return content;
  } catch (error) {
    if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error;
  }
  return null;
}

export function decodeWindow(buffer, bom, explicit, offset, more) {
  const encoding = explicit ?? bom.encoding ?? detectUtf16(buffer, offset);
  const origin = !explicit || explicit === bom.encoding ? bom.length : 0;
  const skip = Math.max(0, origin - offset);
  const body = buffer.subarray(skip);
  const options = { position: offset + skip, origin, more };
  const utf8 = decodeText(body, encoding ?? 'utf-8', options);
  if (utf8 !== null) return { encoding: encoding ?? 'utf-8', content: utf8 };
  if (!encoding) {
    const gbk = decodeText(body, 'gbk', options);
    if (gbk !== null) return { encoding: 'gbk', content: gbk };
  }
  return { encoding: null, content: buffer.subarray(0, 512).toString('hex'), binary: true };
}

