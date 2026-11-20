import { createHash } from 'node:crypto';
import { brotliDecompress } from 'node:zlib';
import { generate, parse, type Atrule, type CssNode } from 'css-tree';
import { requestPinnedImage } from './remoteImageSource';

const MAX_CSS_BYTES = 2 * 1024 * 1024;
const MAX_FONT_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ASSETS = 512;
const MAX_FACES = 512;
const REQUEST_TIMEOUT = 10_000;
const BATCH_TIMEOUT = 60_000;

interface FontFace {
  family: string;
  style: string;
  weight: string;
  stretch?: string;
  unicodeRange?: string;
  fileName: string;
}

export interface GoogleFontAssets {
  assets: Map<string, Buffer>;
  faces: FontFace[];
}

function invalid(message: string): never {
  throw new Error(`Google font ${message}`);
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 32 || (code >= 127 && code <= 159);
}

export function normalizeFontOutDir(value: string): string {
  const directory = value.replace(/\/$/, '');
  if (
    !directory ||
    directory.length > 256 ||
    directory
      .split('/')
      .some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
  )
    invalid('outDir must be a relative asset directory without traversal');
  return directory;
}

function validateOptions(families: string[], weights: string[]): void {
  if (
    families.length > 32 ||
    families.some(
      family =>
        !family ||
        family.length > 128 ||
        family.trim() !== family ||
        Array.from(family).some(isControlCharacter)
    )
  )
    invalid('family list is invalid or too large');
  if (
    !weights.length ||
    weights.length > 16 ||
    weights.some(weight => {
      const match = /^([1-9]\d{0,3})(?:\.\.([1-9]\d{0,3}))?$/.exec(weight);
      return (
        !match ||
        Number(match[1]) > 1000 ||
        (match[2] !== undefined && (Number(match[2]) > 1000 || Number(match[2]) < Number(match[1])))
      );
    })
  )
    invalid('weights must be bounded numeric weights or ranges');
}

/** Fixed trusted host selection is separate from the untrusted stylesheet's URL components. */
function googleTarget(source: string, kind: 'css' | 'font'): URL {
  const host = kind === 'css' ? 'fonts.googleapis.com' : 'fonts.gstatic.com';
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return invalid('URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    invalid('origin is not allowed');
  return url;
}

async function download(
  source: string,
  kind: 'css' | 'font',
  parent: AbortSignal
): Promise<Buffer> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('Google font request timed out')),
    REQUEST_TIMEOUT
  );
  const limit = kind === 'css' ? MAX_CSS_BYTES : MAX_FONT_BYTES;
  const allow = new Set([kind === 'css' ? 'fonts.googleapis.com:443' : 'fonts.gstatic.com:443']);
  try {
    let url = googleTarget(source, kind);
    for (let hop = 0; hop <= 5; hop++) {
      controller.signal.throwIfAborted();
      const response = await requestPinnedImage(
        url,
        allow,
        controller.signal,
        kind === 'css' ? 'text/css' : 'font/woff2',
        kind === 'css'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
          : undefined
      );
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          if (!response.headers.location || hop === 5) invalid('redirect limit exceeded');
          url = googleTarget(new URL(response.headers.location, url).href, kind);
          continue;
        }
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300)
          invalid('download failed');
        if (
          response.headers['content-encoding'] &&
          response.headers['content-encoding'] !== 'identity'
        )
          invalid('unexpected response encoding');
        if (Number(response.headers['content-length']) > limit) invalid('response is too large');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response) {
          controller.signal.throwIfAborted();
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > limit) invalid('response is too large');
          chunks.push(bytes);
        }
        if (!response.complete) invalid('response is incomplete');
        return Buffer.concat(chunks, size);
      } finally {
        response.destroy();
      }
    }
    return invalid('redirect limit exceeded');
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    parent.removeEventListener('abort', abort);
  }
}

function declarations(rule: Atrule): Map<string, CssNode> {
  const values = new Map<string, CssNode>();
  const allowed = new Set([
    'font-family',
    'font-style',
    'font-weight',
    'font-stretch',
    'font-display',
    'src',
    'unicode-range',
  ]);
  if (rule.prelude || !rule.block) invalid('stylesheet contains an invalid font-face rule');
  rule.block.children.forEach(declaration => {
    if (
      declaration.type !== 'Declaration' ||
      declaration.important ||
      declaration.value.type !== 'Value'
    )
      invalid('stylesheet contains an invalid font descriptor');
    const property = declaration.property.toLowerCase();
    if (!allowed.has(property) || values.has(property))
      invalid('stylesheet contains an unsupported font descriptor');
    values.set(property, declaration.value);
  });
  return values;
}

function unicodeRange(value: string): string {
  const ranges = value.toUpperCase().split(',');
  if (
    ranges.length > 256 ||
    ranges.some(part => {
      const match = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/.exec(part.trim());
      if (!match) return true;
      if (match[1].includes('?') && (match[2] || !/^[0-9A-F]*\?+$/.test(match[1]))) return true;
      const low = Number.parseInt(match[1].replaceAll('?', '0'), 16);
      const high = Number.parseInt(match[2] ?? match[1].replaceAll('?', 'F'), 16);
      return high > 0x10ffff || low > high;
    })
  )
    return invalid('unicode range is invalid');
  return ranges.map(part => part.trim()).join(', ');
}

function parseFaces(
  css: string,
  family: string
): Array<Omit<FontFace, 'fileName'> & { source: string }> {
  let stylesheet;
  try {
    stylesheet = parse(css, { onParseError: () => invalid('stylesheet cannot be parsed') });
  } catch {
    return invalid('stylesheet cannot be parsed');
  }
  if (stylesheet.type !== 'StyleSheet') return invalid('stylesheet is invalid');
  const faces: Array<Omit<FontFace, 'fileName'> & { source: string }> = [];
  stylesheet.children.forEach(rule => {
    if (rule.type !== 'Atrule' || rule.name.toLowerCase() !== 'font-face')
      invalid('stylesheet contains a non-font rule');
    const values = declarations(rule);
    const familyNode = values.get('font-family');
    if (familyNode?.type !== 'Value' || familyNode.children.size !== 1)
      invalid('family descriptor is invalid');
    const name = familyNode.children.first;
    if (name?.type !== 'String' || name.value !== family)
      invalid('family descriptor does not match the requested family');
    const styleNode = values.get('font-style');
    const style = styleNode ? generate(styleNode).toLowerCase() : 'normal';
    if (!['normal', 'italic', 'oblique'].includes(style)) invalid('style descriptor is invalid');
    const weightNode = values.get('font-weight');
    let weight = weightNode ? generate(weightNode) : '400';
    if (weight === 'normal') weight = '400';
    if (weight === 'bold') weight = '700';
    const weights = weight.split(/\s+/);
    if (
      weights.length > 2 ||
      weights.some(
        value => !/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 1000
      ) ||
      (weights.length === 2 && Number(weights[0]) > Number(weights[1]))
    )
      invalid('weight descriptor is invalid');
    const stretchNode = values.get('font-stretch');
    const stretch = stretchNode && generate(stretchNode).toLowerCase();
    if (
      stretch !== undefined &&
      !/^(?:normal|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|\d{1,3}(?:\.\d+)?%(?: \d{1,3}(?:\.\d+)?%)?)$/.test(
        stretch
      )
    )
      invalid('stretch descriptor is invalid');
    const display = values.get('font-display');
    if (display && !['auto', 'block', 'swap', 'fallback', 'optional'].includes(generate(display)))
      invalid('display descriptor is invalid');
    const src = values.get('src');
    if (src?.type !== 'Value') invalid('source descriptor is missing');
    const parts = src.children.toArray();
    const url = parts[0];
    const format = parts[1];
    if (
      url?.type !== 'Url' ||
      parts.length > 2 ||
      (format &&
        (format.type !== 'Function' ||
          format.name.toLowerCase() !== 'format' ||
          format.children.size !== 1 ||
          format.children.first?.type !== 'String' ||
          format.children.first.value !== 'woff2'))
    )
      invalid('source descriptor must contain one WOFF2 URL');
    const source = googleTarget(url.value, 'font').href;
    const range = values.get('unicode-range');
    faces.push({
      family,
      style,
      weight,
      stretch,
      unicodeRange: range ? unicodeRange(generate(range)) : undefined,
      source,
    });
  });
  if (!faces.length || faces.length > MAX_FACES)
    invalid('stylesheet has an invalid number of font faces');
  return faces;
}

function decompress(bytes: Buffer, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    brotliDecompress(bytes, { maxOutputLength: limit }, (error, result) => {
      if (error) reject(new Error('Google font WOFF2 compressed data is invalid'));
      else resolve(result);
    });
  });
}

const TABLE_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

/**
 * Admit bounded single-font WOFF2 containers, not arbitrary network bytes or collections.
 * Directory/Brotli validation follows https://www.w3.org/TR/WOFF2/ sections 3–5.
 * This does not replace the browser's semantic OpenType/glyph validation.
 */
export async function validateWoff2(font: Buffer): Promise<void> {
  const fail = () => invalid('WOFF2 container is invalid or too large');
  if (font.length < 50 || font.length > MAX_FONT_BYTES || font.readUInt32BE(0) !== 0x774f4632)
    fail();
  const flavor = font.readUInt32BE(4);
  const tables = font.readUInt16BE(12);
  const sfntSize = font.readUInt32BE(16);
  const compressedSize = font.readUInt32BE(20);
  if (
    ![0x00010000, 0x4f54544f].includes(flavor) ||
    font.readUInt32BE(8) !== font.length ||
    !tables ||
    tables > 256 ||
    font.readUInt16BE(14) !== 0 ||
    sfntSize < 12 + tables * 16 ||
    sfntSize > MAX_DECODED_BYTES ||
    !compressedSize
  )
    fail();
  let cursor = 48;
  const byte = () => {
    if (cursor >= font.length) return fail();
    return font[cursor++];
  };
  const base128 = () => {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const next = byte();
      if ((index === 0 && next === 0x80) || value > 0x1ffffff) return fail();
      value = value * 128 + (next & 0x7f);
      if (!(next & 0x80)) return value;
    }
    return fail();
  };
  const tags = new Set<string>();
  let decodedSize = 0;
  let originalSize = 12 + tables * 16;
  let previousTransformedGlyf = false;
  for (let index = 0; index < tables; index++) {
    const flags = byte();
    const tag =
      (flags & 63) === 63
        ? String.fromCharCode(byte(), byte(), byte(), byte())
        : TABLE_TAGS[flags & 63];
    if (!tag || tags.has(tag) || !/^[\x20-\x7e]{4}$/.test(tag)) fail();
    tags.add(tag);
    const version = flags >> 6;
    const glyfOrLoca = tag === 'glyf' || tag === 'loca';
    if (
      glyfOrLoca
        ? version !== 0 && version !== 3
        : version !== 0 && !(tag === 'hmtx' && version === 1)
    )
      fail();
    const transformed = glyfOrLoca ? version === 0 : version !== 0;
    const original = base128();
    const length = transformed ? base128() : original;
    if (tag === 'loca' && transformed && length !== 0) fail();
    if (previousTransformedGlyf !== (tag === 'loca' && transformed)) fail();
    previousTransformedGlyf = tag === 'glyf' && transformed;
    decodedSize += length;
    originalSize += Math.ceil(original / 4) * 4;
    if (decodedSize > MAX_DECODED_BYTES || originalSize > MAX_DECODED_BYTES) fail();
  }
  if (
    previousTransformedGlyf ||
    !decodedSize ||
    !['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post'].every(tag => tags.has(tag))
  )
    fail();
  const compressedStart = cursor;
  cursor += compressedSize;
  if (cursor > font.length) fail();
  const metaOffset = font.readUInt32BE(28);
  const metaLength = font.readUInt32BE(32);
  const metaOriginal = font.readUInt32BE(36);
  const privateOffset = font.readUInt32BE(40);
  const privateLength = font.readUInt32BE(44);
  const advance = (offset: number, length: number) => {
    if (
      !length ||
      offset % 4 ||
      offset < cursor ||
      offset - cursor > 3 ||
      offset + length > font.length
    )
      fail();
    while (cursor < offset) if (font[cursor++] !== 0) fail();
    cursor += length;
  };
  if (metaOffset) {
    if (!metaOriginal || metaOriginal > 1024 * 1024 || metaLength > 1024 * 1024) fail();
    advance(metaOffset, metaLength);
  } else if (metaLength || metaOriginal) fail();
  if (privateOffset) {
    if (privateLength > 1024 * 1024) fail();
    advance(privateOffset, privateLength);
  } else if (privateLength) fail();
  if (font.length - cursor > 3) fail();
  while (cursor < font.length) if (font[cursor++] !== 0) fail();
  const decoded = await decompress(
    font.subarray(compressedStart, compressedStart + compressedSize),
    MAX_DECODED_BYTES
  );
  if (decoded.length !== decodedSize) fail();
  if (
    metaOffset &&
    (await decompress(font.subarray(metaOffset, metaOffset + metaLength), 1024 * 1024)).length !==
      metaOriginal
  )
    fail();
}

export async function loadGoogleFontAssets(
  families: string[],
  weights: string[],
  outDir: string,
  shutdown: AbortSignal
): Promise<GoogleFontAssets> {
  validateOptions(families, weights);
  const directory = normalizeFontOutDir(outDir);
  const controller = new AbortController();
  const abort = () => controller.abort(shutdown.reason);
  if (shutdown.aborted) abort();
  else shutdown.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('Google font batch timed out')),
    BATCH_TIMEOUT
  );
  const bundle: GoogleFontAssets = { assets: new Map(), faces: [] };
  const downloaded = new Map<string, string>();
  let total = 0;
  try {
    for (const family of [...new Set(families)]) {
      controller.signal.throwIfAborted();
      const source =
        'https://fonts.googleapis.com/css2?family=' +
        encodeURIComponent(family).replace(/%20/g, '+') +
        `:wght@${weights.join(';')}&display=swap`;
      const bytes = await download(source, 'css', controller.signal);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) invalid('total download byte budget exceeded');
      let css: string;
      try {
        css = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return invalid('stylesheet encoding is invalid');
      }
      const faces = parseFaces(css, family);
      if (bundle.faces.length + faces.length > MAX_FACES) invalid('face budget exceeded');
      for (const face of faces) {
        controller.signal.throwIfAborted();
        let fileName = downloaded.get(face.source);
        if (!fileName) {
          if (downloaded.size >= MAX_ASSETS) invalid('asset count budget exceeded');
          const font = await download(face.source, 'font', controller.signal);
          total += font.length;
          if (total > MAX_TOTAL_BYTES) invalid('total download byte budget exceeded');
          await validateWoff2(font);
          controller.signal.throwIfAborted();
          fileName = `${directory}/${createHash('sha256').update(font).digest('hex')}.woff2`;
          if (!bundle.assets.has(fileName)) {
            bundle.assets.set(fileName, font);
          }
          downloaded.set(face.source, fileName);
        }
        bundle.faces.push({
          family: face.family,
          style: face.style,
          weight: face.weight,
          stretch: face.stretch,
          unicodeRange: face.unicodeRange,
          fileName,
        });
      }
    }
    return bundle;
  } finally {
    clearTimeout(timeout);
    shutdown.removeEventListener('abort', abort);
  }
}

/** CSS strings are escaped for both the CSS parser and an HTML raw-text style element. */
function cssString(value: string): string {
  let output = '"';
  for (const character of value) {
    if (isControlCharacter(character) || '\\"<>'.includes(character)) {
      output += `\\${character.charCodeAt(0).toString(16)} `;
    } else {
      output += character;
    }
  }
  return output + '"';
}

export function renderGoogleFontCss(
  bundle: GoogleFontAssets,
  assetUrl: (fileName: string) => string
): string {
  return bundle.faces
    .map(
      face =>
        '@font-face {\n' +
        `  font-family: ${cssString(face.family)};\n  font-style: ${face.style};\n  font-weight: ${face.weight};\n` +
        (face.stretch ? `  font-stretch: ${face.stretch};\n` : '') +
        `  font-display: swap;\n  src: url(${cssString(assetUrl(face.fileName))}) format("woff2");\n` +
        (face.unicodeRange ? `  unicode-range: ${face.unicodeRange};\n` : '') +
        '}'
    )
    .join('\n');
}
