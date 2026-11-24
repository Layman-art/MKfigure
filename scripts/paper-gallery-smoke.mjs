import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
const localOrigin = 'mkfigure://gallery/';
const publicOnly = process.env.MK_GALLERY_QA_PUBLIC === '1';
const cacheSource = process.env.MK_GALLERY_QA_CACHE;
assert.ok(!publicOnly || !cacheSource, 'public clean-install mode requires an empty isolated cache');
const seeded = new Set();
const pageErrors = [];
const report = { packaged: Boolean(packaged), tests: [], screenshots: [] };
let client, page, gallery, projectId, original, studyReference;
const button = (container, name) => container.getByRole('button', { name, exact: true });
const cards = () => gallery.locator('.pg-card');
const search = () => gallery.getByRole('searchbox');
const detail = () => gallery.locator('dialog[open]');

// Dev trees contain every full journal image. Recreate the public package's journal
// resources for this test while retaining the other read-only application resources.
let launchCwd=root;
if (publicOnly && !packaged) {
  launchCwd=runDir;
  const src=path.join(root,'resources'), dst=path.join(runDir,'resources');
  const mirror=async(relative,exclude)=>{
    const target=path.join(dst,relative);
    await fs.mkdir(target,{recursive:true});
    for(const item of await fs.readdir(path.join(src,relative),{withFileTypes:true})){
      if(exclude.has(item.name)) continue;
      const from=path.join(src,relative,item.name), to=path.join(target,item.name);
      if(relative==='' && ['library','references'].includes(item.name)) await fs.cp(from,to,{recursive:true});
      else if(item.isDirectory()) await fs.symlink(from,to,process.platform==='win32'?'junction':'dir');
      else await fs.copyFile(from,to);
    }
  };
  await mirror('',new Set(['paper-gallery']));
  await mirror('paper-gallery',new Set(['journals']));
  await mirror('paper-gallery/journals',new Set(['images']));
}
async function launch() {
  client = await electron.launch({ executablePath: packaged || electronPath, cwd: launchCwd, args: packaged ? [] : [root], env, timeout: 90000 });
  page = await client.firstWindow({timeout:30000});
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
async function size(width, height = 900) {
  await client.evaluate(({ BrowserWindow }, [w,h]) => BrowserWindow.getAllWindows()[0].setContentSize(w,h), [width,height]);
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
  await button(page.getByRole('navigation', { name: '工作区导航' }), '论文图库').click();
  await gallery.getByRole('heading', { name: '论文图库', exact: true }).waitFor();
}
async function count(expected) {
  await page.waitForFunction(n => Number(document.querySelector('.paper-gallery .pg-results b')?.textContent.replace(/\D/g, '')) === n, expected);
}
async function chip(group, pattern) {
  await gallery.getByRole('group', { name: group, exact: true }).getByRole('button', { name: pattern, exact: typeof pattern === 'string' }).click();
}
async function exerciseCountedChip(group, name, expected) {
  const control = gallery.getByRole('group', {name:group, exact:true}).getByRole('button', {name, exact:true});
  const badge = (await control.locator('small').innerText()).trim();
  assert.match(badge, /^[0-9,]+$/, group + ' / ' + name + ' count');
  assert.equal(Number(badge.replaceAll(',', '')), expected, group + ' / ' + name);
  assert.equal(await control.isDisabled(), expected === 0, group + ' / ' + name + ' availability');
  if (expected) {
    await control.click();
    await count(expected);
  }
}
async function decodeCardImages(n) {
  const result = [];
  for (let i = 0; i < n; i++) {
    const img = cards().nth(i).locator('.pg-preview img');
    await img.scrollIntoViewIfNeeded();
    const data = await img.evaluate(async e => { await e.decode(); return [e.currentSrc, e.naturalWidth, e.naturalHeight]; });
    const cardId = await cards().nth(i).getAttribute('data-paper-id');
    const url = new URL(data[0]);
    assert.equal(url.protocol, 'mk-gallery:');
    assert.equal(url.host, cardId.startsWith('mk-') ? 'thumbnail' : 'figure');
    assert.equal(decodeURIComponent(url.pathname.slice(1)), cardId);
    assert.ok(Math.min(data[1], data[2]) > 10, 'decoded local paper figure ' + data[0]);
    result.push(decodeURIComponent(data[0].split('/').at(-1)));
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
async function copyLink(control, base = origin) {
  await control.click();
  await detail().getByRole('status').filter({hasText:'已复制'}).waitFor();
  const link = await client.evaluate(() => globalThis.paperSmokeClipboard);
  assert.ok(link.startsWith(base), link);
  return new URL(link);
}
async function restoreLink(url) {
  await button(gallery, '打开链接').click();
  await gallery.getByRole('textbox', { name:'原图库分享链接' }).fill(url.href);
  await button(gallery, '打开').click();
  await detail().waitFor();
}
async function exerciseStudies(studies, venues) {
  const categories = { result:'算例结果图', mechanism:'机理解释图', algorithm:'算法图' };
  const dimensions = { '2d':'二维', '3d':'三维', mixed:'二维与三维混合' };
  const forms = {curve:'曲线图', bar:'柱状图', scatter:'散点图', distribution:'分布图', heatmap:'热图', field:'空间场', qualitative:'定性对照', surface:'三维曲面', pointcloud:'点云', volume:'体绘制', mesh:'网格'};
  const dimension = r => new Set(r.supplement.dimensions).size === 2 ? 'mixed' : r.supplement.dimensions?.[0];
  const results = studies.filter(r => r.supplement.category === 'result');
  const byId = new Map(studies.map(r => [r.id,r]));
  await button(gallery, '顶会算例与方法图').click();
  await count(studies.length);
  const more = gallery.getByRole('button', {name:/^加载更多/});
  while (await cards().count() < studies.length) {
    const before = await cards().count();
    try { await more.click({timeout:3000}); }
    catch (reason) { if (await cards().count() <= before) throw reason; }
    await cards().nth(before).waitFor();
  }
  const shown = await decodeCardImages(studies.length);
  assert.deepEqual(new Set(shown), new Set(byId.keys()), 'every study figure should render once from the app protocol');
  const coverage = [];
  for (const [key, label] of Object.entries(categories)) {
    await chip('会议', '全部');
    const batch = studies.filter(r => r.supplement.category === key);
    await exerciseCountedChip('图类', label, batch.length);
    assert.ok(batch.length, 'missing category ' + key);
    for (const venue of venues) {
      const local = batch.filter(r => r.venue === venue);
      assert.ok(local.length, 'missing study examples for ' + venue + ' / ' + key);
      await exerciseCountedChip('会议', new RegExp('^' + venue + '$', 'i'), local.length);
      const [id] = await decodeCardImages(1);
      assert.ok(local.some(r => r.id === id));
      coverage.push([key, venue]);
    }
  }
  await chip('会议', '全部');
  await chip('图类', categories.result);
  for (const [key,label] of Object.entries(dimensions)) {
    const matches = results.filter(r => dimension(r) === key);
    await exerciseCountedChip('展示维度', label, matches.length);
    assert.ok(matches.length, 'missing results for ' + key);
    const [id] = await decodeCardImages(1);
    assert.equal(dimension(byId.get(id)), key);
    if (key === '2d') {
      await cards().first().locator('.pg-preview').click();
      await detail().locator('.pg-stage img').evaluate(img => img.decode());
      await capture('studies-2d-detail-1440');
      await page.keyboard.press('Escape');
      await detail().waitFor({state:'hidden'});
    }
  }
  await chip('展示维度', '全部');
  for (const [key,label] of Object.entries(forms)) {
    await exerciseCountedChip('展示形式', label, results.filter(r => r.supplement.forms.includes(key)).length);
  }
  await chip('展示形式', '全部');
  const cvprResults = results.filter(r => r.venue === 'cvpr');
  await exerciseCountedChip('会议', /^CVPR$/, cvprResults.length);
  for (const [key,label] of Object.entries(dimensions)) {
    const matching = cvprResults.filter(row => dimension(row) === key);
    await exerciseCountedChip('展示维度', label, matching.length);
    if (!matching.length) continue;
    for (const [formKey,formLabel] of Object.entries(forms)) {
      await exerciseCountedChip('展示形式', formLabel, matching.filter(r => r.supplement.forms.includes(formKey)).length);
    }
    await chip('展示形式', '全部');
  }
  const threeD = cvprResults.filter(r => dimension(r) === '3d');
  await exerciseCountedChip('展示维度', dimensions['3d'], threeD.length);
  assert.ok(threeD.length, 'CVPR 3D figures unavailable');
  await count(threeD.length);
  await decodeCardImages(Math.min(threeD.length, 6));
  await size(1440, 1040);
  await gallery.locator('.pg-top').scrollIntoViewIfNeeded();
  await capture('studies-3d-overview-1440');
  await size(1440);
  const preferred = threeD.find(r => r.supplement.forms.includes('mesh')) || threeD[0];
  const form = preferred.supplement.forms.find(f => f === 'mesh') || preferred.supplement.forms[0];
  await chip('展示形式', forms[form]);
  const filtered = threeD.filter(r => r.supplement.forms.includes(form));
  await count(filtered.length);
  const [id] = await decodeCardImages(1);
  studyReference = byId.get(id);
  await cards().first().locator('.pg-preview').click();
  await detail().getByRole('heading',{name:studyReference.title,exact:true}).waitFor();
  const imgSize = await detail().locator('.pg-stage img').evaluate(async img => {
    await img.decode(); return [img.naturalWidth,img.naturalHeight];
  });
  assert.deepEqual(imgSize, [studyReference.w,studyReference.h]);
  await detail().getByText(studyReference.supplement.description,{exact:true}).waitFor();
  const pdf = detail().getByRole('button',{name:/^PDF/});
  const pdfLabel = await pdf.innerText();
  assert.ok(pdfLabel.includes(studyReference.figure) && pdfLabel.includes('第 ' + studyReference.page + ' 页'));
  const versionLabel = {'author-public':'作者公开版',proceedings:'论文集版'}[studyReference.supplement.pdfVersion];
  if (versionLabel) assert.ok(pdfLabel.includes(versionLabel));
  assert.ok(Number.isInteger(studyReference.page) && studyReference.page > 0);
  await pdf.click();
  const expected = new URL(studyReference.pdf_source);
  expected.hash = 'page=' + studyReference.page;
  assert.equal((await client.evaluate(() => globalThis.paperSmokeOpened)).at(-1), expected.href);
  await button(detail(),'收藏').click();
  await button(detail(),'取消收藏').waitFor();
  const deep = await copyLink(button(detail(),'复制图链'), localOrigin);
  for (const [k,v] of Object.entries({view:'study',category:'result',dimension:'3d',form,v:'cvpr'})) assert.equal(deep.searchParams.get(k),v);
  assert.equal(decodeURIComponent(deep.hash.slice(3)),id);
  await capture('studies-3d-detail-1440');
  await page.keyboard.press('Escape'); await detail().waitFor({state:'hidden'});
  await button(gallery, '论文主图').click();
  await restoreLink(deep);
  await detail().getByRole('heading',{name:studyReference.title,exact:true}).waitFor();
  await button(detail(),'取消收藏').waitFor();
  await count(filtered.length);
  await page.keyboard.press('Escape'); await detail().waitFor({state:'hidden'});
  report.tests.push('study collections, venue/category intersections, dimensions and plot types, full image, PDF page link, local share and restored filters');
  report.studyCoverage = { records: studies.length, byVenueAndCategory: coverage, chosenId:id, figure:studyReference.figure, page:studyReference.page };
  return deep;
}
// Read only catalogue-addressed image objects from the explicitly supplied cache directory.
async function seedImageCache(index) {
  if (!cacheSource) return;
  const from = await fs.realpath(cacheSource);
  const dest = path.join(profile,'gallery-images');
  await fs.mkdir(dest,{recursive:true});
  const mainHashes = JSON.parse(await fs.readFile(path.join(root,'resources/paper-gallery/data/image-hashes.json'),'utf8'));
  for (const row of index) {
    if(row.supplement?.collection==='journal' && row.id!=='mk-j-apenergy-a32f9383570f67-f1') continue;
    const hash = row.supplement?.sha256 || mainHashes[row.id];
    const ext = path.extname(row.image);
    if (!/^[a-f0-9]{64}$/.test(hash) || !/^\.(?:jpg|jpeg|png|webp)$/i.test(ext)) continue;
    const name = hash + ext;
    const source = path.join(from,name);
    try {
      const st = await fs.lstat(source);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 32*1024*1024) continue;
      const bytes = await fs.readFile(source);
      if (createHash('sha256').update(bytes).digest('hex') !== hash) continue;
      const target = path.join(dest,name);
      try { await fs.link(source,target); }
      catch (error) {
        if (error.code !== 'EEXIST') {
          if (!['EXDEV','EPERM','ENOTSUP','EINVAL','EACCES'].includes(error.code)) throw error;
          try { await fs.writeFile(target,bytes,{flag:'wx'}); } catch (copyError) { if (copyError.code !== 'EEXIST') throw copyError; }
        }
      }
      seeded.add(row.id);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(seeded.size,'source cache had no matching verified originals');
  report.seeded = seeded.size;
}
async function offline(enabled) {
  await client.evaluate(({session}, enabled) => {
    // Only this isolated Electron process and its in-memory scholarly-source session are affected.
    const sessions=[session.defaultSession,session.fromPartition('mkfigure-public-source-network')];
    for(const ses of sessions) {
      if(enabled) ses.enableNetworkEmulation({offline:true});
      else ses.disableNetworkEmulation();
    }
  },enabled);
}
async function exerciseJournals(rows) {
  await button(gallery,'期刊算例与方法图').click();
  await count(rows.length);
  const results=rows.filter(r=>r.supplement.category==='result');
  for (const [key,label] of Object.entries({algorithm:'算法图',mechanism:'机理解释图',result:'算例结果图'})) {
    const total=rows.filter(r=>r.supplement.category===key).length;
    assert.ok(total);
    await exerciseCountedChip('图类',label,total);
  }
  const dim=r=>r.supplement.dimensions?.length===2?'mixed':r.supplement.dimensions?.[0];
  for(const [key,label] of Object.entries({'2d':'二维','3d':'三维',mixed:'二维与三维混合'})) {
    const total=results.filter(r=>dim(r)===key).length;
    assert.ok(total);
    await exerciseCountedChip('展示维度',label,total);
  }
  await chip('展示维度','全部');
  const expand=gallery.getByRole('button',{name:/展开全部图型/});
  if(await expand.count()) await expand.click();
  const checked=[];
  for(const [key,label] of Object.entries({curve:'曲线图',heatmap:'热图',timeseries:'时序响应',ecdf:'累积分布',ternary:'三元图',pareto:'帕累托前沿',violin:'小提琴图',polar:'极坐标图'})) {
    const total=results.filter(r=>r.supplement.forms?.includes(key)).length;
    if(total) {await exerciseCountedChip('展示形式',label,total);checked.push(key);}
  }
  assert.ok(checked.length>=5,'expected common and rare journal plot types');
  await button(gallery,'清除筛选').click();
  const row=rows.find(r=>r.id==='mk-j-apenergy-a32f9383570f67-f1');
  assert.ok(row?.doi && row.figure && row.supplement.archive,'expected released PMC journal figure');
  const query=row.doi+' '+row.figure;
  await search().fill(query);
  const card=gallery.locator('[data-paper-id="'+row.id+'"]');
  const preview=card.locator('.pg-preview img');
  await preview.evaluate(async img=>{await img.decode();if(!img.currentSrc.startsWith('mk-gallery://thumbnail/'))throw Error('expected thumbnail');});
  const cachedNames=async()=>fs.readdir(path.join(profile,'gallery-images')).catch(err=>{if(err.code==='ENOENT')return [];throw err;});
  if(publicOnly) assert.ok(!(await cachedNames()).some(n=>n.startsWith(row.supplement.sha256+'.')),'browsing thumbnails fetched the original');
  await card.locator('.pg-preview').click();
  await detail().getByRole('heading',{name:row.title,exact:true}).waitFor();
  await detail().getByText(new RegExp(row.doi.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))).waitFor();
  const pixels=await detail().locator('.pg-stage img').evaluate(async img=>{await img.decode();return [img.currentSrc,img.naturalWidth,img.naturalHeight];},{},{timeout:120000});
  assert.equal(new URL(pixels[0]).host,'figure');assert.ok(Math.min(...pixels.slice(1))>100);
  if(publicOnly) {
    const name=(await cachedNames()).find(n=>n===row.supplement.sha256+path.extname(row.image) || n===row.supplement.sha256+'.rendered');
    assert.ok(name,'public installation must fetch and cache the selected original');
    report.publicSource=name.endsWith('.rendered')?'scholarly origin':'verified open archive';
  }
  const deep=await copyLink(button(detail(),'复制图链'),localOrigin);
  assert.equal(deep.searchParams.get('view'),'journal');assert.equal(deep.searchParams.get('q'),query);
  assert.equal(decodeURIComponent(deep.hash.slice(3)),row.id);
  await capture(publicOnly?'journals-public-detail':'journals-offline-detail');
  await page.keyboard.press('Escape');await detail().waitFor({state:'hidden'});
  await button(gallery,'论文主图').click();await restoreLink(deep);
  await detail().getByRole('heading',{name:row.title,exact:true}).waitFor();
  await page.keyboard.press('Escape');await detail().waitFor({state:'hidden'});
  report.journals={records:rows.length,forms:checked,query,reference:row.id,pixels:pixels.slice(1),mode:publicOnly?'clean public':'offline'};
  return {deep,row,pixels:pixels.slice(1)};
}
async function readProjectFile() {
  const filename = path.join(folder,'.mkfigure','projects',projectId,'project.json');
  return JSON.parse(await fs.readFile(filename,'utf8'));
}
function verifyLayout(plan, refs) {
  assert.deepEqual(plan?.referenceIds, refs.map(row => row.id));
  assert.equal(plan.citations?.length, refs.length);
  for (const [i,row] of refs.entries()) {
    for (const field of ['id','title','authors','venue','year','paper','pdf_source','figure','page']) {
      assert.deepEqual(plan.citations[i][field], row[field], row.id + ' layout citation.' + field);
    }
  }
}
async function exerciseLayoutPicker(pane, studies) {
  const first = studies.find(a => studies.some(b => b.paper === a.paper && b.figure !== a.figure && b.page !== a.page));
  const refs = first ? [first, studies.find(b => b.paper === first.paper && b.figure !== first.figure && b.page !== first.page)] : studies.slice(0,2);
  assert.equal(new Set(refs.map(row => row.id)).size, 2);
  assert.ok(refs.every(row => row.figure && Number.isInteger(row.page) && row.page > 0));
  const planner = pane.locator('details.mk-layout-planner');
  if (!await planner.evaluate(element => element.open)) await planner.locator('summary').click();
  const open = button(planner, '从图库选版式参考');
  const picker = page.getByRole('dialog', {name:'从图库选版式参考',exact:true});
  const initial = (await readProjectFile()).brief.layoutPlan;
  await open.click(); await picker.waitFor();
  await button(picker, '返回').click(); await picker.waitFor({state:'hidden'});
  assert.equal(await planner.locator('.mk-layout-picked li').count(), 0);
  assert.deepEqual((await readProjectFile()).brief.layoutPlan, initial, 'cancel should leave the project layout intact');
  for (const row of refs) {
    await open.click(); await picker.waitFor();
    await button(picker, '顶会算例与方法图').click();
    await picker.getByRole('searchbox').fill(row.title);
    const selector = await page.evaluate(id => '[data-paper-id="' + CSS.escape(id) + '"]', row.id);
    const card = picker.locator(selector);
    await card.locator('.pg-preview img').evaluate(img => img.decode());
    await button(card, '用作版式参考').click();
    await picker.waitFor({state:'hidden'});
    await planner.locator('.mk-layout-picked li').filter({hasText:row.title + ' · ' + row.figure}).waitFor();
  }
  assert.equal(await planner.locator('.mk-layout-picked li').count(), refs.length);
  const until = Date.now() + 15000;
  let plan;
  do {
    plan = (await readProjectFile()).brief.layoutPlan;
    if (plan?.referenceIds?.length === refs.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  verifyLayout(plan, refs);
  report.tests.push('cancel layout picker; select two distinct study figures into project layout and verify persisted figure-level citations');
  report.layoutReferences = refs.map(({id,figure,page}) => ({id,figure,page}));
  return refs;
}
async function checkReferences(expectedProject = original) {
  const result = await page.evaluate(async id => {
    const api = window.mkFigure;
    const project = await api.openProject(id);
    const folderState = await api.getFolder();
    await api.releaseProject(id);
    return { reference: project.customReference, libraryId: project.libraryReferenceId, shared: folderState.folder.style.reference };
  }, projectId);
  assert.equal(result.libraryId, 'paper:' + expectedProject.id);
  for (const [ref, expected] of [[result.reference, expectedProject], [result.shared, original]]) {
    for (const prop of ['id', 'title', 'venue', 'year', 'authors', 'paper', 'pdf_source', 'figure', 'page']) assert.deepEqual(ref.citation[prop], expected[prop], 'citation.' + prop);
  }
  const assets = [
    path.join(folder, '.mkfigure', 'projects', projectId, 'assets', path.basename(result.reference.path)),
    path.join(folder, '.mkfigure', path.basename(result.shared.file)),
  ];
  for (const [idx, file] of assets.entries()) {
    const expected = idx === 0 ? expectedProject : original;
    const bytes = await fs.readFile(file);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const actual = await client.evaluate(({ nativeImage }, src) => nativeImage.createFromPath(src).getSize(), file);
    assert.equal(actual.width, expected.w);
    assert.equal(actual.height, expected.h);
  }
}
try {
  await launch();
  await size(1440);
  await selectFolder();
  const index = await page.evaluate(() => window.mkFigure.listPaperFigures());
  await seedImageCache(index);
  await openGallery();
  const journals = index.filter(row=>row.supplement?.collection==='journal');
  assert.ok(journals.length);
  const main = index.filter(row => !row.supplement || row.supplement.category === 'main');
  const studies = index.filter(row => row.supplement && !row.supplement.collection && row.supplement.category !== 'main');
  assert.ok(main.length && studies.length);
  assert.equal(new Set(index.map(row => row.id)).size, index.length);
  const venues = ['iclr','icml','neurips','cvpr','acl','aaai'];
  const defaultOrder = (a,b) => venues.indexOf(a.venue) - venues.indexOf(b.venue) || a.year-b.year || a.id.localeCompare(b.id);
  const titleOrder = (a,b) => a.title.localeCompare(b.title);
  const tier = row => row.award ? 'best' : row.tier;
  if(publicOnly) {
    const pick=await exerciseJournals(journals);
    await gallery.getByRole('button',{name:/^返回/}).first().click();
    await button(page.getByRole('navigation',{name:'工作区导航'}),'首页').click();
    await page.locator('.studio-header .shared-style-button').click();
    const editor=page.getByRole('dialog',{name:'统一风格',exact:true});
    await button(editor,'从素材库选择').click();await button(page.locator('.library-page:visible'),'论文图库').click();
    await restoreLink(pick.deep);await button(detail(),'用作风格参考').click();
    await button(editor,'保存风格').click();await editor.waitFor({state:'hidden'});
    const shared=await page.evaluate(async()=>(await window.mkFigure.getFolder()).folder.style.reference);
    assert.equal(shared.citation.id,pick.row.id);assert.equal(shared.citation.doi,pick.row.doi);
    assert.equal((await fs.stat(path.join(folder,'.mkfigure',path.basename(shared.file)))).isFile(),true);
    report.tests.push('clean profile journal query, bundled preview, public original and shared style selection');
  } else {
  await count(main.length);
  assert.deepEqual(await decodeCardImages(5), [...main].sort(defaultOrder).slice(0,5).map(row => row.id));
  await gallery.locator('.pg-top').scrollIntoViewIfNeeded();
  assert.equal(await gallery.locator('.pg-page').first().evaluate(el => getComputedStyle(el).columnCount), '4');
  await capture('gallery-1440');
  await size(960);
  await gallery.locator('.pg-top').scrollIntoViewIfNeeded();
  assert.equal(await gallery.locator('.pg-page').first().evaluate(el => getComputedStyle(el).columnCount), '3');
  await capture('gallery-960');
  await size(1440);
  original = index.find(f => f.id === selectedId);
  assert.ok(original);
  const representatives = venues.map(venue => main.find(row => row.venue === venue && (venue !== 'cvpr' || row.id.includes('_'))));
  assert.ok(representatives.every(Boolean));
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
  report.tests.push('main gallery records, all six venues including CVPR IDs, local image dimensions, masonry, guide and rights');

  for (const q of ['iclr diffusion 2024', 'poole dreamfusion']) {
    await search().fill(q);
    const expected = main.filter(r => q.split(' ').every(term => [r.title, ...r.authors, r.year, r.venue, r.supplement?.description].join(' ').toLowerCase().includes(term)));
    assert.ok(expected.length);
    await count(expected.length);
  }
  await search().fill('qzxw9876543'); await count(0);
  await button(gallery, '清除筛选').click(); await count(main.length);
  await chip('等级', /^口头报告/); await count(main.filter(r => tier(r) === 'oral').length);
  await chip('等级', /^焦点论文/); await count(main.filter(r => tier(r) === 'spotlight').length);
  await chip('等级', /^最佳论文/); await count(main.filter(r => tier(r) === 'best').length);
  const filtered = main.filter(r => r.venue === 'iclr' && r.year === 2024 && r.pattern === 'teaser' && tier(r) === 'best').sort(defaultOrder);
  await chip('会议', /^ICLR/); await chip('年份', /^2024/); await chip('图型', /^主视觉/); await count(filtered.length);
  report.tests.push('multiword and author search, no results, award precedence, four concurrent filters');
  await cards().first().locator('.pg-preview').press('Enter');
  await detail().waitFor();
  assert.equal(await button(detail(), '上一张').isDisabled(), true);
  for (const row of filtered.slice(1)) {
    await page.keyboard.press('ArrowRight');
    await detail().getByRole('heading', {name:row.title, exact:true}).waitFor();
  }
  assert.equal(await button(detail(), '下一张').isDisabled(), true);
  const at = filtered.findIndex(row => row.id === selectedId);
  assert.notEqual(at, -1);
  for (let i = filtered.length - 1; i > at; i--) await page.keyboard.press('ArrowLeft');
  await detail().getByRole('heading', { name: original.title, exact: true }).waitFor();
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
  await button(gallery, '清除筛选').click(); await count(main.length);
  await button(gallery, '打开链接').click();
  await gallery.getByRole('textbox', { name:'原图库分享链接' }).fill(deep.href);
  await button(gallery, '打开').click();
  await detail().getByRole('heading', { name: original.title }).waitFor(); await count(filtered.length);
  await page.keyboard.press('Escape');
  await detail().waitFor({ state:'hidden' });
  await button(gallery, '清除筛选').click(); await count(main.length);
  await gallery.getByRole('combobox', { name:'排序' }).selectOption('title');
  assert.deepEqual((await decodeCardImages(3)), [...main].sort(titleOrder).slice(0,3).map(row => row.id));
  await button(gallery, '切换为英文').click();
  await gallery.getByRole('heading', { name:'Paper figure gallery', exact:true }).waitFor();
  await button(gallery, 'Switch to Chinese').click();
  report.tests.push('gallery sort, accessible keyboard lightbox bounds, favorite, external paper link, share and restore, language');

  const studyDeep = await exerciseStudies(studies, venues);
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
    await button(page.locator('.library-page:visible'), '论文图库').click();
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
  await button(pane, '从素材库选择').click();
  await button(page.locator('.library-page:visible'), '论文图库').click();
  await restoreLink(studyDeep);
  await button(detail(), '用作风格参考').click();
  await gallery.waitFor({state:'hidden'});
  await pane.locator('.reference-selection').getByText(studyReference.title, {exact:false}).first().waitFor();
  await checkReferences(studyReference);
  await offline(true);
  await button(pane,'从素材库选择').click();await button(page.locator('.library-page:visible'),'论文图库').click();
  const journal=await exerciseJournals(journals);
  await restoreLink(journal.deep);await button(detail(),'用作风格参考').click();
  await gallery.waitFor({state:'hidden'});
  const savedJournal=await readProjectFile();
  assert.equal(savedJournal.customReference.citation.doi,journal.row.doi);
  assert.equal(savedJournal.customReference.citation.figure,journal.row.figure);
  await checkReferences({...journal.row,w:journal.pixels[0],h:journal.pixels[1]});
  report.tests.push('journal filters, DOI with figure number, restorable deep link, offline original and project style adoption');
  await offline(false);
  const layoutReferences = await exerciseLayoutPicker(pane, studies);
  await client.close(); client = null;
  await launch(); await size(1440);
  const restoredFolder = await page.evaluate(() => window.mkFigure.getFolder());
  assert.equal(await fs.realpath(restoredFolder.folder.path), await fs.realpath(folder));
  await checkReferences({...journal.row,w:journal.pixels[0],h:journal.pixels[1]});
  verifyLayout((await readProjectFile()).brief.layoutPlan, layoutReferences);
  assert.ok((await page.evaluate(() => window.mkFigure.listLibrary())).some(i => i.name === '演示素材' && i.source === 'user'));
  await openGallery(); await gallery.getByRole('button', { name:/只看收藏/ }).click(); await count(1);
  assert.deepEqual(await decodeCardImages(1), [selectedId]);
  await capture('gallery-restart-favorite');
  await button(gallery, '顶会算例与方法图').click();
  const fav = gallery.getByRole('button', {name:/只看收藏/});
  if (await fav.getAttribute('aria-pressed') !== 'true') await fav.click();
  await count(1);
  assert.deepEqual(await decodeCardImages(1), [studyReference.id]);
  report.tests.push('single and shared paper references, full PNGs and author citations, favorites and private import persist after restart');
  }
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
  if (client) {
    const child=client.process();
    const guard=setTimeout(()=>{if(child.exitCode===null) child.kill();},8000);
    try { await client.close(); } finally { clearTimeout(guard); }
  }
}
