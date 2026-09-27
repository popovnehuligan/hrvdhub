import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif|avif)$/;

export const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/** Works out the image format from the file's first bytes. SVG is deliberately not accepted. */
export function detectImageType(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  const brand = buffer.subarray(4, 12).toString('latin1');
  if (brand === 'ftypavif' || brand === 'ftypavis') return 'avif';
  return null;
}

/** Saves image bytes under a random name and returns that name, or null if it isn't a supported image. */
export function saveImage(buffer, uploadsDir) {
  const type = detectImageType(buffer);
  if (!type) return null;
  const name = `${crypto.randomBytes(16).toString('hex')}.${type}`;
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, name), buffer);
  return name;
}

export function imageExists(name, uploadsDir) {
  return IMAGE_NAME.test(name) && fs.existsSync(path.join(uploadsDir, name));
}

/** Deletes uploads no item points to (abandoned forms, replaced photos) once they're a day old. */
export function removeOrphanImages(uploadsDir, items, olderThanMs = 24 * 60 * 60 * 1000) {
  if (!fs.existsSync(uploadsDir)) return 0;
  const used = new Set(items.map((item) => item.image).filter(Boolean));
  let removed = 0;
  for (const name of fs.readdirSync(uploadsDir)) {
    if (!IMAGE_NAME.test(name) || used.has(name)) continue;
    const file = path.join(uploadsDir, name);
    if (Date.now() - fs.statSync(file).mtimeMs > olderThanMs) {
      fs.rmSync(file);
      removed += 1;
    }
  }
  return removed;
}
