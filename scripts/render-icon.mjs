// Packages resources/icon-source.png at 1024px inside the project's installed Electron, then writes
// icon.png (1024), icon.ico (256/48/32/16, PNG-compressed), icon.icns (ic10/ic09/ic08/ic07).
// Usage: node scripts/render-icon.mjs   (re-launches itself under Electron automatically)
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const selfPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(selfPath), '..');

if (!process.versions.electron) {
  const electronBinary = require('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electronBinary, [selfPath], { stdio: 'inherit', cwd: root, env, windowsHide: true });
  process.exit(result.status ?? 1);
}

const { app, nativeImage } = require('electron');

const sourcePath = path.join(root, 'resources', 'icon-source.png');

app.commandLine.appendSwitch('force-device-scale-factor', '1');

function pngToIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((entry, i) => {
    const o = 16 * i;
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, o);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(entry.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map(e => e.png)]);
}

function pngToIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const out = Buffer.alloc(8);
  out.write('icns', 0, 'ascii');
  out.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([out, body]);
}

async function main() {
  await app.whenReady();
  const image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) throw new Error('Cannot load the app icon');

  const at = size => image.resize({ width: size, height: size, quality: 'best' }).toPNG();

  fs.writeFileSync(path.join(root, 'resources', 'icon.png'), at(1024));
  fs.writeFileSync(path.join(root, 'resources', 'icon.ico'), pngToIco([256, 48, 32, 16].map(size => ({ size, png: at(size) }))));
  fs.writeFileSync(path.join(root, 'resources', 'icon.icns'), pngToIcns([
    { type: 'ic10', png: at(1024) },
    { type: 'ic09', png: at(512) },
    { type: 'ic08', png: at(256) },
    { type: 'ic07', png: at(128) },
  ]));

  const previewDir = path.join(root, '.runtime');
  fs.mkdirSync(previewDir, { recursive: true });
  fs.writeFileSync(path.join(previewDir, 'icon-preview-32.png'), at(32));
  fs.writeFileSync(path.join(previewDir, 'icon-preview-64.png'), at(64));
  console.log('icon.png (1024), icon.ico (256/48/32/16), icon.icns (ic10/ic09/ic08/ic07) written');
  app.exit(0);
}

main().catch(error => { console.error(error); app.exit(1); });
