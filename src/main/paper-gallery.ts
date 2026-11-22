import fs from 'node:fs/promises';
import path from 'node:path';
import type { PaperCitation, PaperFigure } from '../shared/types';
import type { GalleryImageCache } from './gallery-cache';

export const GALLERY_SITE = 'https://qwdwqfwq.github.io/topconf-paper-figure-gallery/';
export const GALLERY_RIGHTS = 'https://github.com/qwdwqfwq/topconf-paper-figure-gallery/blob/main/IMAGES_POLICY.md';

/** Read only the publication snapshot shipped with the desktop app. */
export class PaperGallery {
  private catalog?: Promise<Map<string, PaperFigure>>;
  constructor(private readonly root: string, private readonly cache?: GalleryImageCache) {}

  private async readCatalog() {
    const rows: PaperFigure[] = JSON.parse(await fs.readFile(path.join(this.root, 'data', 'figures.json'), 'utf8'));
    if (!Array.isArray(rows) || !rows.length) throw new Error('顶会主图索引缺失，请重新同步图库。');
    const records = new Map<string, PaperFigure>();
    for (const row of rows) {
      if (!/^[a-z]+$/.test(row.venue) || !/^[a-z0-9][a-z0-9._-]*$/i.test(row.id) ||
          row.image !== `images/${row.venue}/final/${row.id}.jpg` || records.has(row.id)) {
        throw new Error('顶会主图索引中的图片路径或编号无效。');
      }
      records.set(row.id, row);
    }
    return records;
  }

  private records() {
    return this.catalog ??= this.readCatalog().catch(error => { this.catalog = undefined; throw error; });
  }
  async list() { return [...(await this.records()).values()]; }
  async figure(id: string) {
    const figure = (await this.records()).get(id);
    if (!figure) throw new Error('图库中没有这张主图。');
    return figure;
  }
  async image(id: string, signal?:AbortSignal) {
    const figure = await this.figure(id);
    if(this.cache) return this.cache.read(figure,signal);
    return fs.readFile(path.join(this.root, figure.image));
  }
  async paperUrl(id: string, kind: 'paper' | 'pdf') {
    const row = await this.figure(id);
    const value = kind === 'paper' ? row.paper : kind === 'pdf' ? row.pdf_source : undefined;
    if (!value) throw new Error('该论文没有可用的来源链接。');
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('论文来源链接无效。');
    return url.href;
  }
}

export function citationFromFigure({ id, title, authors, venue, year, paper, pdf_source }: PaperFigure): PaperCitation {
  return { id, title, authors, venue, year, paper, pdf_source };
}
