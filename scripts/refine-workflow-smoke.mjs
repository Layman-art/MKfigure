// Explicit opt-in: one real refinement + review and a cancelled analysis request.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

if (process.env.MK_LIVE_E2E !== '1') throw new Error('Set MK_LIVE_E2E=1 for this authorized live verification');
const root = process.cwd(), out = path.join(root, 'output', 'quality-finish');
await fs.mkdir(out, { recursive: true });
const env = { ...process.env, MK_FIGURE_DATA_DIR: path.join(root, '.runtime', 'live-workflow') };
delete env.ELECTRON_RUN_AS_NODE;
const client = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60000 });
const projectId = '9eaf5d5d-2cad-41d5-bd9f-90f024d874f0';
const result = { startedAt: new Date().toISOString(), projectId, model: 'gpt-5.5', effort: 'low', generatedImageAgain: false, pageErrors: [], viewports: [] };
let page;
async function snapshot(name, width, height) {
  await client.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await page.waitForTimeout(250);
  const measured = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth }));
  await page.screenshot({ path: path.join(out, `${name}-${width}x${height}.png`) });
  result.viewports.push({ name, requested: { width, height }, measured, horizontalOverflow: measured.documentWidth > measured.width });
}
try {
  page = await client.firstWindow();
  page.on('pageerror', e => result.pageErrors.push(e.message));
  await page.getByRole('button', { name:/^新建科研图/ }).waitFor({ timeout: 60000 });
  await page.evaluate(() => window.mkFigure.onProgress(e => console.log('QUALITY_PROGRESS ' + e.action + ': ' + e.message)));
  page.on('console', m => { if (m.text().startsWith('QUALITY_PROGRESS')) console.log(m.text()); });
  const status = await page.evaluate(() => window.mkFigure.providerStatus('codex'));
  assert.ok(status.available && status.authenticated);
  await page.evaluate(async () => {
    const boot = await window.mkFigure.bootstrap();
    boot.settings.activeProvider = 'codex';
    boot.settings.providers.find(p => p.id === 'codex').model = 'gpt-5.5';
    boot.settings.reasoningEffort = 'low';
    await window.mkFigure.saveSettings(boot.settings);
  });
  const before = await page.evaluate(id => window.mkFigure.openProject(id), projectId);
  assert.ok(before.target && before.scene && before.qa);
  await fs.writeFile(path.join(out, 'before.scene.json'), JSON.stringify(before.scene, null, 2));
  await fs.writeFile(path.join(out, 'before.qa.json'), JSON.stringify(before.qa, null, 2));
  if (before.previewPng) await fs.writeFile(path.join(out, 'before.png'), Buffer.from(before.previewPng.split(',')[1], 'base64'));
  result.before = { elements: before.scene.elements.length, qa: before.qa };
  await page.getByRole('button', { name: /Live Neural ODE test/ }).first().click();
  await page.getByRole('button', { name: /检查与精修/ }).click();
  await snapshot('review-before', 1100, 800);
  await snapshot('review-before', 1440, 960);

  // UI cancellation: dispatch a real model request, then stop it after the UI enters its busy state.
  const cancellationProject = await page.evaluate(async () => {
    const p = await window.mkFigure.createProject('QA cancellation test', 'full');
    p.brief.topic = 'Neural ODE conceptual workflow';
    p.brief.focus = 'Describe a detailed source-grounded schematic prompt with initial state, ODE solver, final state, and learned derivative; no invented results.';
    return window.mkFigure.saveProject(p);
  });
  await page.reload();
  await page.getByRole('button', { name: /QA cancellation test/ }).first().click();
  await page.getByRole('button', { name: 'AI 整理内容', exact: true }).click();
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(2000);
  const cancelStarted = Date.now();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已停止本次操作' }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '停止', exact: true }).waitFor({ state: 'detached', timeout: 15000 });
  const afterCancel = await page.evaluate(id => window.mkFigure.openProject(id), cancellationProject.id);
  assert.equal(afterCancel.brief.prompt, '');
  assert.equal(afterCancel.brief.notes, '');
  assert.equal(afterCancel.stage, 'brief');
  assert.ok(!afterCancel.history.some(h => h.action === 'prompt' || h.action === 'analyze'));
  result.cancellation = { passed: true, projectId: cancellationProject.id, action: 'prompt', cancellationLatencyMs: Date.now() - cancelStarted, stage: afterCancel.stage, successHistoryAdded: false, outputWritten: false };
  await snapshot('cancelled-operation', 1100, 800);
  console.log('Cancellation verified without committed output');

  await page.reload();
  await page.getByRole('button', { name: /Live Neural ODE test/ }).first().click();
  await page.getByRole('button', { name: /检查与精修/ }).click();
  const feedback = 'Fix the identified formula spacing/alignment problems in the current reconstruction while preserving its existing module layout and all correct objects. In every x(t_0), x(t_1) label, place 0/1 immediately under and to the right of t with typographic subscript size; the closing parenthesis follows directly after the subscript. In f_theta, theta must be a compact subscript immediately after f. Render dx/dt = f_theta(x,t) with readable compact spacing: upright d, operators and punctuation, italic variables. Do not remove formulas or replace them with plain-text explanations. Maintain Times New Roman throughout, preserve native separate editable formula components grouped by formula. Improve the soft visual depth/shadow and curve endpoint correspondence where feasible using native vector objects, without raster wrapping. Preserve scientific meaning and all module labels. Return the complete repaired scene.';
  await fs.writeFile(path.join(out, 'refine-feedback.txt'), feedback);
  // Use the public application IPC path; no direct scene manipulation or fixture substitution.
  const refined = await page.evaluate(({ id, feedback }) => window.mkFigure.run(id, 'refine', feedback), { id: projectId, feedback });
  assert.ok(refined.scene && refined.scene.elements.length > 10);
  assert.equal(refined.target.id, before.target.id);
  assert.equal(refined.generated.length, before.generated.length);
  await fs.writeFile(path.join(out, 'after.scene.json'), JSON.stringify(refined.scene, null, 2));
  if (refined.previewPng) await fs.writeFile(path.join(out, 'after.png'), Buffer.from(refined.previewPng.split(',')[1], 'base64'));
  result.refinement = { completed: true, elements: refined.scene.elements.length, targetUnchanged: true, generatedCountUnchanged: true, sceneChanged: JSON.stringify(refined.scene) !== JSON.stringify(before.scene) };
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log('One refinement completed; reviewing once');
  const reviewed = await page.evaluate(id => window.mkFigure.run(id, 'review'), projectId);
  await fs.writeFile(path.join(out, 'after.qa.json'), JSON.stringify(reviewed.qa, null, 2));
  result.after = { elements: reviewed.scene.elements.length, qa: reviewed.qa };
  await client.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, out);
  result.export = await page.evaluate(id => window.mkFigure.exportProject(id, ['pptx', 'svg', 'png']), projectId);
  const archive = await JSZip.loadAsync(await fs.readFile(result.export.files.find(file => file.endsWith('.pptx'))));
  const slideXml = await archive.file('ppt/slides/slide1.xml').async('string');
  result.exportAudit = {
    textRuns: [...slideXml.matchAll(/<a:t>/g)].length,
    officeMathObjects: [...slideXml.matchAll(/<m:oMath/g)].length,
    pictureObjects: [...slideXml.matchAll(/<p:pic>/g)].length,
    fontNames: [...new Set([...slideXml.matchAll(/typeface="([^"]+)"/g)].map(match => match[1]))],
    mediaFiles: Object.values(archive.files).filter(file => file.name.startsWith('ppt/media/') && !file.dir).length,
    nativePowerPointReopenTested: false,
  };
  await page.reload();
  await page.getByRole('button', { name: /Live Neural ODE test/ }).first().click();
  await page.getByRole('button', { name: /检查与精修/ }).click();
  await snapshot('review-after', 1100, 800);
  await snapshot('review-after', 1440, 960);
  await page.getByRole('button', { name: /生成视觉稿.*构图与风格探索/ }).click();
  await snapshot('visual-stage', 1100, 800);
  await snapshot('visual-stage', 1440, 960);
  result.functionalPassed = result.refinement.completed && result.cancellation.passed && result.pageErrors.length === 0;
  result.visualReviewPassed = reviewed.qa.visualReview === 'reviewed';
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ functionalPassed: result.functionalPassed, visualReviewPassed: result.visualReviewPassed, cancellation: result.cancellation, viewports: result.viewports, remainingIssues: reviewed.qa.issues }));
} catch (error) {
  result.failure = error instanceof Error ? error.message : String(error);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  console.error(result.failure);
  process.exitCode = 1;
} finally { await client.close(); }
