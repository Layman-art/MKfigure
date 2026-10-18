import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = path.join(root, '.runtime', 'folder-sidebar', String(Date.now()));
const output = path.join(root, 'output', 'folder-sidebar', process.env.MK_PACKAGED_EXE ? 'packaged' : 'desktop');
const folderA = path.join(data, '论文插图');
const folderB = path.join(data, '组会汇报');
for (const dir of [folderA, folderB, output]) await fs.mkdir(dir, { recursive: true });
for (const dir of [folderA, folderB]) await fs.writeFile(path.join(dir, 'keep.txt'), 'User file: keep intact.');
const env = { ...process.env, MK_FIGURE_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
let client, page;
const errors = [];
const snapshot = async dir => {
  const result = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name);
      result[path.relative(dir, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  return result;
};
const launch = async () => {
  client = await electron.launch({ executablePath: process.env.MK_PACKAGED_EXE || electronPath, args: process.env.MK_PACKAGED_EXE ? [] : [root], cwd: root, env, timeout: 60000 });
  page = await client.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.workspace-folder-list').waitFor();
  await client.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 900); win.webContents.setBackgroundThrottling(false); });
};
const idle = () => page.locator('.studio-switching').waitFor({ state: 'hidden' });
const open = async dir => {
  await client.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, dir);
  await page.getByRole('button', { name: '打开文件夹', exact: true }).click();
  await page.waitForFunction(name => document.querySelector('.active-folder strong')?.textContent === name, path.basename(dir));
  await idle();
};
const remove = async name => {
  await page.getByRole('button', { name: `从侧栏移除 ${name}`, exact: true }).click();
  await page.getByRole('button', { name: `打开文件夹 ${name}`, exact: true }).waitFor({ state: 'hidden' });
  await idle();
};
const screenshot = async name => {
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, `${name}.png`) });
};
try {
  await launch();
  await page.locator('.workspace-empty').waitFor();
  assert.equal(await page.getByRole('button', { name: '单图创作', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '旧版本地作品', exact: true }).count(), 0);
  const noFolder = await page.evaluate(async () => {
    try { await window.mkFigure.createProject('must reject', 'full'); return false; }
    catch (error) { return String(error).includes('请先打开'); }
  });
  assert.equal(noFolder, true);
  await screenshot('01-open-folder');
  await open(folderA);
  await page.locator('.studio-navigation').getByRole('button', { name: '单图创作', exact: true }).click();
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByRole('textbox', { name: '项目名称', exact: true }).fill('神经 ODE 方法图');
  await page.getByRole('textbox', { name: '项目名称', exact: true }).press('Enter');
  await page.locator('textarea.composer:visible').fill('切换前尚未等待自动保存的草稿');
  await open(folderB);
  const stateA = JSON.parse(await fs.readFile(path.join(folderA, '.mkfigure', 'workspace.json'), 'utf8'));
  const projectIds = await fs.readdir(path.join(folderA, '.mkfigure', 'projects'));
  const projectFile = path.join(folderA, '.mkfigure', 'projects', projectIds[0], 'project.json');
  assert.equal(JSON.parse(await fs.readFile(projectFile, 'utf8')).brief.topic, '切换前尚未等待自动保存的草稿');
  await page.getByRole('button', { name: '打开文件夹 论文插图', exact: true }).click(); await idle();
  await page.waitForFunction(() => document.querySelector('.active-folder strong')?.textContent === '论文插图');
  assert.equal(await page.locator('.folder-project-row').count(), 1);
  await screenshot('02-folder-list');
  const beforeB = await snapshot(folderB);
  await remove('组会汇报');
  assert.deepEqual(await snapshot(folderB), beforeB);
  assert.equal((await page.evaluate(() => window.mkFigure.getFolder())).folder.path, await fs.realpath(folderA));
  const beforeA = await snapshot(folderA);
  await remove('论文插图');
  await page.locator('.workspace-empty').waitFor();
  assert.deepEqual(await snapshot(folderA), beforeA);
  await client.close(); await launch();
  await page.locator('.workspace-empty').waitFor();
  assert.equal(await page.locator('.workspace-folder').count(), 0);
  await open(folderA);
  assert.equal(await page.locator('.folder-project-row').count(), 1);
  assert.equal((await page.evaluate(() => window.mkFigure.getFolder())).folder.id, stateA.id);
  assert.deepEqual(await snapshot(folderA), beforeA);
  await open(folderB);
  await client.close(); await launch();
  await page.waitForFunction(() => document.querySelector('.active-folder strong')?.textContent === '组会汇报');
  assert.equal(await page.locator('.workspace-folder').count(), 2);
  await page.getByRole('button', { name: '打开文件夹 论文插图', exact: true }).click(); await idle();
  await page.locator('.folder-project-row > button').first().click();
  assert.equal(await page.locator('textarea.composer:visible').inputValue(), '切换前尚未等待自动保存的草稿');
  await screenshot('03-restored-project');
  assert.deepEqual(errors, []);
  const results = { passed: true, packaged: !!process.env.MK_PACKAGED_EXE, emptyStart: true, multipleFolders: true, pendingDraftFlushed: true, removalPreservesAllFileHashes: true, removedEntriesStayRemovedAfterRestart: true, reopenedProjectRestored: true, lastFolderRestoredAfterRestart: true, liveModelCalls: 0, pageErrors: errors };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally { await client?.close().catch(() => {}); }
