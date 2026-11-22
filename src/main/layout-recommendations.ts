import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { LayoutRecommendation, PaperFigure } from '../shared/types';

interface Concept { label: string; zh: string[]; terms: string[]; patterns?: string[]; genre?: boolean }
interface Corpus { version: number; ids: string[]; terms: Record<string, number[]> }
const unzip = promisify(gunzip);
const stop = new Set('a an and as at based be by can create design diagram draw figure for from how in into is it method model of on or our paper please proposed research show that the this to using we with'.split(' '));
const patterns: Record<string, string> = { architecture: '架构图', framework: '框架图', pipeline: '流程图', conceptual: '概念图', comparison: '对比图', results: '结果图', taxonomy: '分类图', teaser: '主视觉' };
const suggestions: Record<string, string> = { architecture: '可参考组件与连接的组织方式', framework: '可参考系统模块的分组方式', pipeline: '可参考阶段顺序的表达方式', conceptual: '可参考核心概念的解释方式', comparison: '可参考并列信息的对照方式', results: '可参考实验结果的分区方式', taxonomy: '可参考类别与层级的组织方式', teaser: '可参考首图重点与背景信息的取舍' };
const english = (s: string) => ' ' + (s.toLowerCase().match(/[a-z0-9]+/g) || []).join(' ') + ' ';
const contains = (haystack: string, term: string) => haystack.includes(' ' + term + ' ');

function queryConcepts(query: string, dictionary: Concept[], corpus: Corpus) {
  const text = english(query);
  const groups = dictionary.filter(c => c.zh.some(term => query.includes(term)) || c.terms.some(term => contains(text, term)));
  const known = new Set(groups.flatMap(c => c.terms.flatMap(term => term.split(' '))));
  const extra = [...new Set(text.trim().split(/ +/))].filter(t => t.length > 1 && !stop.has(t) && !known.has(t) && Object.hasOwn(corpus.terms, t));
  extra.sort((a, b) => corpus.terms[a].length - corpus.terms[b].length);
  return [...groups, ...extra.map(term => ({ label: term, zh: [], terms: [term] }))].slice(0, 32) as Concept[];
}

/** Search the bundled non-positional paper index. No network or model is involved. */
export class LayoutRecommender {
  private pending?: ReturnType<LayoutRecommender['read']>;
  constructor(private readonly resourceDir: string) {}

  private async read() {
    const [compressed, config] = await Promise.all([
      fs.readFile(path.join(this.resourceDir, 'paper-terms.json.gz')),
      fs.readFile(path.join(this.resourceDir, 'concepts.json'), 'utf8'),
    ]);
    const corpus: Corpus = JSON.parse((await unzip(compressed)).toString('utf8'));
    if (corpus.version !== 1 || !Array.isArray(corpus.ids) || !corpus.terms) throw new Error('本地版式索引损坏，请重新安装或重建索引。');
    const dictionary: Concept[] = JSON.parse(config);
    const rows = new Map(corpus.ids.map((id, i) => [id, i]));
    return { corpus, dictionary, rows };
  }

  async recommend(figures: PaperFigure[], input: string): Promise<LayoutRecommendation[]> {
    const query = input.trim().slice(0, 4000);
    if (!query || !figures.length) return [];
    const { corpus, dictionary, rows } = await (this.pending ??= this.read().catch(error => { this.pending = undefined; throw error; }));
    const groups = queryConcepts(query, dictionary, corpus).map(group => {
      const occurrences = new Map<number, string>();
      for (const term of group.terms) {
        for (const row of corpus.terms[term] || []) if (!occurrences.has(row)) occurrences.set(row, term);
      }
      const weight = Math.min(5, 1 + Math.log((1 + corpus.ids.length) / (1 + occurrences.size)));
      return { ...group, occurrences, weight };
    });
    if (!groups.length) return [];
    const matches = [];
    for (const figure of figures) {
      const row = rows.get(figure.id);
      if (row === undefined) continue;
      const title = english(figure.title);
      const titleHits: string[] = [], indexHits: string[] = [];
      let raw = 0, hits = 0, genreEvidence = false, compatiblePattern = false;
      for (const group of groups) {
        const inTitle = group.terms.find(t => contains(title, t));
        const inIndex = group.occurrences.get(row);
        const pattern = group.patterns?.includes(figure.pattern);
        compatiblePattern ||= !!pattern;
        if (inTitle || inIndex) {
          const found = (inTitle || inIndex)!;
          (inTitle ? titleHits : indexHits).push(found);
          raw += group.weight * (inTitle ? 1.65 : 1) * (found.includes(' ') ? 1.15 : 1);
          hits++;
        } else if (group.genre && pattern) { raw += 1; genreEvidence = true; }
      }
      if (!hits && !genreEvidence) continue;
      const reason: string[] = [];
      if (titleHits.length) reason.push('标题含 ' + titleHits.slice(0, 4).join('、'));
      if (indexHits.length) reason.push('题名与摘要索引命中 ' + indexHits.slice(0, 4).join('、'));
      if (patterns[figure.pattern]) reason.push('图库标注为' + patterns[figure.pattern] + '，' + suggestions[figure.pattern]);
      const score = raw * (0.5 + hits / groups.length) + (compatiblePattern ? 0.65 : 0);
      matches.push({ figure, reason: reason.join('。'), score });
    }
    return matches.sort((a, b) => b.score - a.score || a.figure.id.localeCompare(b.figure.id)).slice(0, 6)
      .map(({ figure, reason }) => ({ figure, reason }));
  }
}
