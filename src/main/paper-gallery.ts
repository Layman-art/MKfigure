import fs from 'node:fs/promises';
import path from 'node:path';
import type { PaperFigure } from '../shared/types';
import { formNames, journalVenues, studyCategories } from '../shared/gallery-taxonomy';
import type { GalleryImageCache } from './gallery-cache';

export const GALLERY_SITE = 'https://qwdwqfwq.github.io/topconf-paper-figure-gallery/';
export const GALLERY_RIGHTS = 'https://github.com/qwdwqfwq/topconf-paper-figure-gallery/blob/main/IMAGES_POLICY.md';

/** Load the pinned upstream snapshot and MK Figure's individually sourced figure crops. */
export class PaperGallery {
  private catalog?: Promise<Map<string, PaperFigure>>;
  constructor(private readonly root: string, private readonly cache?: GalleryImageCache) {}

  private async readCatalog() {
    const [original, supplement, journals]: PaperFigure[][] = await Promise.all(['data/figures.json', 'supplement/figures.json', 'journals/figures.json'].map(async file => {
      try { return JSON.parse(await fs.readFile(path.join(this.root, file), 'utf8')); }
      catch (error) {
        if (file === 'journals/figures.json' && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }));
    if (!Array.isArray(original) || !original.length || !Array.isArray(supplement) || !Array.isArray(journals)) throw new Error('论文图库索引缺失，请重新安装图库。');
    const excluded: string[] = await fs.readFile(path.join(this.root, 'conference-exclusions.json'), 'utf8')
      .then(data => JSON.parse(data)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
    if (!Array.isArray(excluded) || !excluded.every(id => typeof id === 'string')) throw new Error('论文图库筛选清单无效。');
    const retired = new Set(excluded);
    const records = new Map<string, PaperFigure>();
    for (const rows of [original, supplement, journals]) {
      for (const row of rows) {
        const custom = rows !== original;
        const journal = rows === journals;
        if (!journal && retired.has(row.id)) continue;
        const extension = journal && row.image.endsWith('.webp') ? '.webp' : '.jpg';
        const expected = custom ? `${journal ? 'journals' : 'supplement'}/images/${row.id}${extension}` : `images/${row.venue}/final/${row.id}.jpg`;
        if (!/^[a-z]+$/.test(row.venue) || !/^[a-z0-9][a-z0-9._-]*$/i.test(row.id) || row.image !== expected ||
            records.has(row.id) || (custom ? !validSupplement(row, journal) : row.supplement !== undefined)) {
          throw new Error('论文图库中的编号、分类或图片路径无效。');
        }
        records.set(row.id, row);
      }
    }
    return records;
  }

  private records() {
    return this.catalog ??= this.readCatalog().catch(error => { this.catalog = undefined; throw error; });
  }
  async list() { return [...(await this.records()).values()]; }
  async figure(id: string) {
    const figure = (await this.records()).get(id);
    if (!figure) throw new Error('图库中没有这张图。');
    return figure;
  }
  async image(id: string, signal?:AbortSignal) {
    const figure = await this.figure(id);
    if(this.cache) return this.cache.read(figure,signal);
    return fs.readFile(path.join(this.root, figure.image));
  }
  async thumbnail(id: string, signal?: AbortSignal) {
    const figure = await this.figure(id);
    return this.cache ? this.cache.thumbnail(figure, signal) : this.image(id, signal);
  }
  async paperUrl(id: string, kind: 'paper' | 'pdf' | 'figure') {
    const row = await this.figure(id);
    const value = kind === 'paper' ? row.paper : kind === 'pdf' ? row.pdf_source : kind === 'figure' ? row.figureUrl : undefined;
    if (!value) throw new Error('该论文没有可用的来源链接。');
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('论文来源链接无效。');
    if (kind === 'pdf' && row.page) url.hash = 'page=' + row.page;
    return url.href;
  }
}

function validSupplement(row: PaperFigure, journal: boolean) {
  const info = row.supplement;
  if (!info || !row.id.startsWith('mk-') || !/^Figure [1-9]\d*$/.test(row.figure || '') ||
      !info.description || !/^[a-f0-9]{64}$/.test(info.sha256)) return false;
  const pdfPage = !!row.pdf_source && Number.isInteger(row.page) && row.page! >= 1;
  if (journal) {
    if (info.collection !== 'journal' || info.category === 'main' || !Object.hasOwn(journalVenues, row.venue) ||
        !row.id.startsWith('mk-j-') || !/^10\.\d{4,9}\/\S+$/i.test(row.doi || '') ||
        !Number.isInteger(row.year) || !Array.isArray(row.authors) || !row.authors.length || !row.title || (!pdfPage && !row.figureUrl)) return false;
  } else if (info.collection || (!pdfPage && !(row.figureUrl?.includes('#') && info.imageSource))) return false;
  if (info.category === 'main') return row.figure === 'Figure 1';
  if (!Object.hasOwn(studyCategories, info.category) || (!journal && row.figure === 'Figure 1')) return false;
  if (info.category !== 'result') return true;
  return !!info.dimensions?.length && info.dimensions.every(d => d === '2d' || d === '3d') &&
    !!info.forms?.length && info.forms.every(form => Object.hasOwn(formNames, form));
}
