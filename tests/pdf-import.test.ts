import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { importAsset } from '../src/main/assets';
import { Store } from '../src/main/storage';

// The legacy package entry runs a bundled CLI demo when loaded by Vitest. Load its actual parser directly.
vi.mock('pdf-parse', () => ({ default: createRequire(import.meta.url)('pdf-parse/lib/pdf-parse.js') }));
vi.mock('electron', () => ({ nativeImage: {}, safeStorage: {} }));

// A complete one-page PDF. All content is ASCII so string offsets are PDF byte offsets.
function onePagePdf() {
  const stream = 'BT /F1 14 Tf 30 120 Td (MK-Figure archived PDF engine marker 67391) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
  ];
  let pdf = '%PDF-1.4\n';
  const entries = ['0000000000 65535 f '];
  objects.forEach((object, index) => {
    entries.push(String(pdf.length).padStart(10, '0') + ' 00000 n ');
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = pdf.length;
  return Buffer.from(pdf + 'xref\n0 6\n' + entries.join('\n') +
    '\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n', 'ascii');
}

it('imports PDF text with its page marker and stores the original bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mk-figure-import-pdf-'));
  try {
    const store = new Store(directory, directory);
    await store.init();
    const project = randomUUID();
    const assets = path.join(store.projectDir(project), 'assets');
    await mkdir(assets, { recursive: true });
    const file = path.join(directory, 'one-page.pdf');
    const bytes = onePagePdf();
    await writeFile(file, bytes);

    const result = await importAsset(store, project, file);

    expect(result.text?.trim()).toBe('[Page 1]\nMK-Figure archived PDF engine marker 67391');
    expect(await readFile(path.join(assets, result.path))).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
