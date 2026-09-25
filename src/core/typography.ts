import type { TextElement } from '../shared/types';

export interface FontRun { text: string; font: string; italic: boolean; }
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u;
const variable = /[A-Za-z\u0370-\u03ff]/u;
const uprightFunction = /^(?:sin|cos|tan|tanh|sinh|cosh|exp|log|ln|lim|min|max|arg|det|diag|rank|tr|Re|Im|ODEsolve|ODESolve|softmax|ReLU)(?![A-Za-z])/;

/** Explicit font runs prevent OS-dependent fallback for mixed Chinese/Latin labels. */
export function fontRuns(element: TextElement): FontRun[] {
  const result: FontRun[] = []; let offset = 0;
  while (offset < element.text.length) {
    const remaining = element.text.slice(offset);
    const functionMatch = element.role === 'formula' && element.italic !== false ? remaining.match(uprightFunction) : null;
    const text = functionMatch?.[0] ?? String.fromCodePoint(element.text.codePointAt(offset)!);
    const chinese = cjk.test(text);
    const italic = chinese ? false : element.role === 'formula'
      ? (element.italic === false ? false : (!functionMatch && variable.test(text)))
      : (element.italic ?? false);
    const font = chinese ? 'Microsoft YaHei' : 'Times New Roman';
    const previous = result.at(-1);
    if (previous && previous.font === font && previous.italic === italic) previous.text += text;
    else result.push({ text, font, italic });
    offset += text.length;
  }
  return result;
}

export function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
