import type { PaperFigure } from '../shared/types';

import { LOCAL_GALLERY, dimensionNames, formNames, journalVenues, researchTopics, studyCategories, studyDimension } from '../shared/gallery-taxonomy';

export const gallerySource = 'https://qwdwqfwq.github.io/topconf-paper-figure-gallery/';
export const galleryPageSize = 60;
export const venueNames: Record<string, string> = {
  iclr: 'ICLR', icml: 'ICML', neurips: 'NeurIPS', cvpr: 'CVPR', acl: 'ACL', aaai: 'AAAI',
  ...Object.fromEntries(Object.entries(journalVenues).map(([key, [name]]) => [key, name])),
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
  view: 'main' | 'study' | 'journal'; category: string; dimension: string; form: string;
  venue: string; year: string; tier: string; pattern: string; q: string; sort: 'venue' | 'year' | 'recent' | 'title' | 'explore';
};
export const initialFilters: GalleryFilters = { view: 'main', category: 'all', dimension: 'all', form: 'all', venue: 'all', year: 'all', tier: 'all', pattern: 'all', q: '', sort: 'venue' };
export type GalleryLocation = { filters: GalleryFilters; id: string | null; favoritesOnly: boolean; extraSearch?: string };
const venueRank = new Map(Object.keys(venueNames).map((venue, index) => [venue, index]));
export function figureTier(figure: PaperFigure) {
  return figure.award ? 'best' : figure.tier || '';
}
export function figureImage(id: string, thumbnail = false) { return 'mk-gallery://' + (thumbnail ? 'thumbnail/' : 'figure/') + encodeURIComponent(id); }

export function isStudy(row: PaperFigure) {
  return !!row.supplement && row.supplement.category !== 'main';
}
export function galleryView(row: PaperFigure): GalleryFilters['view'] {
  return row.supplement?.collection === 'journal' ? 'journal' : isStudy(row) ? 'study' : 'main';
}
function matchesYear(year: number, filter: string) {
  return filter === 'all' || (filter === 'last5' ? year >= new Date().getFullYear() - 4 : String(year) === filter);
}
function searchable(figure: PaperFigure) {
  const pattern = patternNames[figure.pattern], tier = tierNames[figure.tier || ''];
  const supplement = figure.supplement, dimension = studyDimension(figure);
  const studyTerms = supplement && supplement.category !== 'main' ? [
    supplement.category, ...studyCategories[supplement.category], dimension,
    ...(dimension ? dimensionNames[dimension] : []),
    ...(supplement.forms || []).flatMap(form => [form, ...formNames[form]]),
    ...(supplement.topics || []).flatMap(topic => researchTopics[topic] || [topic]),
  ] : [];
  return [figure.figure, supplement?.description, ...studyTerms, figure.title, ...figure.authors, figure.venue, figure.doi,
    ...(journalVenues[figure.venue] || []), figure.year, figure.pattern, pattern?.[1],
    pattern?.[0], figure.tier, tier?.[0], tier?.[1],
    figure.award ? 'best paper award outstanding 最佳论文' : ''].join(' ').toLowerCase();
}
export function makeSearchIndex(figures: PaperFigure[]) {
  return new Map(figures.map(figure => [figure.id, searchable(figure)]));
}
function matchingFigures(figures: PaperFigure[], location: GalleryLocation, favorites: ReadonlySet<string>, index: ReadonlyMap<string, string>) {
  const { filters: f, favoritesOnly } = location;
  const terms = f.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return figures.filter(figure => (
    galleryView(figure) === f.view
    && (f.view === 'main' || ((f.category === 'all' || f.category === figure.supplement?.category)
      && (f.dimension === 'all' || (figure.supplement?.category === 'result' && studyDimension(figure) === f.dimension))
      && (f.form === 'all' || (figure.supplement?.category === 'result' && figure.supplement.forms?.some(form => form === f.form)))))
    && (!favoritesOnly || favorites.has(figure.id)) && (f.venue === 'all' || f.venue === figure.venue)
    && matchesYear(figure.year, f.year) && (f.pattern === 'all' || f.pattern === figure.pattern)
    && (f.tier === 'all' || f.tier === figureTier(figure))
    && terms.every(term => index.get(figure.id)?.includes(term))
  ));
}
export function changeGalleryFilter<K extends keyof GalleryFilters>(filters: GalleryFilters, key: K, value: GalleryFilters[K]): GalleryFilters {
  const next = { ...filters, [key]: value };
  if (key === 'category' && value !== 'result') next.dimension = next.form = 'all';
  if ((key === 'form' || key === 'dimension') && value !== 'all') next.category = 'result';
  return next;
}

export function studyFacetCounts(studies: PaperFigure[], filters: GalleryFilters, favoritesOnly: boolean, favorites: ReadonlySet<string>, index: ReadonlyMap<string, string>) {
  const counts: Record<string, Record<string, number>> = Object.fromEntries(Object.entries({
    venue: venueNames, category: studyCategories, dimension: dimensionNames, form: formNames, tier: tierNames,
  }).map(([axis, options]) => [axis, Object.fromEntries(Object.keys(options).map(k => [k, 0]))]));
  const f = filters;
  const terms = f.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  for (const row of studies) {
    if (galleryView(row) !== f.view || !matchesYear(row.year, f.year) || (favoritesOnly && !favorites.has(row.id)) ||
        (f.pattern !== 'all' && f.pattern !== row.pattern) || !terms.every(t => index.get(row.id)?.includes(t))) continue;
    const category = row.supplement?.category;
    if (!category || category === 'main') continue;
    const tier = figureTier(row), dimension = studyDimension(row), forms = row.supplement?.forms || [];
    const venueOK = f.venue === 'all' || f.venue === row.venue;
    const tierOK = f.tier === 'all' || f.tier === tier;
    const categoryOK = f.category === 'all' || f.category === category;
    const dimensionOK = f.dimension === 'all' || dimension === f.dimension;
    const formOK = f.form === 'all' || forms.some(form => form === f.form);
    if (categoryOK && dimensionOK && formOK) {
      if (tierOK) counts.venue[row.venue]++;
      if (venueOK && tier) counts.tier[tier]++;
    }
    if (!venueOK || !tierOK) continue;
    if (category !== 'result' || (dimensionOK && formOK)) counts.category[category]++;
    if (category === 'result') {
      if (dimension && formOK) counts.dimension[dimension]++;
      if (dimensionOK) for (const form of forms) counts.form[form]++;
    }
  }
  return counts;
}

export function queryFigures(figures: PaperFigure[], location: GalleryLocation, favorites: ReadonlySet<string>, index: ReadonlyMap<string, string>) {
  const f = location.filters;
  const matches = matchingFigures(figures, location, favorites, index);
  if (f.view === 'journal' && f.sort === 'explore') {
    const recent = matches.sort((a,b) => b.year-a.year || a.id.localeCompare(b.id));
    const seen = new Set<string>();
    const first = recent.filter(row => {
      const key = row.venue + '/' + row.supplement!.category;
      if (!row.supplement!.archive || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const selected = new Set(first.map(row => row.id));
    return first.concat(recent.filter(row => !selected.has(row.id)));
  }
  return matches.sort((a, b) => {
    if (f.sort === 'title') return a.title.localeCompare(b.title);
    const venue = (venueRank.get(a.venue) ?? venueRank.size) - (venueRank.get(b.venue) ?? venueRank.size);
    const year = Number(a.year) - Number(b.year);
    return (f.sort === 'recent' ? -year || venue : f.sort === 'year' ? year || venue : venue || (f.view === 'journal' ? -year : year)) || a.id.localeCompare(b.id);
  });
}

export function galleryShareUrl({ filters: f, id, extraSearch }: GalleryLocation) {
  const url = new URL(f.view !== 'main' || id?.startsWith('mk-') || f.sort === 'recent' ? LOCAL_GALLERY : gallerySource);
  url.search = extraSearch || '';
  const fields = { v: f.venue, y: f.year, t: f.tier, p: f.pattern, q: f.q.trim(), s: f.sort };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'q' ? value : key === 's' ? value !== 'venue' : value !== 'all') url.searchParams.set(key, value);
  }
  if (f.view !== 'main') {
    url.searchParams.set('view', f.view);
    for (const key of ['category', 'dimension', 'form'] as const) {
      if (f[key] !== 'all') url.searchParams.set(key, f[key]);
    }
  }
  if (id) url.hash = 'f=' + encodeURIComponent(id);
  return url.href;
}

// Resolve a shared figure against its snapshot. Keep all compatible filters even
// if another criterion in the link has become stale.
export function readGalleryLink(raw: string, figures: PaperFigure[]): GalleryLocation | null {
  const text = raw.trim();
  if (!text || !/^(?:[?#]|(?:https|mkfigure):\/\/)/i.test(text)) return null;
  let url: URL;
  try { url = new URL(text, gallerySource); } catch { return null; }
  const base = new URL(gallerySource);
  const offline = url.protocol === 'mkfigure:' && url.host === 'gallery' && url.pathname === '/';
  if (url.username || url.password || (!offline && (url.origin !== base.origin || ![base.pathname, base.pathname.slice(0, -1), base.pathname + 'index.html'].includes(url.pathname)))) return null;
  const f = { ...initialFilters }, p = url.searchParams;
  if (offline && (p.get('view') === 'study' || p.get('view') === 'journal')) {
    f.view = p.get('view') === 'journal' ? 'journal' : 'study';
    for (const [key, labels] of [['category', studyCategories], ['dimension', dimensionNames], ['form', formNames]] as const) {
      const value = p.get(key);
      if (value && Object.hasOwn(labels, value)) f[key] = value;
    }
    if (f.category !== 'all' && f.category !== 'result') f.dimension = f.form = 'all';
  }
  const venue = p.get('v') || '', year = p.get('y') || '', tier = p.get('t') || '', pattern = p.get('p') || '', sort = p.get('s');
  if (Object.hasOwn(venueNames, venue)) f.venue = venue;
  if ((f.view === 'journal' && year === 'last5') || figures.some(row => String(row.year) === year)) f.year = year;
  if (Object.hasOwn(tierNames, tier)) f.tier = tier;
  if (Object.hasOwn(patternNames, pattern)) f.pattern = pattern;
  if (sort === 'year' || sort === 'title' || (offline && sort === 'recent') || (f.view === 'journal' && sort === 'explore')) f.sort = sort;
  f.q = p.get('q')?.trim() || '';
  const unknown = new URLSearchParams(p);
  for (const key of ['v', 'y', 't', 'p', 'q', 's']) unknown.delete(key);
  if (offline) for (const key of ['view', 'category', 'dimension', 'form']) unknown.delete(key);
  const passthrough = unknown.size ? { extraSearch: unknown.toString() } : {};
  let id: string | null = null;
  if (url.hash) {
    if (!url.hash.startsWith('#f=')) return null;
    try { id = decodeURIComponent(url.hash.slice(3)); } catch { return null; }
    const target = figures.find(row => row.id === id);
    if (!target) return { filters: f, favoritesOnly: false, id: null, ...passthrough };
    f.view = galleryView(target);
    if (f.category !== target.supplement?.category) f.category = 'all';
    if (target.supplement?.category !== 'result' || f.dimension !== studyDimension(target)) f.dimension = 'all';
    if (target.supplement?.category !== 'result' || !target.supplement.forms?.some(form => form === f.form)) f.form = 'all';
    if (f.venue !== target.venue) f.venue = 'all';
    if (!matchesYear(target.year, f.year)) f.year = 'all';
    if (f.tier !== figureTier(target)) f.tier = 'all';
    if (f.pattern !== target.pattern) f.pattern = 'all';
    const hay = searchable(target);
    if (!f.q.toLowerCase().split(/\s+/).every(term => hay.includes(term))) f.q = '';
  }
  return { filters: f, favoritesOnly: false, id, ...passthrough };
}

/** Lay out cards in catalogue order. Appending a batch resumes at the previous column heights. */
export function observeGalleryMasonry(grid: HTMLElement) {
  let cards: HTMLElement[] = [];
  let index = new WeakMap<HTMLElement, number>();
  let heights = new WeakMap<HTMLElement, number>();
  let bottoms: number[][] = [];
  let width = 0;
  let columns = 0;
  let gap = 0;

  function place(first: number) {
    const nextWidth = grid.getBoundingClientRect().width;
    if (!nextWidth) return;
    const css = getComputedStyle(grid);
    const nextColumns = Number(css.getPropertyValue('--pg-columns')) || 1;
    const nextGap = parseFloat(css.getPropertyValue('--pg-gap')) || 0;
    if (width !== nextWidth || columns !== nextColumns || gap !== nextGap) {
      width = nextWidth;
      columns = nextColumns;
      gap = nextGap;
      heights = new WeakMap();
      bottoms = [Array(columns).fill(0)];
      first = 0;
    }
    const sizes = cards.slice(first).map(card => {
      const measured = heights.get(card) ?? card.getBoundingClientRect().height;
      heights.set(card, measured);
      return measured;
    });
    const stride = (width + gap) / columns;
    let levels = bottoms[first].slice();
    bottoms.length = first + 1;
    sizes.forEach((height, offset) => {
      const col = levels.indexOf(Math.min(...levels));
      const card = cards[first + offset];
      const position = 'translate(' + col * stride + 'px, ' + levels[col] + 'px)';
      if (card.style.transform !== position) card.style.transform = position;
      levels[col] += height + gap;
      bottoms.push(levels.slice());
    });
    grid.style.height = Math.max(0, Math.max(...levels) - gap) + 'px';
  }

  const resize = new ResizeObserver(entries => {
    let first = cards.length;
    let resizedGrid = false;
    for (const entry of entries) {
      if (entry.target === grid) { resizedGrid = true; continue; }
      const card = entry.target as HTMLElement;
      const at = index.get(card);
      const height = entry.borderBoxSize[0]?.blockSize;
      if (at !== undefined && height !== undefined && heights.get(card) !== height) {
        heights.set(card, height);
        first = Math.min(first, at);
      }
    }
    if (first < cards.length || (resizedGrid && grid.getBoundingClientRect().width !== width)) place(first);
  });
  function sync() {
    const next = Array.from(grid.children) as HTMLElement[];
    let first = 0;
    while (first < cards.length && first < next.length && cards[first] === next[first]) first++;
    for (let i = first; i < cards.length; i++) { resize.unobserve(cards[i]); index.delete(cards[i]); }
    for (let i = first; i < next.length; i++) { resize.observe(next[i], { box: 'border-box' }); index.set(next[i], i); }
    cards = next;
    place(first);
  }
  resize.observe(grid);
  const changes = new MutationObserver(sync);
  changes.observe(grid, { childList: true });
  sync();
  return () => { changes.disconnect(); resize.disconnect(); };
}
