// Generate placeholder icons so the VSIX packages and validates.
//
// These are deliberately abstract: no Argo logo, no Argo mark. "ARGO" is a registered
// trademark of The Linux Foundation, and this project uses the name nominatively only.
// Replace with real artwork before the first public publish.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixelAt) {
    const raw = Buffer.alloc(size * (size * 4 + 1));
    let offset = 0;
    for (let y = 0; y < size; y += 1) {
        raw[offset] = 0; // filter: none
        offset += 1;
        for (let x = 0; x < size; x += 1) {
            const [r, g, b, a] = pixelAt(x, y);
            raw[offset] = r;
            raw[offset + 1] = g;
            raw[offset + 2] = b;
            raw[offset + 3] = a;
            offset += 4;
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // colour type: RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** Rounded square in a deployment orange, with a white ring and a filled centre. */
function makeIcon(size) {
    const radius = size * 0.22;
    const centre = (size - 1) / 2;
    const ringOuter = size * 0.32;
    const ringInner = size * 0.24;
    const dot = size * 0.11;

    return encodePng(size, (x, y) => {
        const dx = x - centre;
        const dy = y - centre;
        const distance = Math.hypot(dx, dy);

        // Rounded-rectangle mask.
        const ox = Math.max(Math.abs(dx) - (size / 2 - radius), 0);
        const oy = Math.max(Math.abs(dy) - (size / 2 - radius), 0);
        if (Math.hypot(ox, oy) > radius) {
            return [0, 0, 0, 0];
        }

        const inRing = distance <= ringOuter && distance >= ringInner;
        const inDot = distance <= dot;
        return inRing || inDot ? [255, 255, 255, 255] : [239, 122, 63, 255];
    });
}

const tasksDir = path.join(ROOT, 'tasks');
const taskIcons = fs.existsSync(tasksDir)
    ? fs
          .readdirSync(tasksDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({ file: path.join(tasksDir, entry.name, 'icon.png'), size: 32 }))
    : [];

const targets = [{ file: path.join(ROOT, 'images', 'extension-icon.png'), size: 128 }, ...taskIcons];

for (const { file, size } of targets) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, makeIcon(size));
    console.log(`wrote ${path.relative(ROOT, file)} (${size}x${size})`);
}
