// Offline material import/persistence verification through real Electron preload IPC.
// Native chooser results are supplied by the test; source files are read-only inputs.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root = process.cwd(), out = path.join(root, 'output', 'materials-smoke');
const inputs = [
  'D:\\Users\\Humengkai\\Desktop\\科研日志\\2026\\毕设\\前期资料\\毕设资料\\NODE相关论文参考\\核心文献\\Chen 等。 - 2018 - Neural ordinary differential equations.pdf',
  'D:\\Users\\Humengkai\\Desktop\\0 AI 复刻图片\\参考图\\overview.pptx',
];
const imageInput = path.join(root, 'resources', 'references', 'pastel-method.png');
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
await fs.mkdir(out, { recursive: true });
const env = { ...process.env, MK_FIGURE_DATA_DIR: path.join(root, '.runtime', 'materials-smoke') };
delete env.ELECTRON_RUN_AS_NODE;
const result = { startedAt: new Date().toISOString(), aiCalls: 0, pageErrors: [], dialogCalls: [], materials: [], checks: {} };
const beforeHashes = await Promise.all(inputs.map(hash));
let client, page;
async function choose(files) {
  await client.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.__materialsDialog = options;
      return { canceled: false, filePaths: selected };
    };
  }, files);
}
async function rememberDialog() {
  result.dialogCalls.push(await client.evaluate(() => globalThis.__materialsDialog));
}
try {
  client = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60000 });
  page = await client.firstWindow();
  page.on('pageerror', e => result.pageErrors.push(e.message));
  await page.getByRole('button', { name:/^新建科研图/ }).waitFor({ timeout: 60000 });
  const created = await page.evaluate(() => window.mkFigure.createProject('Materials import verification', 'full'));
  result.projectId = created.id;
  await choose(inputs);
  const imported = await page.evaluate(id => window.mkFigure.importFiles(id, 'sources'), created.id);
  await rememberDialog();
  assert.equal(imported.sources.length, 2);
  for (const [index, asset] of imported.sources.entries()) {
    const markers = [...(asset.text || '').matchAll(/\[(Page|Slide) (\d+)\]/g)].map(m => ({ type: m[1], index: Number(m[2]) }));
    const bodyChars = (asset.text || '').replace(/\[(Page|Slide) \d+\]/g, '').trim().length;
    const stored = path.join(env.MK_FIGURE_DATA_DIR, 'projects', created.id, 'assets', asset.path);
    const copyHash = await hash(stored);
    result.materials.push({ name: asset.name, kind: asset.kind, characters: asset.text?.length || 0, bodyCharacters: bodyChars, markers, warnings: asset.warnings || [], sourceSha256: beforeHashes[index], copySha256: copyHash });
    assert.ok(bodyChars > 0, `${asset.kind} must contain real extracted text, not only page markers`);
    assert.ok(markers.length > 0 && markers[0].index === 1);
    assert.ok(markers.every((m, i) => m.index === i + 1), 'Source markers must be sequential');
    assert.equal(copyHash, beforeHashes[index]);
    assert.equal(asset.previewUrl, undefined, 'Documents must not masquerade as image previews');
  }
  assert.equal(imported.target, undefined);
  assert.equal(imported.customReference, undefined);
  assert.ok(imported.sources[0].warnings.some(x => x.includes('PDF 图表与公式')));
  assert.ok(imported.sources[1].warnings.some(x => x.includes('另上传页面 PNG/JPEG')));
  result.checks.documentImport = true;

  await choose([imageInput]);
  const referenced = await page.evaluate(id => window.mkFigure.importFiles(id, 'reference'), created.id);
  await rememberDialog();
  assert.equal(referenced.sources.length, 2);
  assert.equal(referenced.customReference.kind, 'image');
  assert.ok(referenced.customReference.previewUrl.startsWith('data:image/'));
  assert.equal(referenced.target, undefined);
  const targeted = await page.evaluate(id => window.mkFigure.importFiles(id, 'target'), created.id);
  await rememberDialog();
  assert.equal(targeted.sources.length, 2);
  assert.equal(targeted.customReference.id, referenced.customReference.id);
  assert.equal(targeted.target.kind, 'image');
  assert.notEqual(targeted.target.id, referenced.customReference.id);
  assert.equal(targeted.stage, 'reconstruct');
  result.checks.distinctContentStyleAndReconstructionRoles = true;

  // Use the real removal button, auto-save, and a renderer reload.
  await page.reload();
  await page.getByRole('button', { name: /Materials import verification/ }).first().click();
  await page.getByRole('button', { name: /描述想法.*内容与参考资料/ }).click();
  await page.getByRole('button', { name: `移除 ${path.basename(inputs[0])}`, exact: true }).click();
  await page.getByText('已自动保存', { exact: true }).waitFor({ timeout: 15000 });
  await page.reload();
  const reopened = await page.evaluate(id => window.mkFigure.openProject(id), created.id);
  assert.equal(reopened.sources.length, 1);
  assert.equal(reopened.sources[0].kind, 'pptx');
  assert.equal(reopened.customReference.id, targeted.customReference.id);
  assert.equal(reopened.target.id, targeted.target.id);
  await page.getByRole('button', { name: /Materials import verification/ }).first().click();
  await page.getByRole('button', { name: /描述想法.*内容与参考资料/ }).click();
  await page.getByRole('button', { name: `移除 ${path.basename(inputs[1])}`, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: `移除 ${path.basename(inputs[0])}`, exact: true }).count(), 0);
  await page.getByText('已自动保存', { exact: true }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(out, 'after-remove-reopen.png') });
  result.checks.uiRemovalSavedAndReopened = true;

  // Invalid project IDs, caller-supplied source paths, and arbitrary reveal paths stay blocked.
  for (const id of ['../outside', 'C:\\outside']) {
    let blocked = false;
    try { await page.evaluate(value => window.mkFigure.openProject(value), id); } catch { blocked = true; }
    assert.ok(blocked);
  }
  const attempted = structuredClone(reopened);
  attempted.sources.push({ id: 'injected', name: 'outside.txt', path: 'C:\\outside.txt', kind: 'text', mime: 'text/plain', text: 'injected' });
  const sanitized = await page.evaluate(value => window.mkFigure.saveProject(value), attempted);
  assert.ok(!sanitized.sources.some(x => x.id === 'injected'));
  let revealBlocked = false;
  try { await page.evaluate(file => window.mkFigure.revealFile(file), inputs[0]); } catch { revealBlocked = true; }
  assert.ok(revealBlocked);
  result.checks.invalidIdsAndUnapprovedPathsBlocked = true;

  // Dummy key only in this test's isolated data directory, never a real key file.
  const keyCheck = await page.evaluate(async () => {
    const boot = await window.mkFigure.bootstrap();
    const dummy = 'MATERIALS_SMOKE_DUMMY_NOT_A_REAL_KEY';
    const saved = await window.mkFigure.saveSettings(boot.settings, { custom: dummy });
    const after = await window.mkFigure.bootstrap();
    const answer = { hasKey: saved.providers.find(x => x.id === 'custom').hasKey, leaked: JSON.stringify([saved, after]).includes(dummy), fields: Object.keys(saved.providers.find(x => x.id === 'custom')) };
    await window.mkFigure.saveSettings(after.settings, { custom: '' });
    return answer;
  });
  assert.equal(keyCheck.hasKey, true);
  assert.equal(keyCheck.leaked, false);
  assert.ok(!keyCheck.fields.some(x => /^(key|apiKey|token|encryptedKeys)$/i.test(x)));
  result.checks.keyPresenceOnlyReturned = true;
  assert.deepEqual(result.pageErrors, []);
  result.passed = true;
} catch (error) {
  result.passed = false;
  result.failure = error instanceof Error ? error.message : String(error);
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  const afterHashes = await Promise.all(inputs.map(hash));
  result.checks.originalFilesUnchanged = JSON.stringify(beforeHashes) === JSON.stringify(afterHashes);
  if (!result.checks.originalFilesUnchanged) { result.passed = false; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (client) await client.close();
}
