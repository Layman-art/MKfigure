import { describe, expect, it } from 'vitest';
import type { PaperFigure } from '../src/shared/types';
import { studyFacetCounts, figureImage, galleryShareUrl, initialFilters, makeSearchIndex, queryFigures, readGalleryLink } from '../src/renderer/paper-gallery';
import { journalVenues } from '../src/shared/gallery-taxonomy';
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

describe('local research figure collections', () => {
  const result = (id: string, dimensions: ('2d' | '3d')[]) => make(id, {
    figure: 'Figure 3', page: 7,
    supplement: { category: 'result', sha256: 'a'.repeat(64), description: '端电压仿真', dimensions, forms: ['curve', 'field'] },
  });
  const main = make('mk-new-main', { supplement: { category: 'main', sha256: 'b'.repeat(64), description: '新主图' } });
  const mech = make('mk-physical', { supplement: { category: 'mechanism', sha256: 'c'.repeat(64), description: '残差校正' } });
  const data = [...figures, main, mech, result('mk-2d', ['2d']), result('mk-3d', ['3d']), result('mk-mixed', ['2d', '3d'])];
  const studyFilters = { ...initialFilters, view: 'study' as const };
  const search = makeSearchIndex(data);
  const location = { ...initial, filters: studyFilters };
  const select = (changes: Partial<typeof initialFilters>, saved = false) => queryFigures(data,
    { ...location, filters: { ...studyFilters, ...changes }, favoritesOnly: saved }, new Set([main.id, 'mk-3d']), search).map(row => row.id);

  it('keeps legacy and supplemental main figures together and separates study favorites', () => {
    expect(select({ view: 'main' })).toHaveLength(4);
    expect(select({ view: 'main' }, true)).toEqual([main.id]);
    expect(select({}, true)).toEqual(['mk-3d']);
    expect(select({ category: 'mechanism', q: '机理 残差' })).toEqual([mech.id]);
    expect(select({ category: 'algorithm' })).toEqual([]);
  });
  it('intersects venue, result form, pure or mixed dimensions and bilingual metadata', () => {
    for (const dimension of ['2d', '3d', 'mixed']) {
      expect(select({ category: 'result', dimension, form: 'field', venue: 'acl', q: 'Figure 3 空间场 端电压' })).toEqual(['mk-' + dimension]);
    }
    expect(select({ form: 'mesh' })).toEqual([]);
    expect(select({ dimension: 'mixed', form: 'curve', q: 'Mixed Line plot' })).toEqual(['mk-mixed']);
  });
  it('counts what each research filter will show including category transitions and favorites', () => {
    const extra = { ...result('mk-cvpr-3d', ['3d']), venue: 'cvpr' };
    const studies = [...data, extra];
    const counts = studyFacetCounts(studies, { ...studyFilters, venue: 'acl', category: 'result', dimension: '3d', form: 'curve' }, false, new Set(), makeSearchIndex(studies));
    expect(counts.venue).toMatchObject({ acl: 1, cvpr: 1, aaai: 0 });
    expect(counts.dimension).toEqual({ '2d': 1, '3d': 1, mixed: 1 });
    expect(counts.form).toMatchObject({ curve: 1, field: 1, mesh: 0 });
    expect(counts.category).toEqual({ result: 1, mechanism: 1, algorithm: 0 });
    const fromMechanism = studyFacetCounts(studies, { ...studyFilters, category: 'mechanism', q: '端电压' }, true, new Set(['mk-mixed']), makeSearchIndex(studies));
    expect(fromMechanism.dimension).toEqual({ '2d': 0, '3d': 0, mixed: 1 });
    expect(fromMechanism.form.field).toBe(1);
  });
  it('roundtrips the study view, filter-only links, local main figures and the deep-linked figure', () => {
    const filtered = { ...location, filters: { ...studyFilters, category: 'result', dimension: 'mixed', form: 'field', q: '端电压' } };
    for (const state of [filtered, { ...filtered, id: 'mk-mixed' }, { ...initial, id: main.id }]) {
      expect(galleryShareUrl(state)).toMatch(/^mkfigure:\/\/gallery\//);
      expect(readGalleryLink(galleryShareUrl(state), data)).toEqual(state);
    }
    const stale = readGalleryLink('mkfigure://gallery/?view=study&category=algorithm&dimension=3d&form=mesh#f=mk-2d', data);
    expect(stale?.filters).toMatchObject({ view: 'study', category: 'all', dimension: 'all', form: 'all' });
    expect(readGalleryLink('mkfigure://gallery/?view=study&category=algorithm#f=mk-absent', data)).toMatchObject({ filters: { view: 'study', category: 'algorithm' }, id: null });
    for (const link of ['mkfigure://other/', 'mkfigure://gallery/extra', 'mkfigure://user@gallery/']) expect(readGalleryLink(link, data)).toBeNull();
  });
});

describe('journal catalog scope', () => {
  it('retains the original journals and restores links to TIE and TII', () => {
    const original = 'tpwrs tsg tste tpwrd tec tnnls tcyb tai apenergy ees renene nature natenergy natcommun natelectron natmachintell natcomputsci natsustain commseng'.split(' ');
    expect(Object.keys(journalVenues).sort()).toEqual([...original, 'tie', 'tii'].sort());
    for (const venue of ['tie', 'tii', 'tpwrs']) {
      const location = readGalleryLink('mkfigure://gallery/?view=journal&v=' + venue, []);
      expect(location?.filters).toMatchObject({view:'journal', venue});
    }
  });

  it('restores compatible filters when an old journal or figure has been withdrawn', () => {
    for (const venue of ['epsr', 'tac', 'unknown']) {
      const location = readGalleryLink('mkfigure://gallery/?view=journal&v=' + venue + '&category=algorithm&q=control#f=mk-j-withdrawn', []);
      expect(location).toMatchObject({filters:{view:'journal', venue:'all', category:'algorithm', q:'control'}, id:null});
    }
  });
});
