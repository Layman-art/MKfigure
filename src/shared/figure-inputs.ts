import type { Asset, FigureLayoutPlan, PaperCitation } from './types';

export const MAX_CONTENT_IMAGES = 4;
export const MAX_LAYOUT_REFERENCES = 3;

export function selectedContentImages(sources: Asset[], ids?: string[]): Asset[] {
  const images = sources.filter(source => source.kind === 'image');
  if (ids === undefined) return images.slice(0, MAX_CONTENT_IMAGES);
  const byId = new Map(images.map(image => [image.id, image]));
  return [...new Set(ids)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []).slice(0, MAX_CONTENT_IMAGES);
}

function validCitation(value: unknown): value is PaperCitation {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<PaperCitation>;
  return typeof c.id === 'string' && typeof c.title === 'string' && typeof c.paper === 'string' &&
    typeof c.venue === 'string' && Number.isInteger(c.year) && Array.isArray(c.authors) && c.authors.every(a => typeof a === 'string');
}

export function cleanLayoutPlan(value: unknown): FigureLayoutPlan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const plan = value as Partial<FigureLayoutPlan>;
  if (!['horizontal', 'vertical', 'parallel', 'grid'].includes(plan.arrangement || '') || !Array.isArray(plan.panels)) return undefined;
  const panels = plan.panels.filter((v): v is string => typeof v === 'string').slice(0, 6).map(v => v.slice(0, 100));
  if (!panels.length) return undefined;
  const ids = Array.isArray(plan.referenceIds) ? plan.referenceIds.filter((id): id is string =>
    typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,499}$/i.test(id)) : [];
  const referenceIds = [...new Set(ids)].slice(0, MAX_LAYOUT_REFERENCES);
  const citations = Array.isArray(plan.citations) ? plan.citations.filter(validCitation) : [];
  return { arrangement: plan.arrangement!, panels, notes: typeof plan.notes === 'string' ? plan.notes.slice(0, 2000) : '',
    referenceIds, citations: referenceIds.flatMap(id => citations.find(c => c.id === id) || []) };
}
