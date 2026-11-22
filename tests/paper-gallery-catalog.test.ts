import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { citationFromFigure, PaperGallery } from '../src/main/paper-gallery';

const root = fileURLToPath(new URL('../resources/paper-gallery/', import.meta.url));
const gallery = new PaperGallery(root);

describe('published paper catalog', () => {
  it('keeps the original IDs and figures complete across all venues', async () => {
    const rows = await gallery.list();
    expect(rows).toHaveLength(3449);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    for (const id of ['acl2023-2023.acl-long.122', 'iclr2024-0684', rows.find(row => row.venue === 'cvpr' && row.id.includes('_'))!.id]) {
      const row = await gallery.figure(id);
      expect(citationFromFigure(row)).toMatchObject({ id, authors: row.authors, title: row.title, paper: row.paper });
      expect(await gallery.paperUrl(id, 'pdf')).toBe(row.pdf_source);
    }
  });
  it('resolves only records in the installed index', async () => {
    await expect(gallery.figure('missing-record')).rejects.toThrow('图库中没有');
  });
});
