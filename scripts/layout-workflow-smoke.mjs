// Run after npm run build. MK_PACKAGED_EXE selects an unpacked or installed release.
// Seed from a local full gallery (MK_LAYOUT_QA_GALLERY) or a gallery-images cache (MK_LAYOUT_QA_CACHE).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'mk-layout-smoke-'));
const folder = path.join(sandbox, '离线科研图');
const profile = path.join(sandbox, 'profile');
const projectDir = path.join(folder, '.mkfigure', 'projects');
const output = path.resolve(process.env.MK_LAYOUT_QA_OUT || path.join(root, '.runtime', 'layout-qa', path.basename(sandbox)));
const source = path.resolve(process.env.MK_LAYOUT_QA_GALLERY || path.join(root, 'resources', 'paper-gallery'));
const cache = path.join(profile, 'gallery-images');
const hashes = JSON.parse(await fs.readFile(path.join(root, 'resources', 'paper-gallery', 'data', 'image-hashes.json'), 'utf8'));
await Promise.all([folder, cache, output].map(dir => fs.mkdir(dir, { recursive: true })));
await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ settings: { providers: [{ id:'codex', enabled:false }] }, keys:{} }));
const env = { ...process.env, MK_FIGURE_DATA_DIR:profile };
for (const name of ['ELECTRON_RUN_AS_NODE','MK_DEV_URL','OPENAI_API_KEY','CODEX_API_KEY']) delete env[name];
const exe = process.env.MK_PACKAGED_EXE;
const report = { version:'', packaged:!!exe, tests:[], imageIds:[], screenshots:[], networkRequests:[], pageErrors:[] };
const button = (area, name) => area.getByRole('button', { name, exact:true });
let app, page;

async function launch() {
  app = await electron.launch({ executablePath:exe || electronPath, cwd:root, args:exe ? [] : [root], env, timeout:90000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => report.pageErrors.push(e.message));
  await app.evaluate(({ net, session, BrowserWindow }) => {
    globalThis.qaNetwork = [];
    net.fetch = async input => { globalThis.qaNetwork.push(String(input)); throw Error('QA environment is offline'); };
    session.defaultSession.webRequest.onBeforeRequest({ urls:['http://*/*','https://*/*'] }, (req, callback) => {
      globalThis.qaNetwork.push(req.url); callback({ cancel:true });
    });
    const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setContentSize(1440, 940);
  });
  await page.locator('.workspace-folder-list').waitFor();
  const state = await page.evaluate(() => window.mkFigure.bootstrap());
  assert.equal(state.settings.providers.find(p => p.id === 'codex')?.enabled, false);
  report.version = state.version;
}
async function close() {
  if (!app) return;
  report.networkRequests.push(...await app.evaluate(() => globalThis.qaNetwork));
  await app.close(); app = undefined;
}
async function picker(paths) {
  await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled:false, filePaths:files }); }, paths);
}
async function chooseFolder() {
  await picker([folder]); await button(page, '打开文件夹').click();
  await page.locator('.active-folder strong').filter({ hasText:path.basename(folder) }).waitFor();
  await page.locator('.studio-switching').waitFor({ state:'hidden' });
}
const nav = () => page.getByRole('navigation', { name:'工作区导航' });
const pane = () => page.locator('.pane-host:visible').first();
const editor = () => pane().locator('.mk-layout-planner');
async function expand(details) {
  if (!await details.evaluate(el => el.open)) await details.locator(':scope > summary').click();
}
async function screenshot(name, target) {
  await target.scrollIntoViewIfNeeded(); await page.screenshot({ path:path.join(output, name + '.png') }); report.screenshots.push(name);
}
async function seed(query) {
  const rows = await page.evaluate(q => window.mkFigure.recommendPaperLayouts(q), query);
  assert.ok(rows.length >= 2);
  for (const { figure } of rows) {
    const hash = hashes[figure.id];
    let bytes;
    try { bytes = await fs.readFile(path.join(source,figure.image)); }
    catch (err) {
      if (!process.env.MK_LAYOUT_QA_CACHE) throw Error('An offline gallery snapshot or MK_LAYOUT_QA_CACHE is required for ' + figure.id, {cause:err});
      bytes = await fs.readFile(path.join(process.env.MK_LAYOUT_QA_CACHE,hash + '.jpg'));
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    await fs.writeFile(path.join(cache, hash + '.jpg'), bytes);
  }
  return rows;
}
async function selectTwo(planner, query) {
  await expand(planner);
  await planner.getByLabel('检索任务').fill(query);
  await button(planner, '按任务推荐').click();
  const choices = planner.locator('.mk-layout-choice');
  await choices.nth(1).waitFor();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const url = await choices.nth(i).locator('img').evaluate(async img => { await img.decode(); if (!img.naturalWidth) throw Error('Empty thumbnail'); return img.currentSrc; });
    assert.match(url, /^mk-gallery:\/\/figure\//);
    ids.push(decodeURIComponent(new URL(url).pathname.slice(1)));
    await choices.nth(i).click();
  }
  assert.equal(new Set(ids).size, 2);
  assert.equal(await planner.locator('.mk-layout-picked li').count(), 2);
  return ids;
}
async function saved() {
  await pane().locator('.save-status').filter({ hasText:/已保存|已自动保存/ }).waitFor();
}
async function readProject() {
  for (const id of await fs.readdir(projectDir)) {
    const file = path.join(projectDir,id,'project.json');
    const data = JSON.parse(await fs.readFile(file,'utf8'));
    if (data.draftSlot === 1) return data;
  }
  throw Error('Missing pane 1 draft');
}
async function makeContent(name, color) {
  const data = new PNG({width:64,height:40});
  for (let i = 0; i < data.data.length; i += 4) data.data.set([...color,255],i);
  const file = path.join(sandbox, name); await fs.writeFile(file,PNG.sync.write(data)); return file;
}
const query = '机器人 扩散 策略', sharedQuery = '双分支 特征融合';

try {
  await launch(); await chooseFolder();
  await seed(query); await seed(sharedQuery);
  await button(nav(),'单图创作').click();
  await pane().locator('textarea.composer').fill(query);
  await button(pane().locator('.stage-actions'),'生成视觉稿').waitFor();
  assert.equal(await editor().evaluate(el => el.open), false);
  report.tests.push('normal single-figure generation entry remains available before planning');

  const ids = await selectTwo(editor(),query);
  report.imageIds = ids;
  await screenshot('recommended-references', editor().locator('.mk-layout-results article').first());
  await editor().getByLabel('面板排列').selectOption('vertical');
  await editor().getByLabel('面板 1',{exact:true}).fill('传感器输入');
  await editor().getByLabel('版式说明').fill('从上到下，明确策略输出');
  await button(editor(),'读参考图细化版式').click();
  await editor().getByRole('alert').filter({hasText:/Codex|连接/}).waitFor();
  assert.equal(await editor().getByLabel('面板 1',{exact:true}).inputValue(),'传感器输入');
  assert.equal(await editor().locator('.mk-layout-picked li').count(),2);
  await screenshot('single-layout', editor().locator('.mk-layout-sketch'));
  report.tests.push('two distinct real images decoded, visible sketch edited and preserved after optional model is unavailable');

  const a = await makeContent('传感器示意.png',[43,122,133]);
  const b = await makeContent('对照对象.png',[149,76,74]);
  await picker([a,b]); await button(pane(),'从论文开始').click();
  const inputs = pane().locator('.generation-inputs');
  await expand(inputs); await inputs.getByLabel('对照对象.png').waitFor();
  assert.equal(await inputs.getByLabel('传感器示意.png').isChecked(),true);
  assert.equal(await inputs.getByLabel('对照对象.png').isChecked(),true);
  await inputs.getByLabel('对照对象.png').uncheck();
  await inputs.getByText('版式参考',{exact:true}).waitFor();
  assert.match(await inputs.locator('summary').innerText(),/3 张/);
  assert.equal(await inputs.locator('li').count(),2);
  await saved(); const original = await readProject();
  assert.deepEqual(original.brief.layoutPlan.referenceIds,ids);
  assert.deepEqual(original.brief.layoutPlan.citations.map(c=>c.id),ids);
  assert.equal(original.brief.layoutPlan.arrangement,'vertical');
  assert.equal(original.brief.contentImageIds.length,1);
  report.tests.push('two source images imported, selected content and layout roles accurately previewed and saved');

  await button(page.locator('.studio-header'),'统一风格').click();
  const dialog = page.getByRole('dialog',{name:'统一风格'});
  const shared = dialog.locator('.mk-layout-planner');
  const sharedIds = await selectTwo(shared,sharedQuery);
  await shared.getByLabel('版式说明').fill('两支并行，右侧合并');
  await button(dialog,'保存风格').click(); await dialog.waitFor({state:'hidden'});
  const all = await page.evaluate(() => Promise.all(window.mkFigure.panes.map(async api=>(await api.getFolder()).folder.style.layoutPlan)));
  assert.equal(all.length,6);
  for(const plan of all){ assert.equal(plan.arrangement,'parallel'); assert.deepEqual(plan.referenceIds,sharedIds); }
  await button(nav(),'并行创作').click();
  const two=page.locator('section.pane-host[data-pane-id="pane-2"]');
  await button(two,'新建科研图').click();
  await button(two,'展开子窗口 2').click();
  await two.getByText(/沿用文件夹版式/).waitFor();
  const inherited = two.locator('.generation-inputs');
  await expand(inherited); assert.equal(await inherited.locator('li').count(),2);
  await screenshot('shared-inputs', inherited);
  report.tests.push('folder-wide plan visible to all six pane APIs and inherited by a new second pane');
  await close();

  const legacyId=randomUUID();
  const legacy={ ...original,id:legacyId,name:'旧格式兼容测试',styleMode:'none',brief:{...original.brief} };
  delete legacy.draftSlot; delete legacy.brief.contentImageIds; delete legacy.brief.layoutPlan;
  await fs.cp(path.join(projectDir,original.id),path.join(projectDir,legacyId),{recursive:true});
  await fs.writeFile(path.join(projectDir,legacyId,'project.json'), JSON.stringify(legacy));

  await launch();
  if (!await page.locator('.active-folder strong').count()) await chooseFolder();
  await button(nav(),'单图创作').click();
  await editor().getByLabel('面板 1',{exact:true}).waitFor();
  assert.equal(await editor().getByLabel('面板 1',{exact:true}).inputValue(),'传感器输入');
  assert.equal(await editor().getByLabel('版式说明').inputValue(),'从上到下，明确策略输出');
  assert.equal(await editor().locator('.mk-layout-picked li').count(),2);
  await expand(pane().locator('.generation-inputs'));
  assert.equal(await pane().getByRole('checkbox',{name:'传感器示意.png',exact:true}).isChecked(),true);
  assert.equal(await pane().getByRole('checkbox',{name:'对照对象.png',exact:true}).isChecked(),false);
  await page.locator('.folder-project-row').getByRole('button',{name:'旧格式兼容测试',exact:true}).click();
  const oldInputs = pane().locator('.generation-inputs'); await expand(oldInputs);
  assert.equal(await oldInputs.getByLabel('传感器示意.png').isChecked(),true);
  assert.equal(await oldInputs.getByLabel('对照对象.png').isChecked(),true);
  assert.match(await oldInputs.locator('summary').innerText(),/2 张/);
  assert.equal(await oldInputs.locator('li').count(),0);
  report.tests.push('restart restored custom plan and explicit selection; legacy project without either field opened with default content-image selection');
  await close();
  assert.deepEqual(report.networkRequests,[]); assert.deepEqual(report.pageErrors,[]);
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,...report},null,2));
} catch(error) {
  if(page && !page.isClosed()) {
    await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
    await fs.writeFile(path.join(output,'failure.txt'),await page.locator('body').innerText().catch(()=>''));
  }
  console.error('QA evidence:',output,'fixture:',sandbox); throw error;
} finally { await close(); }
