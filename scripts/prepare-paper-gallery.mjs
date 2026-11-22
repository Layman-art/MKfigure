import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../resources/paper-gallery/', import.meta.url));
const importer = fileURLToPath(new URL('./sync-paper-gallery.py', import.meta.url));

// Public builds ship an index and acquire verified JPEGs on demand.
async function ready() {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'upstream.json'), 'utf8'));
    const rows = JSON.parse(await fs.readFile(path.join(root, 'data/figures.json'), 'utf8'));
    if (!rows.length || rows.length !== manifest.figures) return false;
    const hashes = JSON.parse(await fs.readFile(path.join(root, 'data/image-hashes.json'), 'utf8'));
    return rows.every(row => /^[0-9a-f]{64}$/.test(hashes[row.id] || ''));
  } catch { return false; }
}

if (process.argv.includes('--verify') || !(await ready())) {
  const candidates = process.platform === 'win32' ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  const python = candidates.find(([name, ...args]) => spawnSync(name, [...args, '-c', 'import sys; sys.exit(sys.version_info < (3, 9))'], {stdio:'ignore'}).status === 0);
  if (!python) throw Error('首次同步或完整校验顶会主图库需要 Python 3.9+。');
  // The importer accepts an already verified offline snapshot and repairs missing data.
  const result = spawnSync(python[0], [...python.slice(1), importer, root], {stdio:'inherit'});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
