import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PaperGallery } from '../src/main/paper-gallery';
import { citationFromFigure, studyDimension } from '../src/shared/gallery-taxonomy';

const root = fileURLToPath(new URL('../resources/paper-gallery/', import.meta.url));
const gallery = new PaperGallery(root);

describe('published paper catalog', () => {
  it('keeps the original IDs and figures complete across all venues', async () => {
    const rows = await gallery.list();
    expect(rows.filter(row => !row.supplement)).toHaveLength(3449);
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    for (const id of ['acl2023-2023.acl-long.122', 'iclr2024-0684', rows.find(row => row.venue === 'cvpr' && row.id.includes('_'))!.id]) {
      const row = await gallery.figure(id);
      expect(citationFromFigure(row)).toMatchObject({ id, authors: row.authors, title: row.title, paper: row.paper });
      expect(await gallery.paperUrl(id, 'pdf')).toBe(row.pdf_source);
    }
  });
  it('keeps each curated crop uniquely identified with its hash, citation and actual source page', async () => {
    const rows = (await gallery.list()).filter(row => row.supplement && row.supplement.collection !== 'journal');
    const mains = rows.filter(row => row.supplement!.category === 'main');
    const studies = rows.filter(row => row.supplement!.category !== 'main');
    for (const set of [mains, studies]) {
      expect([...new Set(set.map(row => row.venue))].sort()).toEqual(['aaai','acl','cvpr','iclr','icml','neurips']);
    }
    expect(new Set(studies.map(row => row.supplement!.category))).toEqual(new Set(['result','mechanism','algorithm']));
    expect(new Set(studies.filter(row => row.supplement!.category === 'result').map(studyDimension))).toEqual(new Set(['2d','3d','mixed']));
    const crops = new Set<string>();
    for (const row of rows) {
      const key = row.paper + '#' + row.figure;
      expect(crops.has(key)).toBe(false);
      crops.add(key);
      expect(row.year).toBe(2026);
      expect(citationFromFigure(row)).toMatchObject({ figure: row.figure, authors: row.authors });
      expect(row.supplement!.sourceUrl).toMatch(/^https:\/\//);
      if (row.page) {
        expect(new URL(await gallery.paperUrl(row.id, 'pdf')).hash).toBe('#page=' + row.page);
        expect(row.supplement!.cropPdfPoints).toHaveLength(4);
        expect(row.supplement!.pdfSha256).toMatch(/^[a-f\d]{64}$/);
      } else {
        expect(new URL(await gallery.paperUrl(row.id,'figure')).hash).toBeTruthy();
        expect(row.supplement!.imageSource).toMatch(/^https:\/\//);
      }
      const bytes = await gallery.image(row.id).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (bytes) {
        expect(bytes.readUInt16BE(0)).toBe(0xffd8);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.supplement!.sha256);
      }
    }
  });
  it('preserves each numbered journal figure once with its actual access route', async () => {
    const records=(await gallery.list()).filter(row=>row.supplement?.collection==='journal');
    const seen=new Set<string>();
    for (const row of records) {
      const k=row.doi+'#'+row.figure;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      expect(row.page===undefined || Number.isInteger(row.page) && row.page>0).toBe(true);
      expect(Boolean(row.supplement!.imageSource || row.supplement!.imagePanels?.length || (row.page && row.pdf_source && row.supplement!.cropPdfPoints))).toBe(true);
      expect(await gallery.paperUrl(row.id,'paper')).toBe('https://doi.org/'+row.doi);
      if (row.supplement!.archive) expect(row.supplement!.license).toMatch(/creativecommons\.org\/(?:licenses\/by|publicdomain\/zero)\//);
    }
    expect(records.some(row=>row.figure==='Figure 1' && row.supplement?.category==='algorithm')).toBe(true);
    expect(new Set(records.filter(row=>row.supplement!.category==='result').map(studyDimension))).toEqual(new Set(['2d','3d','mixed']));
    expect(records.some(row=>row.figureUrl && !row.page)).toBe(true);
  });
  it('resolves only records in the installed index', async () => {
    await expect(gallery.figure('missing-record')).rejects.toThrow('图库中没有');
  });
});
