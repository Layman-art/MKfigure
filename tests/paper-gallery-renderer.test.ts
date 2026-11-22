import { describe, expect, it } from 'vitest';
import type { PaperFigure } from '../src/shared/types';
import { figureImage, galleryShareUrl, initialFilters, makeSearchIndex, queryFigures, readGalleryLink } from '../src/renderer/paper-gallery';
import type { GalleryLocation } from '../src/renderer/paper-gallery';

const make = (id: string, values: Partial<PaperFigure>): PaperFigure => ({
  id, title: 'Design of transformers', authors: ['Ada Li'], venue: 'acl', year: 2023, pattern: 'teaser',
  image: 'images/fixture.jpg', paper: 'https://example.org/paper', ...values,
});
const figures = [
  make('acl2023-2023.acl-long.122', { award: 'honorable', tier: 'oral' }),
  make('iclr24-02', { venue: 'iclr', year: 2024, tier: 'oral', title: 'Model A', authors: ['Chen Hu'], pattern: 'pipeline' }),
  make('iclr24-01', { venue: 'iclr', year: 2024, tier: 'spotlight', title: 'Benchmark B', pattern: 'taxonomy' }),
];
const initial: GalleryLocation = { filters: initialFilters, favoritesOnly: false, id: null };
const index = makeSearchIndex(figures);
const ids = (location: GalleryLocation) => queryFigures(figures, location, new Set([figures[1].id]), index).map(row => row.id);

describe('paper gallery search and upstream links', () => {
  it('ranks venues then ascending year and ID, with separate year/title ordering', () => {
    expect(ids(initial)).toEqual(['iclr24-01', 'iclr24-02', figures[0].id]);
    expect(ids({ ...initial, filters: { ...initialFilters, sort: 'year' } })).toEqual([figures[0].id, 'iclr24-01', 'iclr24-02']);
    expect(ids({ ...initial, filters: { ...initialFilters, sort: 'title' } })).toEqual(['iclr24-01', figures[0].id, 'iclr24-02']);
    expect(figures.map(f => f.id)).toEqual([figures[0].id, 'iclr24-02', 'iclr24-01']);
  });
  it('hotwords AND across case, authors and Chinese/English metadata', () => {
    expect(ids({ ...initial, filters: { ...initialFilters, q: '  li  2024 BENCHMARK 全景 ' } })).toEqual(['iclr24-01']);
    expect(ids({ ...initial, filters: { ...initialFilters, q: 'hu benchmark' } })).toEqual([]);
  });
  it('gives an award precedence over oral and supports intersection with favorites', () => {
    expect(ids({ ...initial, filters: { ...initialFilters, tier: 'best' } })).toEqual([figures[0].id]);
    expect(ids({ ...initial, filters: { ...initialFilters, tier: 'oral' } })).toEqual(['iclr24-02']);
    expect(ids({ ...initial, favoritesOnly: true, filters: { ...initialFilters, year: '2024', pattern: 'pipeline' } })).toEqual(['iclr24-02']);
  });
  it('roundtrips upstream filters, original dotted ID and Unicode search', () => {
    const f = { ...initialFilters, venue: 'acl', year: '2023', tier: 'best', pattern: 'teaser', q: 'Ada 主视觉', sort: 'title' as const };
    const state = { ...initial, filters: f, id: figures[0].id };
    expect(galleryShareUrl(state)).toMatch(/\?v=acl&y=2023&t=best&p=teaser&q=.+&s=title#f=acl2023-2023.acl-long.122$/);
    expect(readGalleryLink(galleryShareUrl(state), figures)).toEqual(state);
    expect(figureImage(figures[0].id)).toBe('mk-gallery://figure/acl2023-2023.acl-long.122');
  });
  it('drops only incompatible filters, rejects unknown targets and unrelated links', () => {
    const target = '#f=' + figures[0].id;
    const restored = readGalleryLink('?v=iclr&y=2023&t=best&p=teaser&q=unknown' + target, figures);
    expect(restored?.filters).toMatchObject({ venue: 'all', year: '2023', tier: 'best', pattern: 'teaser', q: '' });
    expect(readGalleryLink('?v=acl#f=missing', figures)).toMatchObject({ id: null, filters: { venue: 'acl' } });
    expect(galleryShareUrl(readGalleryLink('?v=acl&utm_source=test', figures)!)).toContain('utm_source=test');
    expect(ids({ ...initial, filters: { ...initialFilters, q: '流程图' } })).toEqual(['iclr24-02']);
    for (const bad of ['#f=%', 'https://other.example/?v=acl', 'file:///C:/x']) expect(readGalleryLink(bad, figures)).toBeNull();
    expect(galleryShareUrl({ ...initial, favoritesOnly: true })).toBe('https://qwdwqfwq.github.io/topconf-paper-figure-gallery/');
  });
});
