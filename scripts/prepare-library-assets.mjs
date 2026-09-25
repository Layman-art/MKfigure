// Rebuild the bundled image-library catalog and previews without changing source artwork.
// Usage: node scripts/prepare-library-assets.mjs
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '..');
const resources = path.join(root, 'resources');
const library = path.join(resources, 'library');
const source = path.join(root, 'icon-pack');
const icons = [
  ['communication-tower', '通信基站'],
  ['transmission-tower', '输电铁塔'],
  ['person-yellow', '人物 · 黄色衣服'],
  ['person-blue', '人物 · 蓝色衣服'],
  ['person-green', '人物 · 绿色衣服'],
  ['emergency-generator-truck', '应急发电车'],
  ['electric-car', '电动汽车'],
  ['mobile-storage', '移动储能'],
  ['unmanned-vehicle', '无人载具'],
  ['typhoon', '台风'],
];

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [self], {
    cwd: root, env, windowsHide: true, stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, nativeImage } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const writeJson = (filename, value) => fs.writeFileSync(path.join(library, filename), `${JSON.stringify(value, null, 2)}\n`);

async function main() {
  await app.whenReady();
  fs.mkdirSync(path.join(library, 'icons'), { recursive: true });
  fs.mkdirSync(path.join(library, 'thumbs'), { recursive: true });
  const window = new BrowserWindow({
    show: false, width: 400, height: 400,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true },
  });
  await window.loadURL('data:text/html,<html><body></body></html>');
  const catalog = [];
  const hashes = [];
  try {
    for (const [slug, name] of icons) {
      const bytes = fs.readFileSync(path.join(source, `${slug}.svg`));
      const dimensions = bytes.toString('utf8').match(/viewBox=["']([^"']+)["']/)?.[1].trim().split(/\s+/).map(Number);
      if (!dimensions || dimensions.length !== 4 || dimensions[2] <= 0 || dimensions[3] <= 0) {
        throw new Error(`Missing valid SVG viewBox: ${name}`);
      }
      const id = `icon-city-${slug}`;
      const file = `library/icons/${slug}.svg`;
      fs.writeFileSync(path.join(resources, file), bytes);
      const copiedHash = digest(fs.readFileSync(path.join(resources, file)));
      if (copiedHash !== digest(bytes)) throw new Error(`SVG copy changed bytes: ${name}`);
      catalog.push({ id, name: name.replace('_', ' · '), category: 'icon', file,
        thumbnail: `library/thumbs/${id}.png`, mime: 'image/svg+xml', extension: 'svg',
        width: dimensions[2], height: dimensions[3] });
      hashes.push({ id, source: `icon-pack/${slug}.svg`, file, sha256: copiedHash, sourceSha256: digest(bytes), identical: true });
    }
    const references = JSON.parse(fs.readFileSync(path.join(resources, 'references', 'catalog.json'), 'utf8'));
    for (const reference of references) {
      const file = `references/${reference.file}`;
      const bytes = fs.readFileSync(path.join(resources, file));
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error(`Cannot load reference: ${reference.id}`);
      const { width, height } = image.getSize();
      catalog.unshift({ id: reference.id, name: reference.name, category: 'reference', file,
        thumbnail: `library/thumbs/${reference.id}.png`, mime: 'image/png', extension: 'png', width, height });
      hashes.push({ id: reference.id, file, sha256: digest(bytes) });
    }
    // Match the established order of the three reference presets.
    catalog.splice(0, references.length, ...references.map(reference => catalog.find(entry => entry.id === reference.id)));
    for (const item of catalog) {
      const dataUrl = `data:${item.mime};base64,${fs.readFileSync(path.join(resources, item.file)).toString('base64')}`;
      const png = await window.webContents.executeJavaScript(`(async () => {
        const source = new Image();
        source.src = ${JSON.stringify(dataUrl)};
        await source.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 320;
        const context = canvas.getContext('2d');
        const padding = ${item.category === 'icon' ? 28 : 8};
        const scale = Math.min((canvas.width - padding * 2) / ${item.width}, (canvas.height - padding * 2) / ${item.height});
        const width = ${item.width} * scale;
        const height = ${item.height} * scale;
        context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      fs.writeFileSync(path.join(resources, item.thumbnail), Buffer.from(png, 'base64'));
    }
    writeJson('catalog.json', catalog);
    writeJson('hashes.json', hashes);
    fs.writeFileSync(path.join(library, 'provenance.md'), `# Bundled library assets\n\nThe ten city disaster-prevention SVG icons originate from the project owner's previously authorized icon set. The canonical, MIT-licensed SVG files are in \`icon-pack/\`; the application copies them byte for byte to \`resources/library/icons/\`. Source and bundled SHA-256 hashes are recorded in \`hashes.json\`.\n\nThe three reference images reuse the application's existing \`resources/references\` files and stable IDs: \`pastel-method\`, \`algorithm-flow\`, and \`voltage-control\`. The large reference images are not duplicated here.\n\nThe PNG files in \`thumbs\` are 400 × 320 transparent previews rendered locally with Electron. The library retains the original SVG/PNG as the asset; previews are never substituted for the originals.\n\nRebuild with \`node scripts/prepare-library-assets.mjs\`.\n`, 'utf8');
    console.log(`Prepared ${catalog.length} assets: ${icons.length} unchanged SVG icons and ${references.length} existing reference images.`);
  } finally {
    window.destroy();
  }
  app.exit(0);
}

main().catch(error => { console.error(error); app.exit(1); });
