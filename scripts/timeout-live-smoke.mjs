// Opt-in reconstruction-only verification using a copy of an existing project.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

if (process.env.MK_TIMEOUT_LIVE !== '1') throw new Error('Set MK_TIMEOUT_LIVE=1 for the authorized live test');
const projectId = process.env.MK_TIMEOUT_PROJECT;
if (!projectId || !/^[\w-]+$/.test(projectId)) throw new Error('Set MK_TIMEOUT_PROJECT to an existing project ID');
const root = process.cwd();
const source = path.join(process.env.APPDATA, 'MK Figure');
const tag = new Date().toISOString().replace(/[:.]/g, '-');
const data = path.join(root, '.runtime', 'timeout-fix', tag);
const out = path.join(root, 'output', 'timeout-fix', tag);
await fs.mkdir(out, { recursive: true });
await fs.cp(path.join(source, 'projects', projectId), path.join(data, 'projects', projectId), { recursive: true });
const original = path.join(source, 'projects', projectId, 'project.json');
const originalBytes = await fs.readFile(original);
const copy = JSON.parse(originalBytes);
copy.name = '超时修复验证';
await fs.writeFile(path.join(data, 'projects', projectId, 'project.json'), JSON.stringify(copy));
const saved = JSON.parse(await fs.readFile(path.join(source, 'settings.json'), 'utf8'));
assert.equal(saved.settings.activeProvider, 'codex');
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ settings: saved.settings, keys: {} }));
const env = { ...process.env, MK_FIGURE_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const client = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60000 });
const started = Date.now(), events = [], errors = [];
console.log(JSON.stringify({ output: out, projectCopy: data, effort: saved.settings.reasoningEffort }));
try {
  const page = await client.firstWindow();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => {
    const text = message.text();
    if (text.startsWith('MK_TIMEOUT_PROGRESS ')) {
      const event = JSON.parse(text.slice(20));
      events.push({ elapsedSeconds: Math.round((Date.now() - started) / 1000), ...event });
      console.log(text);
    }
  });
  await page.getByRole('button', { name: /^新建科研图/ }).waitFor();
  await page.getByRole('button', { name: /超时修复验证/ }).click();
  await page.evaluate(() => window.mkFigure.onProgress(e => console.log('MK_TIMEOUT_PROGRESS ' + JSON.stringify(e))));
  const run = page.evaluate(id => window.mkFigure.run(id, 'reconstruct'), projectId);
  // Catch immediately while the request is still running.
  void run.catch(() => {});
  const captureTimer = setTimeout(() => void page.screenshot({ path: path.join(out, 'working.png') }).catch(() => {}), 20_000);
  let project;
  try { project = await run; } finally { clearTimeout(captureTimer); }
  assert.ok(project.scene?.elements.length > 10);
  assert.ok(project.qa?.structuralPassed);
  await page.reload();
  await page.getByRole('button', { name: /超时修复验证/ }).click();
  await page.getByRole('img', { name: '可编辑科研图预览' }).waitFor();
  await page.screenshot({ path: path.join(out, 'result.png') });
  await client.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, out);
  const exported = await page.evaluate(id => window.mkFigure.exportProject(id, ['pptx', 'svg', 'png']), projectId);
  assert.deepEqual(await fs.readFile(original), originalBytes);
  assert.deepEqual(errors, []);
  const result = { passed: true, elapsedSeconds: Math.round((Date.now() - started) / 1000), elements: project.scene.elements.length, qa: project.qa, files: exported.files, originalProjectUnchanged: true, pageErrors: errors, events };
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, output: out, elapsedSeconds: result.elapsedSeconds, elements: result.elements }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: String(error), elapsedSeconds: Math.round((Date.now() - started) / 1000), pageErrors: errors, events }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally { await client.close(); }
