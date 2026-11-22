import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mk-figure-gallery-'));
const profile = path.join(runDir, 'profile');
const folder = path.join(runDir, '论文插图演示');
const output = path.resolve(process.env.MK_GALLERY_QA_OUT || path.join(root, '.runtime', 'gallery-qa', path.basename(runDir)));
await Promise.all([profile, folder, output].map(dir => fs.mkdir(dir, { recursive: true })));
await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({
  settings: { providers: [{ id: 'codex', enabled: false }] }, keys: {},
}));

const env = { ...process.env, MK_FIGURE_DATA_DIR: profile };
for (const key of ['ELECTRON_RUN_AS_NODE', 'MK_DEV_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
const packaged = process.env.MK_PACKAGED_EXE;
const origin = 'https://qwdwqfwq.github.io/topconf-paper-figure-gallery/';
const selectedId = 'iclr2024-0684';
const key = 'paper:' + selectedId;
const pageErrors = [];
const report = { packaged: Boolean(packaged), tests: [], screenshots: [] };
let client, page, gallery, projectId, original;
const button = (container, name) => container.getByRole('button', { name, exact: true });
const cards = () => gallery.locator('.pg-card');
const search = () => gallery.getByRole('searchbox');
const detail = () => gallery.locator('dialog[open]');

async function launch() {
  client = await electron.launch({ executablePath: packaged || electronPath, cwd: root, args: packaged ? [] : [root], env, timeout: 90000 });
  page = await client.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
  // Exercise the production IPC handlers without altering the user's OS clipboard or opening a browser.
  await client.evaluate(({ BrowserWindow, clipboard, shell }) => {
    globalThis.paperSmokeClipboard = '';
    globalThis.paperSmokeOpened = [];
    clipboard.writeText = value => { globalThis.paperSmokeClipboard = value; };
    shell.openExternal = async url => { globalThis.paperSmokeOpened.push(url); };
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
  });
  await page.locator('.workspace-folder-list').waitFor();
  gallery = page.locator('.paper-gallery:visible');
  const account = await page.evaluate(async () => (await window.mkFigure.bootstrap()).settings.providers.find(p => p.id === 'codex'));
  assert.equal(account.enabled, false, 'isolated fixture must not start a model provider');
}
async function size(width) {
  await client.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 900), width);
  await page.waitForFunction(w => window.innerWidth === w, width);
}
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await page.evaluate(() => {
    const view = document.querySelector('.paper-gallery');
    const modal = document.querySelector('.pg-dialog[open]');
    const checked = [document.documentElement, view, modal].filter(Boolean);
    return { width: innerWidth, overflow: checked.filter(e => e.scrollWidth > e.clientWidth + 2).map(e => e.tagName + '.' + e.className) };
  });
  await page.screenshot({ path: path.join(output, name + '.png') });
  assert.deepEqual(dimensions.overflow, [], name + ' horizontal overflow');
  report.screenshots.push({ name, width: dimensions.width });
}
async function openGallery() {
  await button(page.getByRole('navigation', { name: '工作区导航' }), '顶会主图库').click();
  await gallery.getByRole('heading', { name: '顶会主图库', exact: true }).waitFor();
}
async function count(expected) {
  await page.waitForFunction(n => Number(document.querySelector('.paper-gallery .pg-results b')?.textContent.replace(/\D/g, '')) === n, expected);
}
async function chip(group, pattern) {
  await gallery.getByRole('group', { name: group, exact: true }).getByRole('button', { name: pattern }).click();
}
async function decodeCardImages(n) {
  const result = [];
  for (let i = 0; i < n; i++) {
    const img = cards().nth(i).locator('.pg-preview img');
    await img.scrollIntoViewIfNeeded();
    const data = await img.evaluate(async e => { await e.decode(); return [e.currentSrc, e.naturalWidth, e.naturalHeight]; });
    assert.match(data[0], /^mk-gallery:\/\/figure\//);
    assert.ok(Math.min(data[1], data[2]) > 10, 'decoded local paper figure ' + data[0]);
    result.push(data[0].split('/').at(-1));
  }
  assert.equal(new Set(result).size, n);
  return result;
}
async function selectFolder() {
  await client.evaluate(({ dialog }, demo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [demo] }); }, folder);
  await button(page, '打开文件夹').click();
  await page.waitForFunction(name => document.querySelector('.active-folder strong')?.textContent === name, path.basename(folder));
  await page.locator('.studio-switching').waitFor({ state: 'hidden' });
}
async function copyLink(control) {
  await control.click();
  await detail().getByRole('status').filter({hasText:'已复制'}).waitFor();
  const link = await client.evaluate(() => globalThis.paperSmokeClipboard);
  assert.ok(link.startsWith(origin), link);
  return new URL(link);
}
async function checkReferences() {
  const result = await page.evaluate(async id => {
    const api = window.mkFigure;
    const project = await api.openProject(id);
    const folderState = await api.getFolder();
    await api.releaseProject(id);
    return { reference: project.customReference, libraryId: project.libraryReferenceId, shared: folderState.folder.style.reference };
  }, projectId);
  assert.equal(result.libraryId, key);
  for (const ref of [result.reference, result.shared]) {
    for (const prop of ['id', 'title', 'venue', 'year', 'authors', 'paper', 'pdf_source']) assert.deepEqual(ref.citation[prop], original[prop], 'citation.' + prop);
  }
  const assets = [
    path.join(folder, '.mkfigure', 'projects', projectId, 'assets', path.basename(result.reference.path)),
    path.join(folder, '.mkfigure', path.basename(result.shared.file)),
  ];
  for (const file of assets) {
    const bytes = await fs.readFile(file);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const actual = await client.evaluate(({ nativeImage }, src) => nativeImage.createFromPath(src).getSize(), file);
    assert.equal(actual.width, original.w);
    assert.equal(actual.height, original.h);
  }
}
try {
  await launch();
  await size(1440);
  await selectFolder();
  await openGallery();
  await count(3449);
  assert.deepEqual(await decodeCardImages(5), ['iclr2023-0009','iclr2023-0022','iclr2023-0057','iclr2023-0068','iclr2023-0099']);
  await gallery.locator('.pg-top').scrollIntoViewIfNeeded();
  assert.equal(await gallery.locator('.pg-page').first().evaluate(el => getComputedStyle(el).columnCount), '4');
  await capture('gallery-1440');
  await size(960);
  await gallery.locator('.pg-top').scrollIntoViewIfNeeded();
  assert.equal(await gallery.locator('.pg-page').first().evaluate(el => getComputedStyle(el).columnCount), '3');
  await capture('gallery-960');
  await size(1440);
  const index = await page.evaluate(() => window.mkFigure.listPaperFigures());
  assert.equal(index.length, 3449);
  original = index.find(f => f.id === selectedId);
  assert.ok(original);
  const representatives = ['iclr','icml','neurips','cvpr','acl','aaai'].map(venue => index.find(record => record.venue === venue));
  assert.match(representatives.find(row => row.venue === 'cvpr').id, /_/);
  for (const row of representatives) {
    const decoded = await page.evaluate(async id => {
      const image = new Image(); image.src = 'mk-gallery://figure/' + encodeURIComponent(id);
      await image.decode(); return [image.naturalWidth, image.naturalHeight];
    }, row.id);
    assert.deepEqual(decoded, [row.w,row.h], row.id + ' local JPEG size');
  }
  await gallery.locator('.pg-guide summary').click();
  assert.ok(await gallery.locator('.pg-guide[open] dt').count() >= 6);
  await gallery.locator('.pg-guide summary').click();
  await gallery.getByRole('button', {name:/图片使用政策/}).click();
  assert.match((await client.evaluate(() => globalThis.paperSmokeOpened)).at(-1), /IMAGES_POLICY\.md$/);
  report.tests.push('3449 metadata records, all six venues including CVPR IDs, local image dimensions, masonry, guide and rights');

  await search().fill('iclr diffusion 2024'); await count(9);
  await search().fill('poole dreamfusion'); await count(1);
  await search().fill('qzxw9876543'); await count(0);
  await button(gallery, '清除筛选').click(); await count(3449);
  await chip('等级', /^口头报告/); await count(350);
  await chip('等级', /^焦点论文/); await count(678);
  await chip('等级', /^最佳论文/); await count(17);
  await chip('会议', /^ICLR/); await chip('年份', /^2024/); await chip('图型', /^主视觉/); await count(2);
  report.tests.push('multiword and author search, no results, award precedence, four concurrent filters');
  await cards().first().locator('.pg-preview').press('Enter');
  await detail().waitFor();
  assert.equal(await button(detail(), '上一张').isDisabled(), true);
  await page.keyboard.press('ArrowRight');
  await detail().getByRole('heading', { name: original.title, exact: true }).waitFor();
  assert.equal(await button(detail(), '下一张').isDisabled(), true);
  await detail().getByText('荣誉提名', {exact:true}).waitFor();
  await detail().getByText('口头报告', {exact:true}).waitFor();
  await detail().locator('.pg-stage img').evaluate(async img => { await img.decode(); });
  await button(detail(), '收藏').click();
  await button(detail(), '取消收藏').waitFor();
  const deep = await copyLink(button(detail(), '复制图链'));
  assert.equal(deep.hash, '#f=' + selectedId);
  for (const [param, value] of Object.entries({ v:'iclr', y:'2024', t:'best', p:'teaser' })) assert.equal(deep.searchParams.get(param), value);
  await detail().getByRole('button', { name:/^论文/ }).click();
  assert.equal((await client.evaluate(() => globalThis.paperSmokeOpened)).at(-1), original.paper);
  await capture('gallery-detail-1440');
  await size(960); await capture('gallery-detail-960'); await size(1440);
  await page.keyboard.press('Escape'); await detail().waitFor({ state:'hidden' });
  await button(gallery, '清除筛选').click(); await count(3449);
  await button(gallery, '打开链接').click();
  await gallery.getByRole('textbox', { name:'原图库分享链接' }).fill(deep.href);
  await button(gallery, '打开').click();
  await detail().getByRole('heading', { name: original.title }).waitFor(); await count(2);
  await page.keyboard.press('Escape');
  await detail().waitFor({ state:'hidden' });
  await button(gallery, '清除筛选').click(); await count(3449);
  await gallery.getByRole('combobox', { name:'排序' }).selectOption('title');
  assert.deepEqual((await decodeCardImages(3)), ['icml2026-0139','neurips2024-2150','iclr2024-1034']);
  await button(gallery, '切换为英文').click();
  await gallery.getByRole('heading', { name:'Conference figure gallery', exact:true }).waitFor();
  await button(gallery, 'Switch to Chinese').click();
  report.tests.push('gallery sort, accessible keyboard lightbox bounds, favorite, external paper link, share and restore, language');

  await gallery.getByRole('button', {name:/^返回(素材库|首页)?$/}).click();
  if (!(await page.locator('.library-grid:visible').count())) await button(page.getByRole('navigation', { name:'工作区导航' }), '图片素材库').click();
  const legacy = await page.evaluate(() => window.mkFigure.listLibrary());
  assert.ok(legacy.some(i => i.id === 'pastel-method'));
  assert.ok(legacy.some(i => i.category === 'icon'));
  const demo = path.join(runDir,'演示素材.svg');
  await fs.writeFile(demo, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect x="8" y="6" width="64" height="48" rx="5" fill="#28716b"/></svg>');
  await client.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[file]}); }, demo);
  await button(page.locator('.library-page:visible'), '导入图片').click();
  await page.getByRole('button', { name:'预览 演示素材', exact:true }).waitFor();
  report.tests.push('existing reference/icon library and isolated synthetic personal upload');

  await button(page.locator('.library-page:visible'), '返回首页').click();
  const choosePaper = async picker => {
    await button(picker, '从素材库选择').click();
    await button(page.locator('.library-page:visible'), '顶会主图库').click();
    await search().fill('kv cache compression model tells');
    await count(1);
    assert.deepEqual(await decodeCardImages(1), [selectedId]);
    await button(cards().first(), '用作风格参考').click();
    await gallery.waitFor({ state: 'hidden' });
  };
  await page.locator('.studio-header .shared-style-button').click();
  const sharedEditor = page.getByRole('dialog', {name:'统一风格', exact:true});
  await choosePaper(sharedEditor);
  await button(sharedEditor, '保存风格').click();
  await sharedEditor.waitFor({state:'hidden'});
  projectId = await page.evaluate(async () => {
    const p = await window.mkFigure.createProject('跨运行点响应示意图', 'full');
    await window.mkFigure.releaseProject(p.id);
    return p.id;
  });
  await page.locator('.folder-project-row > button').filter({hasText:'跨运行点响应示意图'}).click();
  const pane = page.locator('.pane-host:visible');
  await button(pane.getByRole('group',{name:'风格来源'}), '本图自定义').click();
  await choosePaper(pane);
  await pane.locator('.reference-selection').getByText(original.title, {exact:false}).first().waitFor();
  await checkReferences();
  await client.close(); client = null;
  await launch(); await size(1440);
  const restoredFolder = await page.evaluate(() => window.mkFigure.getFolder());
  assert.equal(await fs.realpath(restoredFolder.folder.path), await fs.realpath(folder));
  await checkReferences();
  assert.ok((await page.evaluate(() => window.mkFigure.listLibrary())).some(i => i.name === '演示素材' && i.source === 'user'));
  await openGallery(); await gallery.getByRole('button', { name:/只看收藏.*1/ }).click(); await count(1);
  assert.deepEqual(await decodeCardImages(1), [selectedId]);
  await capture('gallery-restart-favorite');
  report.tests.push('single and shared paper references, full PNGs and author citations, favorites and private import persist after restart');
  assert.deepEqual(pageErrors, [], 'renderer uncaught errors');
  await fs.writeFile(path.join(output,'smoke.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} catch (error) {
  if (page && !page.isClosed()) {
    console.error((await page.locator('body').innerText()).slice(-2500));
    await page.screenshot({path:path.join(output,'failure.png')}).catch(() => {});
  }
  throw error;
} finally {
  if (client) await client.close();
}
