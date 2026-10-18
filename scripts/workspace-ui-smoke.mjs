import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const output = path.join(root, 'output', 'workspace', version, process.env.MK_PACKAGED_EXE ? 'packaged' : 'desktop');
await fs.mkdir(output, { recursive: true });
const data = path.join(root, '.runtime', 'workspace-ui', String(Date.now()));
const folderPath = path.join(data, 'My Research');
const initialFolder = path.join(data, 'Initial Research');
await fs.mkdir(folderPath, { recursive: true });
await fs.mkdir(initialFolder, { recursive: true });
const env = { ...process.env, MK_FIGURE_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
const client = await electron.launch({ executablePath: process.env.MK_PACKAGED_EXE || electronPath, args: process.env.MK_PACKAGED_EXE ? [] : [root], cwd: root, env, timeout: 60000 });
const errors = [];
try {
  const page = await client.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.workspace-empty').waitFor();
  await client.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, initialFolder);
  await page.getByRole('button', { name: '打开创作文件夹', exact: true }).click();
  await page.locator('.studio-home').waitFor();
  await page.waitForFunction(() => document.querySelector('.active-folder strong')?.textContent !== '正在载入');
  await client.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.setContentSize(1440, 900); });
  const screenshot = async name => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(output, `${name}.png`) }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); };
  await screenshot('01-home');
  assert.equal((await client.windows()).length, 1);
  assert.equal(await page.locator('.pane-host').count(), 6);
  await page.locator('.studio-route').filter({ hasText: '并行创作' }).click();
  await page.locator('.creation-card').first().waitFor();
  assert.equal(await page.locator('.creation-card:visible').count(), 6);
  assert.equal(await page.getByRole('button', { name: /开始就绪/ }).count(), 0);
  await screenshot('02-six-panes');
  const layout = await page.locator('.creation-card').evaluateAll(cards => cards.map(card => { const r = card.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }));
  assert.ok(layout.every(card => card.bottom <= 900 && card.right <= 1440));
  assert.equal(new Set(layout.map(card => Math.round(card.top))).size, 2);
  const pane = index => page.locator(`.pane-host[data-pane-id="pane-${index + 1}"]`);
  const files = ['references/pastel-method.png', 'references/algorithm-flow.png', 'references/voltage-control.png', 'library/thumbs/icon-city-communication-tower.png', 'library/thumbs/icon-city-mobile-storage.png', 'references/pastel-method.png'];
  for (let index = 0; index < 6; index++) {
    await client.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(root, 'resources', files[index]));
    await pane(index).getByRole('button', { name: '上传图片', exact: true }).click();
    await pane(index).locator('.creation-preview img').waitFor();
    await pane(index).getByRole('textbox', { name: '主题与内容', exact: true }).fill(`科研图 ${index + 1}：独立内容`);
  }
  await screenshot('03-six-images');
  await pane(2).getByRole('button', { name: '展开子窗口 3', exact: true }).click();
  assert.equal(await page.locator('.pane-host').count(), 6);
  assert.equal(await page.locator('.pane-host:visible').count(), 1);
  await screenshot('04-expanded');
  await page.getByRole('button', { name: '六窗总览', exact: true }).click();
  assert.equal(await pane(2).getByRole('textbox', { name: '主题与内容', exact: true }).inputValue(), '科研图 3：独立内容');
  await page.locator('.studio-header').getByRole('button', { name: '统一风格', exact: true }).click();
  await page.getByRole('textbox', { name: '风格描述', exact: true }).fill('白色背景，蓝灰色学术风格，细线条');
  await page.getByLabel('配色', { exact: true }).fill('蓝灰 + 橙色强调');
  await screenshot('05-shared-style');
  await page.getByRole('button', { name: '保存风格', exact: true }).click();
  await page.locator('.shared-style-panel').waitFor({ state: 'hidden' });
  const savedStyle = await page.evaluate(() => window.mkFigure.getFolder());
  assert.equal(savedStyle.folder.style.palette, '蓝灰 + 橙色强调');
  await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(960, 700));
  await screenshot('06-small-screen');
  await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await client.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.locator('.studio-switching').waitFor({ state: 'hidden' });
  const localProjects = await Promise.all((await fs.readdir(path.join(initialFolder, '.mkfigure', 'projects'))).map(async id => JSON.parse(await fs.readFile(path.join(initialFolder, '.mkfigure', 'projects', id, 'project.json'), 'utf8'))));
  await page.evaluate(async projects => {
    for (const project of projects) {
      const index = Number(project.brief.topic.match(/科研图 (\d+)/)[1]) - 1;
      await window.mkFigure.panes[index].saveProject(project);
    }
  }, localProjects);
  await client.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folderPath);
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.active-folder strong')?.textContent === 'My Research');
  await page.locator('.studio-route').filter({ hasText: '单图创作' }).click();
  await page.getByRole('textbox', { name: '项目名称', exact: true }).waitFor();
  await screenshot('07-single-folder');
  const beforeReopen = await page.evaluate(() => window.mkFigure.getFolder());
  const folderProjectId = beforeReopen.folder.projects[0].id;
  // Reopening or cancelling the folder picker must retain the live project lease.
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.locator('.studio-switching').waitFor({ state: 'hidden' });
  await page.getByRole('textbox', { name: '项目名称', exact: true }).waitFor();
  await page.evaluate(async id => { const project = await window.mkFigure.panes[0].openProject(id); await window.mkFigure.panes[0].saveProject(project); }, folderProjectId);
  await client.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.locator('.studio-switching').waitFor({ state: 'hidden' });
  await page.evaluate(async id => { const project = await window.mkFigure.panes[0].openProject(id); await window.mkFigure.panes[0].saveProject(project); }, folderProjectId);
  await client.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  // A is open in pane 1; B is an unopened sidebar-only project. Deleting B must not release A.
  await page.evaluate(async () => { const project = await window.mkFigure.panes[5].createProject('待删除作品 B', 'full'); await window.mkFigure.panes[5].releaseProject(project.id); });
  const unopenedDeletion = page.getByRole('button', { name: '删除 待删除作品 B', exact: true });
  await unopenedDeletion.focus(); await unopenedDeletion.click();
  await unopenedDeletion.waitFor({ state: 'hidden' });
  await page.evaluate(async id => { const project = await window.mkFigure.panes[0].openProject(id); await window.mkFigure.panes[0].saveProject(project); }, folderProjectId);
  assert.equal(await page.getByRole('textbox', { name: '项目名称', exact: true }).inputValue(), '未命名科研图');
  // Copy the complete workspace, retaining its ID. An old-pane pending draft belongs only to the old path.
  const copyPath = path.join(data, 'Copied Research');
  await fs.cp(folderPath, copyPath, { recursive: true });
  const copiedManifest = JSON.parse(await fs.readFile(path.join(copyPath, '.mkfigure', 'workspace.json'), 'utf8'));
  assert.equal(copiedManifest.id, beforeReopen.folder.id);
  await pane(0).locator('textarea.composer').fill('仅保存在原文件夹的未提交草稿');
  await client.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, copyPath);
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.active-folder strong')?.textContent === 'Copied Research');
  await page.locator('.studio-route').filter({ hasText: '并行创作' }).click();
  assert.equal(await page.locator('.creation-card:visible').count(), 6);
  assert.equal(await page.locator('.creation-card .creation-empty:visible').count(), 6);
  // Observe past the renderer autosave debounce to catch stale writes after unmount.
  await page.waitForTimeout(800);
  const originalProject = JSON.parse(await fs.readFile(path.join(folderPath, '.mkfigure', 'projects', folderProjectId, 'project.json'), 'utf8'));
  const copiedProject = JSON.parse(await fs.readFile(path.join(copyPath, '.mkfigure', 'projects', folderProjectId, 'project.json'), 'utf8'));
  assert.equal(originalProject.brief.topic, '仅保存在原文件夹的未提交草稿');
  assert.equal(copiedProject.brief.topic, '');
  await screenshot('08-copied-folder');
  await page.locator('.folder-project-row > button').first().click();
  await page.getByRole('textbox', { name: '项目名称', exact: true }).waitFor();
  const deletion = page.locator('.folder-project-delete').first();
  await deletion.focus(); await deletion.click();
  await page.waitForFunction(() => document.querySelectorAll('.folder-project-row').length === 0);
  await page.locator('.studio-navigation').getByRole('button', { name: '首页', exact: true }).click();
  await page.getByRole('button', { name: '打开文件夹 Initial Research', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.folder-project-row').length === 6);
  const manifest = JSON.parse(await fs.readFile(path.join(folderPath, '.mkfigure', 'workspace.json'), 'utf8'));
  assert.ok(manifest);
  assert.deepEqual(errors, []);
  const results = { passed: true, packaged: !!process.env.MK_PACKAGED_EXE, executable: process.env.MK_PACKAGED_EXE || electronPath, installedOverUserApp: false, nativeWindows: 1, panes: 6, threeByTwoAt1440: true, styleSaved: true, folderSwitchSavedDrafts: true, reopenAndCancelKeepLease: true, sidebarDelete: true, unopenedDeleteKeepsActiveLease: true, copiedWorkspaceIdUsesPathIsolation: true, copiedFolderResetsSixPanes: true, singleAndParallelSeparated: true, expandedPreservedPanes: true, pageErrors: errors, liveModelCalls: 0 };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} catch (error) {
  const page = (await client.windows())[0]; if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally { await client.close().catch(() => {}); }
