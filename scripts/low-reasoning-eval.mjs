// Read-only by default. --execute explicitly spends authenticated Codex quota.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const root = process.cwd();
const output = path.join(root, 'output', 'low-reasoning-2026-09-19');
const executing = process.argv.includes('--execute');
const resume = process.argv.includes('--resume');
await fs.mkdir(output, { recursive: true });
const hash = data => createHash('sha256').update(data).digest('hex');
const writeJson = (name, data) => fs.writeFile(path.join(output, name), JSON.stringify(data, null, 2));
const realSettingsPath = path.join(process.env.APPDATA || '', 'MK Figure', 'settings.json');
const originalSettings = await fs.readFile(realSettingsPath).catch(() => null);
const saved = originalSettings ? JSON.parse(originalSettings.toString('utf8')).settings : undefined;
const savedCodex = saved?.providers?.find(provider => provider.id === 'codex');

// Bundle the production RPC implementation: no alternate auth client or raw credential handling.
const probeModule = path.join(output, 'probe-provider.cjs');
await build({ entryPoints: [path.join(root, 'src/main/providers/codex.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: probeModule, logLevel: 'silent' });
const { CodexRpc, locateCodex } = createRequire(import.meta.url)(probeModule);
const runtimeRoot = path.join(root, 'resources/codex', `${process.platform === 'win32' ? 'win' : 'mac'}-${process.arch}`);
const manifest = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'manifest.json'), 'utf8'));
const executable = locateCodex(savedCodex?.codexPath || path.join(runtimeRoot, manifest.executable));
const probeCwd = path.join(output, 'probe-work');
await fs.mkdir(probeCwd, { recursive: true });
const rpc = new CodexRpc(executable, probeCwd);
let preflight;
try {
  await rpc.start();
  const account = await rpc.request('account/read', { refreshToken: false });
  const models = [];
  let cursor = null;
  do {
    const result = await rpc.request('model/list', { cursor, limit: 100, includeHidden: false });
    for (const value of result.data || []) models.push({
      id: value.model || value.id, name: value.displayName, isDefault: value.isDefault === true,
      supportsVision: value.inputModalities?.includes('image') === true,
      efforts: (value.supportedReasoningEfforts || []).map(entry => entry.reasoningEffort),
    });
    if (result.nextCursor === cursor && cursor) throw new Error('Repeated model cursor');
    cursor = result.nextCursor || null;
  } while (cursor);
  const candidates = models.filter(model => model.supportsVision && model.efforts.includes('low'));
  const selected = candidates.find(model => model.id === savedCodex?.model) || candidates.find(model => model.isDefault) || candidates[0];
  assert.ok(account.account, 'The current Codex account is not authenticated');
  assert.ok(selected, 'No current account model reports both image input and low reasoning');
  preflight = {
    checkedAt: new Date().toISOString(), account: { type: account.account.type, planType: account.account.planType ?? null },
    configured: { model: savedCodex?.model || null, effort: saved?.reasoningEffort || null },
    selectedModel: selected.id, selectionReason: selected.id === savedCodex?.model ? 'current-app-model' : selected.isDefault ? 'account-default' : 'first-image-low-model',
    requestedEffort: 'low', models, runtimeVersion: manifest.version,
    limitation: 'This is a low-effort test of the signed-in account. It is not a Plus-account or Plus-quota test unless account.planType is plus. Native image-tool internals and their reasoning intensity are not exposed by this app.',
  };
  await writeJson('preflight.json', preflight);
  console.log(JSON.stringify(preflight));
} finally { rpc.dispose(); }

if (executing) await execute();
const currentSettings = await fs.readFile(realSettingsPath).catch(() => null);
const unchanged = originalSettings === null ? currentSettings === null : currentSettings !== null && hash(originalSettings) === hash(currentSettings);
await writeJson('real-settings-integrity.json', { checkedAt: new Date().toISOString(), unchanged });
assert.ok(unchanged, 'Real MK Figure settings changed during the isolated test');

async function execute() {
  const { _electron: electron } = await import('playwright');
  const { default: electronPath } = await import('electron');
  const { default: JSZip } = await import('jszip');
  const ledgerFile = path.join(output, 'evaluation.json');
  const previous = await fs.readFile(ledgerFile, 'utf8').then(JSON.parse).catch(() => null);
  if (previous && !resume) throw new Error('An evaluation ledger exists. Use --resume to continue only untouched actions; completed/failed calls are never repeated automatically.');
  const dataDirectory = path.join(output, 'app-data');
  const env = { ...process.env, MK_FIGURE_DATA_DIR: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  const client = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 60000 });
  const report = previous || { startedAt: new Date().toISOString(), preflight, actions: [], files: [], manualVisualReview: 'pending', limits: 'One generate, one direct edit, one AI-refined edit (one text call plus one image call), one prompt-only regenerate, one reconstruction. Reconstruction may use its production one-shot JSON repair. No AI review call.' };
  const persist = () => fs.writeFile(ledgerFile, JSON.stringify(report, null, 2));
  const figurePrompt = [
    'Draw a compact, publication-ready Neural ODE training schematic in English, wide 2:1 aspect ratio, white background, with five well-spaced modules and exactly these module titles:',
    'Initial state; Neural vector field; ODE solver; Loss; Parameter update.',
    'Show left-to-right arrows Initial state -> Neural vector field -> ODE solver -> Loss -> Parameter update, and a thin feedback arrow from Parameter update back to Neural vector field.',
    'Include only these formulas, large enough to read: z(t0)=z0 beneath Initial state; dz/dt=f_theta(z,t) beneath Neural vector field; z(t1)=ODESolve(f_theta,z0,t0,t1) beneath ODE solver; L=||z(t1)-y||^2 beneath Loss; theta <- theta-eta grad_theta L beneath Parameter update.',
    'Typeset theta and eta as mathematical Greek symbols, correct subscript positions, upright operators, serif italic variables and Times New Roman English. No Office Math requirement, no explanatory paragraphs.',
    'Use pale blue module backgrounds with dark navy headings, restrained thin arrows, generous whitespace, no decorative illustration, no data plot and no invented experimental results.',
  ].join('\n');
  try {
    const page = await client.firstWindow();
    await page.getByRole('button', { name: /^新建科研图/ }).waitFor({ timeout: 60000 });
    await client.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.restore(); win.show(); win.focus(); });
    page.on('console', message => { if (message.text().startsWith('LOW-EVAL ')) console.log(message.text()); });
    await page.evaluate(() => window.mkFigure.onProgress(event => console.log('LOW-EVAL ' + JSON.stringify({ action: event.action, message: event.message, durationMs: event.metrics?.durationMs, usage: event.metrics?.usage }))));
    await page.evaluate(async ({ model, codexPath }) => {
      const boot = await window.mkFigure.bootstrap();
      const codex = boot.settings.providers.find(value => value.id === 'codex');
      codex.model = model; codex.enabled = true; codex.vision = true;
      if (codexPath) codex.codexPath = codexPath;
      boot.settings.reasoningEffort = 'low';
      await window.mkFigure.saveSettings(boot.settings);
    }, { model: preflight.selectedModel, codexPath: savedCodex?.codexPath });
    let project = report.projectId ? await page.evaluate(id => window.mkFigure.openProject(id), report.projectId) : await page.evaluate(async prompt => {
      const project = await window.mkFigure.createProject('Neural ODE · low reasoning evaluation', 'full');
      project.brief.topic = 'Neural ODE training with five modules';
      project.brief.focus = 'Initial state, neural vector field, numerical integration, supervised loss, gradient update; schematic only.';
      project.brief.language = 'en'; project.brief.aspectRatio = '2:1'; project.brief.purpose = 'paper'; project.brief.fullVector = true;
      project.brief.prompt = prompt; project.brief.notes = ''; project.brief.stylePrompt = '';
      return window.mkFigure.saveProject(project);
    }, figurePrompt);
    report.projectId = project.id; report.fixturePrompt = figurePrompt; await persist();

    async function restoreBaseline() {
      if (!report.baselineAssetId) throw new Error('Baseline image missing');
      project = await page.evaluate(async ({ id, targetId }) => { const p = await window.mkFigure.openProject(id); p.target = p.generated.find(asset => asset.id === targetId); return window.mkFigure.saveProject(p); }, { id: project.id, targetId: report.baselineAssetId });
    }
    async function run(action, feedback = '', label = action) {
      const done = report.actions.find(entry => entry.action === action);
      if (done) {
        if (done.status !== 'completed') throw new Error(`Action ${action} was already attempted (${done.status}); no automatic paid retry`);
        project = await page.evaluate(id => window.mkFigure.openProject(id), project.id);
        if (done.assetId && project.target?.id !== done.assetId) {
          project = await page.evaluate(async ({ id, targetId }) => { const p = await window.mkFigure.openProject(id); p.target = p.generated.find(asset => asset.id === targetId); return window.mkFigure.saveProject(p); }, { id: project.id, targetId: done.assetId });
        }
        return;
      }
      const entry = { action, label, feedback, status: 'running', startedAt: new Date().toISOString() };
      report.actions.push(entry); await persist();
      try {
        project = await page.evaluate(({ id, action, feedback }) => window.mkFigure.run(id, action, feedback), { id: project.id, action, feedback });
        const metrics = project.runs?.filter(run => run.action === action).at(-1);
        assert.equal(metrics?.status, 'completed'); assert.equal(metrics.reasoningEffort, 'low');
        Object.assign(entry, { status: 'completed', metrics, finishedAt: new Date().toISOString() });
        if (action !== 'reconstruct') {
          assert.ok(project.target?.previewUrl?.startsWith('data:image/png;base64,'));
          const filename = `${String(report.actions.length).padStart(2, '0')}-${action}.png`;
          const bytes = Buffer.from(project.target.previewUrl.split(',')[1], 'base64');
          await fs.writeFile(path.join(output, filename), bytes);
          Object.assign(entry, { imageFile: filename, imageSha256: hash(bytes), width: project.target.width, height: project.target.height, assetId: project.target.id });
          const operation = path.join(dataDirectory, 'projects', project.id, 'generation', `operation-${metrics.id}.json`);
          const metadata = await fs.readFile(operation, 'utf8').then(JSON.parse).catch(() => null);
          if (metadata) { const name = `${String(report.actions.length).padStart(2, '0')}-${action}-request.json`; await writeJson(name, metadata); entry.requestFile = name; }
        } else {
          assert.ok(project.scene?.elements.length > 10);
          assert.equal(project.scene.elements.filter(item => item.type === 'image').length, 0);
          assert.ok(project.previewPng?.startsWith('data:image/png;base64,'));
          await fs.writeFile(path.join(output, '05-editable-preview.png'), Buffer.from(project.previewPng.split(',')[1], 'base64'));
          await writeJson('05-scene.json', project.scene);
          entry.sceneElements = project.scene.elements.length;
          entry.qa = project.qa;
          const text = project.scene.elements.filter(item => item.type === 'text').map(item => item.text).join(' ');
          entry.moduleTextChecks = Object.fromEntries(['Initial state', 'Neural vector field', 'ODE solver', 'Loss', 'Parameter update'].map(label => [label, text.toLowerCase().includes(label.toLowerCase())]));
          entry.formulasRequireManualReview = true;
        }
        await persist(); console.log('LOW-EVAL COMPLETE ' + JSON.stringify(entry));
      } catch (error) {
        const stored = await page.evaluate(id => window.mkFigure.openProject(id), project.id).catch(() => null);
        Object.assign(entry, { status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), metrics: stored?.runs?.filter(run => run.action === action).at(-1) });
        await persist(); throw error;
      }
    }
    await run('generate');
    report.baselineAssetId ||= report.actions.find(entry => entry.action === 'generate').assetId; await persist();
    await restoreBaseline();
    await run('edit-image', 'Edit this source image only: change the background fill of the Loss module to a pale peach color. Preserve all other text, formulas, arrows, layout and colors. Do not add a style reference or rewrite the scientific content.');
    await restoreBaseline();
    await run('refine-image', 'Make the Parameter update module stand out with a pale sage green background. Keep the five-module layout and all formulas, labels, arrows and the other module colors unchanged.');
    await run('regenerate-image', figurePrompt + '\nUse pale lavender only for the ODE solver module. Generate a new image from these words, with no image reference.');
    await run('reconstruct', 'Preserve the five labeled modules and all formulas exactly; keep math components editable and use separate text for superscripts and subscripts.');
    const exportDir = path.join(output, 'exports'); await fs.mkdir(exportDir, { recursive: true });
    await client.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, exportDir);
    const exported = await page.evaluate(id => window.mkFigure.exportProject(id, ['pptx', 'svg']), project.id);
    assert.deepEqual(exported.files.map(file => path.extname(file)).sort(), ['.pptx', '.svg']);
    const pptxFile = exported.files.find(file => file.endsWith('.pptx'));
    const zip = await JSZip.loadAsync(await fs.readFile(pptxFile));
    const slideXml = await zip.file('ppt/slides/slide1.xml').async('string');
    const objectCount = (slideXml.match(/<p:sp>/g) || []).length;
    assert.ok(objectCount > 10); assert.ok(!/<m:oMath\b/.test(slideXml));
    report.files = exported.files.map(file => path.relative(output, file));
    report.pptx = { editableShapeCount: objectCount, containsOfficeMath: false, PowerPointVisualInspection: 'pending' };
    report.completedAt = new Date().toISOString();
    await page.reload();
    await page.getByRole('button', { name: /Neural ODE · low reasoning evaluation/ }).first().click({ timeout: 60000 });
    await page.getByRole('img', { name: '可编辑科研图预览' }).waitFor({ timeout: 60000 });
    await page.screenshot({ path: path.join(output, '06-app-result.png') });
    report.screenshot = '06-app-result.png'; await persist();
    console.log('LOW-EVAL FINISHED ' + JSON.stringify({ files: report.files, actions: report.actions.map(({ action, status, metrics }) => ({ action, status, metrics })), account: preflight.account }));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error); await persist();
    process.exitCode = 1; console.error(report.error);
  } finally { await client.close(); }
}
