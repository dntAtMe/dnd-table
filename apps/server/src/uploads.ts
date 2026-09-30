// Image uploads (battle maps, later token art and handouts).
// Files are stored under unguessable names and served as immutable static assets.

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    mime: 'image/webp',
    ext: 'webp',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

export const UPLOAD_MIME_TYPES = SIGNATURES.map((s) => s.mime);

/** Identifies an image by its magic bytes, ignoring whatever Content-Type the client claimed. */
export function sniffImage(body: Buffer): { mime: string; ext: string } | undefined {
  const sig = SIGNATURES.find((s) => s.test(body));
  return sig && { mime: sig.mime, ext: sig.ext };
}
