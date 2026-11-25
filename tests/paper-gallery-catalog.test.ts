import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { GalleryImageCache } from '../src/main/gallery-cache';
import type { PaperFigure } from '../src/shared/types';
import { PaperGallery } from '../src/main/paper-gallery';
import { citationFromFigure, studyDimension } from '../src/shared/gallery-taxonomy';

const root = fileURLToPath(new URL('../resources/paper-gallery/', import.meta.url));
const gallery = new PaperGallery(root);

describe('published paper catalog', () => {
  it('retains every selected upstream ID and suppresses retired figures throughout the catalog', async () => {
    const rows = await gallery.list();
    const pinned = JSON.parse(await readFile(new URL('../resources/paper-gallery/data/figures.json', import.meta.url), 'utf8')) as {id:string}[];
    const retired = new Set<string>(JSON.parse(await readFile(new URL('../resources/paper-gallery/conference-exclusions.json', import.meta.url), 'utf8')));
    expect(pinned).toHaveLength(3449);
    expect(rows.filter(row => !row.supplement).map(row => row.id)).toEqual(pinned.map(row => row.id).filter(id => !retired.has(id)));
    expect(rows.some(row => retired.has(row.id))).toBe(false);
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
  it('reads a withdrawn reference only for a saved layout while a stale mixed index and existing cache stay usable', async () => {
    const historic: PaperFigure[] = JSON.parse(gunzipSync(await readFile(path.join(root, 'retired-layout-2.1.0.json.gz'))).toString());
    const old = historic[0];
    const bytes = Buffer.from('fixture for content-addressed reference');
    old.supplement!.sha256 = createHash('sha256').update(bytes).digest('hex');
    const folder = await mkdtemp(path.join(tmpdir(),'mk-layout-history-'));
    try {
      for (const sub of ['data','supplement','journals','cache']) await mkdir(path.join(folder,sub));
      const upstream = (await gallery.list()).find(row=>!row.supplement)!;
      const kept = (await gallery.list()).find(row=>row.venue==='tie')!;
      for (const [name, value] of Object.entries({
        'upstream.json':{revision:'a'.repeat(40)}, 'data/image-hashes.json':{}, 'data/figures.json':[upstream],
        'supplement/figures.json':[], 'journals/figures.json':[kept, old, {...old,venue:'unknown'}]
      })) await writeFile(path.join(folder,name),JSON.stringify(value));
      await writeFile(path.join(folder,'retired-layout-2.1.0.json.gz'),gzipSync(JSON.stringify(historic)));
      const cachedFile = path.join(folder,'cache',old.supplement!.sha256+path.extname(old.image));
      await writeFile(cachedFile,bytes);
      const cache = new GalleryImageCache(folder,path.join(folder,'cache'));
      const mixed = new PaperGallery(folder,cache);
      const current = await mixed.list();
      expect(current.map(row=>row.id)).toEqual([upstream.id,kept.id]);
      await expect(mixed.figure(old.id)).rejects.toThrow('图库中没有');
      await expect(mixed.thumbnail(old.id)).rejects.toThrow('图库中没有');
      await expect(mixed.paperUrl(old.id,'paper')).rejects.toThrow('图库中没有');
      await expect(mixed.layoutReference(old.id,async()=>false)).rejects.toThrow('图库中没有');
      const reference = await mixed.layoutReference(old.id,async()=>true);
      expect(reference.bytes).toEqual(bytes);
      expect(reference.figure.doi).toBe(old.doi);
      expect(await cache.status(current)).toMatchObject({total:2,available:0});
      expect(await readFile(cachedFile)).toEqual(bytes);
    } finally { await rm(folder,{recursive:true,force:true}); }
  });
  it('resolves only records in the installed index', async () => {
    await expect(gallery.figure('missing-record')).rejects.toThrow('图库中没有');
  });
  it('keeps the curated exclusions and opens the adaptive power-flow chart from its vector source', async () => {
    const records = await gallery.list();
    const excluded = ['mk-j-tpwrs-2d9fbfcceef9ae-f12', 'mk-j-tpwrs-75594994970eb7-f8'];
    expect(records.filter(row => excluded.includes(row.id))).toHaveLength(0);
    for (const id of excluded) await expect(gallery.figure(id)).rejects.toThrow('图库中没有');
    const chart = await gallery.figure('mk-j-tpwrs-272b012f5d0b3e-f3');
    expect(chart.w).toBeGreaterThanOrEqual(1300);
    expect(chart.h).toBeGreaterThanOrEqual(2400);
    expect(chart.pdf_source).toContain('molzahn.github.io/');
    expect(chart.supplement?.cropPdfPoints).toHaveLength(4);
  });
});
