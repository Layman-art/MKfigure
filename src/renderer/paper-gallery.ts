import type { PaperFigure } from '../shared/types';

export const gallerySource = 'https://qwdwqfwq.github.io/topconf-paper-figure-gallery/';
export const galleryPageSize = 60;
export const venueNames: Record<string, string> = {
  iclr: 'ICLR', icml: 'ICML', neurips: 'NeurIPS', cvpr: 'CVPR', acl: 'ACL', aaai: 'AAAI',
};
export const patternNames: Record<string, [string, string]> = {
  teaser: ['主视觉', 'Teaser'], conceptual: ['概念图', 'Conceptual'], framework: ['框架总览', 'Framework'],
  pipeline: ['流程图', 'Pipeline'], architecture: ['架构图', 'Architecture'], taxonomy: ['全景 / 基准', 'Taxonomy / Benchmark'],
  results: ['结果', 'Results'], comparison: ['对比', 'Comparison'],
};
export const tierNames: Record<string, [string, string]> = {
  best: ['最佳论文 / 提名', 'Best / Honorable'], oral: ['口头报告', 'Oral'], spotlight: ['焦点论文', 'Spotlight'],
};
export type GalleryFilters = {
  venue: string; year: string; tier: string; pattern: string; q: string; sort: 'venue' | 'year' | 'title';
};
export const initialFilters: GalleryFilters = { venue: 'all', year: 'all', tier: 'all', pattern: 'all', q: '', sort: 'venue' };
export type GalleryLocation = { filters: GalleryFilters; id: string | null; favoritesOnly: boolean; extraSearch?: string };
const venueRank = new Map(Object.keys(venueNames).map((venue, index) => [venue, index]));
export function figureTier(figure: PaperFigure) {
  return figure.award ? 'best' : figure.tier || '';
}
export function figureImage(id: string) { return 'mk-gallery://figure/' + encodeURIComponent(id); }

function searchable(figure: PaperFigure) {
  const pattern = patternNames[figure.pattern], tier = tierNames[figure.tier || ''];
  return [figure.title, ...figure.authors, figure.venue, figure.year, figure.pattern, pattern?.[1],
    pattern?.[0], figure.tier, tier?.[0], tier?.[1],
    figure.award ? 'best paper award outstanding 最佳论文' : ''].join(' ').toLowerCase();
}
export function makeSearchIndex(figures: PaperFigure[]) {
  return new Map(figures.map(figure => [figure.id, searchable(figure)]));
}
export function queryFigures(figures: PaperFigure[], location: GalleryLocation, favorites: ReadonlySet<string>, index: ReadonlyMap<string, string>) {
  const { filters: f, favoritesOnly } = location;
  const terms = f.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const rows = figures.filter(figure => (
    (!favoritesOnly || favorites.has(figure.id)) && (f.venue === 'all' || f.venue === figure.venue)
    && (f.year === 'all' || f.year === String(figure.year)) && (f.pattern === 'all' || f.pattern === figure.pattern)
    && (f.tier === 'all' || f.tier === figureTier(figure))
    && terms.every(term => index.get(figure.id)?.includes(term))
  ));
  return rows.sort((a, b) => {
    if (f.sort === 'title') return a.title.localeCompare(b.title);
    const venue = (venueRank.get(a.venue) ?? venueRank.size) - (venueRank.get(b.venue) ?? venueRank.size);
    const year = Number(a.year) - Number(b.year);
    return (f.sort === 'year' ? year || venue : venue || year) || a.id.localeCompare(b.id);
  });
}

export function galleryShareUrl({ filters: f, id, extraSearch }: GalleryLocation) {
  const url = new URL(gallerySource);
  url.search = extraSearch || '';
  const fields = { v: f.venue, y: f.year, t: f.tier, p: f.pattern, q: f.q.trim(), s: f.sort };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'q' ? value : key === 's' ? value !== 'venue' : value !== 'all') url.searchParams.set(key, value);
  }
  if (id) url.hash = 'f=' + encodeURIComponent(id);
  return url.href;
}

// Resolve a shared figure against its snapshot. Keep all compatible filters even
// if another criterion in the link has become stale.
export function readGalleryLink(raw: string, figures: PaperFigure[]): GalleryLocation | null {
  const text = raw.trim();
  if (!text || !/^(?:[?#]|https:\/\/)/i.test(text)) return null;
  let url: URL;
  try { url = new URL(text, gallerySource); } catch { return null; }
  const base = new URL(gallerySource);
  if (url.origin !== base.origin || url.username || url.password || ![base.pathname, base.pathname.slice(0, -1), base.pathname + 'index.html'].includes(url.pathname)) return null;
  const f = { ...initialFilters }, p = url.searchParams;
  const venue = p.get('v') || '', year = p.get('y') || '', tier = p.get('t') || '', pattern = p.get('p') || '', sort = p.get('s');
  if (Object.hasOwn(venueNames, venue)) f.venue = venue;
  if (figures.some(row => String(row.year) === year)) f.year = year;
  if (Object.hasOwn(tierNames, tier)) f.tier = tier;
  if (Object.hasOwn(patternNames, pattern)) f.pattern = pattern;
  if (sort === 'year' || sort === 'title') f.sort = sort;
  f.q = p.get('q')?.trim() || '';
  const unknown = new URLSearchParams(p);
  for (const key of ['v', 'y', 't', 'p', 'q', 's']) unknown.delete(key);
  const passthrough = unknown.size ? { extraSearch: unknown.toString() } : {};
  let id: string | null = null;
  if (url.hash) {
    if (!url.hash.startsWith('#f=')) return null;
    try { id = decodeURIComponent(url.hash.slice(3)); } catch { return null; }
    const target = figures.find(row => row.id === id);
    if (!target) return { filters: f, favoritesOnly: false, id: null, ...passthrough };
    if (f.venue !== target.venue) f.venue = 'all';
    if (f.year !== String(target.year)) f.year = 'all';
    if (f.tier !== figureTier(target)) f.tier = 'all';
    if (f.pattern !== target.pattern) f.pattern = 'all';
    const hay = searchable(target);
    if (!f.q.toLowerCase().split(/\s+/).every(term => hay.includes(term))) f.q = '';
  }
  return { filters: f, favoritesOnly: false, id, ...passthrough };
}
