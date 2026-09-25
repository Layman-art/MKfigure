import type { FigureElement, FigureScene, TextElement } from '../../src/shared/types';

const navy = '#18334B'; const teal = '#238B8E'; const blue = '#477EB5'; const orange = '#C77D44'; const gray = '#617284';
const elements: FigureElement[] = [];
const label = (id: string, text: string, x: number, y: number, w: number, size = 21, extra: Partial<TextElement> = {}) => elements.push({ id, type: 'text', text, x, y, w, h: size * 1.25, fontSize: size, color: navy, ...extra });
const rect = (id: string, x: number, y: number, w: number, h: number, fill: string, stroke = 'none', radius = 0) => elements.push({ id, type: 'rect', x, y, w, h, fill, stroke, strokeWidth: 1.5, radius });
const line = (id: string, x: number, y: number, x2: number, y2: number, color = gray, arrow = false, dash = false, groupId?: string) => elements.push({ id, type: 'line', x, y, x2, y2, w: Math.abs(x2 - x), h: Math.abs(y2 - y), stroke: color, strokeWidth: 2, arrowEnd: arrow, dash, groupId });
const circle = (id: string, x: number, y: number, r: number, fill: string, stroke = fill, groupId?: string) => elements.push({ id, type: 'ellipse', x: x - r, y: y - r, w: r * 2, h: r * 2, fill, stroke, strokeWidth: 1.5, groupId });

label('title', 'Neural ordinary differential equations', 38, 23, 1124, 34, { bold: true });
label('subtitle', 'Continuous state evolution with a learnable vector field', 38, 70, 1124, 21, { color: gray });
line('header-rule', 38, 111, 1162, 111, '#D8E2E9');
line('divide-a-b', 418, 133, 418, 565, '#DFE6EC');
line('divide-b-c', 806, 133, 806, 565, '#DFE6EC');
label('a-title', 'a   Continuous depth', 38, 135, 356, 25, { bold: true });
label('b-title', 'b   Forward integration', 440, 135, 342, 25, { bold: true });
label('c-title', 'c   Adjoint training', 829, 135, 340, 25, { bold: true });

label('discrete-label', 'Residual steps', 49, 191, 170, 20, { color: gray });
for (let i = 0; i < 4; i++) {
  const x = 53 + i * 88;
  if (i < 3) line(`res-connection-${i}`, x + 51, 248, x + 83, 248, blue, true);
  rect(`res-box-${i}`, x, 224, 50, 48, '#EDF3F9', '#B0C5D9', 6);
  label(`res-state-${i}`, 'z', x + 13, 235, 17, 21, { italic: true, groupId: `res-label-${i}` });
  label(`res-index-${i}`, String(i), x + 24, 247, 12, 13, { groupId: `res-label-${i}` });
}
label('continuous-label', 'Continuous trajectory', 49, 321, 335, 20, { color: gray });
line('axis-y', 64, 486, 64, 366, gray, true);
line('axis-t', 64, 486, 380, 486, gray, true);
elements.push({ id: 'trajectory', type: 'path', x: 76, y: 363, w: 285, h: 111, d: 'M 0 105 C 54 111 72 57 107 65 C 139 74 144 26 185 24 C 222 24 241 12 285 0', fill: 'none', stroke: teal, strokeWidth: 3.5 });
circle('trajectory-start', 76, 468, 5, teal);
circle('trajectory-end', 361, 363, 5, teal);
label('trajectory-z', 'z(t)', 75, 352, 68, 21, { italic: true });
label('trajectory-t', 't', 373, 490, 23, 20, { italic: true });
label('continuous-note', 'The network defines a rate of change.', 46, 518, 360, 19, { color: gray });

// The network itself remains an editable collection of lines and circles.
const layers = [[228, 272], [206, 250, 294], [228, 272]]; const layerX = [474, 545, 616];
for (let l = 0; l < 2; l++) for (const [i, y] of layers[l].entries()) for (const [j, nextY] of layers[l + 1].entries()) line(`nn-edge-${l}-${i}-${j}`, layerX[l], y, layerX[l + 1], nextY, '#B5CFD0', false, false, 'vector-field');
layers.forEach((ys, l) => ys.forEach((y, j) => circle(`nn-node-${l}-${j}`, layerX[l], y, 9, l === 1 ? '#D7ECEA' : '#E8F1F6', teal, 'vector-field')));
label('network-caption', 'Learnable vector field', 445, 311, 211, 19, { color: teal, align: 'center' });
line('field-to-solver', 647, 251, 678, 251, teal, true);
rect('solver', 688, 206, 88, 90, '#E9F4F1', '#A6CEBE', 6);
label('solver-label', 'ODE\nsolver', 695, 225, 74, 20, { h: 55, align: 'center', color: '#2F6F59' });

// Formula is a real group of text boxes and a fraction bar, with editable subscripts.
label('eq-d', 'd', 471, 371, 14, 26, { groupId: 'dynamics', role: 'formula', italic: false });
label('eq-z', 'z(t)', 485, 371, 54, 26, { groupId: 'dynamics', role: 'formula' });
line('eq-fraction', 469, 404, 541, 404, navy, false, false, 'dynamics');
label('eq-d-denom', 'd', 490, 408, 14, 26, { groupId: 'dynamics', role: 'formula', italic: false });
label('eq-t-denom', 't', 505, 408, 21, 26, { groupId: 'dynamics', role: 'formula' });
label('eq-equals', '=', 554, 392, 27, 26, { groupId: 'dynamics', role: 'formula', italic: false });
label('eq-f', 'f', 589, 391, 16, 28, { groupId: 'dynamics', role: 'formula' });
label('eq-theta', 'θ', 601, 409, 17, 17, { groupId: 'dynamics', role: 'formula' });
label('eq-input', '(z(t), t)', 620, 393, 135, 26, { groupId: 'dynamics', role: 'formula' });
rect('initial-state', 452, 463, 90, 40, '#F0F4F8', '#CBD8E2', 5);
label('initial-z', 'z(t', 472, 471, 29, 21, { italic: true, groupId: 'initial-label' });
label('initial-index', '0', 497, 483, 10, 13, { groupId: 'initial-label' });
label('initial-close', ')', 505, 471, 11, 21, { groupId: 'initial-label' });
line('integration-arrow', 550, 483, 673, 483, teal, true);
label('integrate', 'integrate', 561, 453, 100, 18, { color: teal, align: 'center' });
rect('final-state', 683, 463, 90, 40, '#F0F4F8', '#CBD8E2', 5);
label('final-z', 'z(t', 703, 471, 29, 21, { italic: true, groupId: 'final-label' });
label('final-index', '1', 728, 483, 10, 13, { groupId: 'final-label' });
label('final-close', ')', 736, 471, 11, 21, { groupId: 'final-label' });
label('forward-note', 'The solver evaluates f as needed.', 450, 526, 330, 19, { color: gray });

rect('loss-box', 1018, 217, 118, 58, '#FBF0E8', '#DFC5AF', 6);
label('loss-label', 'Loss L', 1026, 234, 102, 23, { align: 'center', color: '#9B5F2F' });
rect('output-box', 839, 217, 115, 58, '#EDF3F9', '#B0C5D9', 6);
label('output-label', 'z(t', 869, 234, 32, 23, { italic: true, groupId: 'output-label' });
label('output-index', '1', 896, 247, 11, 14, { groupId: 'output-label' });
label('output-close', ')', 905, 234, 12, 23, { groupId: 'output-label' });
line('state-to-loss', 960, 246, 1006, 246, gray, true);
line('reverse-arrow', 1119, 314, 855, 314, orange, true);
label('backward-label', 'Integrate sensitivities backward', 842, 333, 312, 19, { align: 'center', color: orange });
label('adj-a', 'a(t)', 854, 403, 52, 25, { role: 'formula', groupId: 'adjoint' });
label('adj-equals', '=', 916, 403, 22, 25, { role: 'formula', groupId: 'adjoint', italic: false });
label('adj-num', '∂L', 1007, 382, 57, 25, { role: 'formula', groupId: 'adjoint' });
line('adj-bar', 959, 415, 1124, 415, navy, false, false, 'adjoint');
label('adj-denom', '∂z(t)', 1000, 419, 88, 25, { role: 'formula', groupId: 'adjoint' });
label('gradient-label', 'Parameter gradients', 850, 479, 291, 21, { align: 'center', color: orange });
label('adjoint-note', 'Update θ using the loss gradient.', 839, 526, 326, 19, { color: gray });
line('footer-rule', 38, 576, 1162, 576, '#D8E2E9');
label('footnote', 'Conceptual illustration. Trajectories are schematic, not measured results.', 38, 596, 1124, 18, { color: gray });

export const EXAMPLE_SCENE: FigureScene = {
  version: 1, width: 1200, height: 640, background: '#FFFFFF', title: 'Neural ordinary differential equations', elements,
  sourceNotes: ['Offline editable example bundled with MK Figure Studio.', 'Conceptual explanation of a Neural ODE: dz/dt = fθ(z,t); forward integration produces the terminal state; adjoint sensitivities support gradient computation. No empirical data are shown.'],
};
