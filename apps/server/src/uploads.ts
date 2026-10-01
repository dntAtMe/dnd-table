// GM uploads: images (battle maps, handouts) and audio (the soundboard).
// Files are stored under unguessable names and served as immutable static assets.

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
/** Request body limit: the largest kind we accept. Each kind's own limit is checked after sniffing. */
export const MAX_UPLOAD_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_AUDIO_BYTES);

export type UploadKind = 'image' | 'audio';

interface Signature {
  kind: UploadKind;
  mime: string;
  ext: string;
  test: (b: Buffer) => boolean;
}

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');

/** ISO base media brands used by M4A/AAC audio (and plain MP4 containers, which browsers play the same way). */
const M4A_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'mp41', 'mp42', 'isom', 'iso2', 'dash']);

const SIGNATURES: Signature[] = [
  {
    kind: 'image',
    mime: 'image/png',
    ext: 'png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { kind: 'image', mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', mime: 'image/gif', ext: 'gif', test: (b) => ascii(b, 0, 4) === 'GIF8' },
  { kind: 'image', mime: 'image/webp', ext: 'webp', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  // MP3 with an ID3v2 tag, or starting straight at an MPEG audio frame (sync bits, valid version and layer).
  { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3', test: (b) => ascii(b, 0, 3) === 'ID3' },
  {
    kind: 'audio',
    mime: 'audio/mpeg',
    ext: 'mp3',
    test: (b) => b[0] === 0xff && b.length > 1 && (b[1]! & 0xe0) === 0xe0 && ((b[1]! >> 3) & 3) !== 1 && ((b[1]! >> 1) & 3) !== 0,
  },
  // Raw AAC in ADTS frames (sync bits with layer 0).
  { kind: 'audio', mime: 'audio/aac', ext: 'aac', test: (b) => b[0] === 0xff && b.length > 1 && (b[1]! & 0xf6) === 0xf0 },
  { kind: 'audio', mime: 'audio/ogg', ext: 'ogg', test: (b) => ascii(b, 0, 4) === 'OggS' },
  { kind: 'audio', mime: 'audio/wav', ext: 'wav', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE' },
  { kind: 'audio', mime: 'audio/flac', ext: 'flac', test: (b) => ascii(b, 0, 4) === 'fLaC' },
  { kind: 'audio', mime: 'audio/mp4', ext: 'm4a', test: (b) => ascii(b, 4, 8) === 'ftyp' && M4A_BRANDS.has(ascii(b, 8, 12)) },
];

/** Content types clients may label uploads with; the body is sniffed regardless. */
export const UPLOAD_MIME_TYPES = [
  ...new Set([
    ...SIGNATURES.map((s) => s.mime),
    'audio/mp3',
    'audio/x-wav',
    'audio/wave',
    'audio/x-m4a',
    'audio/x-flac',
    'video/ogg',
    'video/mp4',
  ]),
];

export const MAX_BYTES: Record<UploadKind, number> = { image: MAX_IMAGE_BYTES, audio: MAX_AUDIO_BYTES };

/** Identifies an upload by its magic bytes, ignoring whatever Content-Type the client claimed. */
export function sniffUpload(body: Buffer): { kind: UploadKind; mime: string; ext: string } | undefined {
  const sig = SIGNATURES.find((s) => s.test(body));
  return sig && { kind: sig.kind, mime: sig.mime, ext: sig.ext };
}

/** Identifies an image by its magic bytes. */
export function sniffImage(body: Buffer): { mime: string; ext: string } | undefined {
  const found = sniffUpload(body);
  return found?.kind === 'image' ? { mime: found.mime, ext: found.ext } : undefined;
}
