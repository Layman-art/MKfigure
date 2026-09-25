import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const root=process.cwd(), tag=new Date().toISOString().replace(/[:.]/g,'-');
const data=path.join(root,'.runtime','delete-smoke',tag), out=path.join(root,'output','v0.2.1','deletion');
await fs.mkdir(out,{recursive:true});await fs.mkdir(path.join(data,'test-trash'),{recursive:true});
const env={...process.env,MK_FIGURE_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const client=await electron.launch({executablePath:process.env.MK_PACKAGED_EXE||electronPath,args:process.env.MK_PACKAGED_EXE?[]:[root],env,timeout:60000});
const errors=[];
try {
  const page=await client.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await client.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);win.restore();win.show();win.focus();});
  await page.getByRole('button',{name:/^新建科研图/}).waitFor();
  assert.equal(await page.getByRole('button',{name:/^离线示例/}).count(),0);
  assert.equal(await page.locator('.start-routes > button').count(),3);
  let exampleRemoved=false;try{await page.evaluate(()=>window.mkFigure.createProject('Removed sample','example'));}catch{exampleRemoved=true;}
  assert.ok(exampleRemoved);
  const keep=await page.evaluate(()=>window.mkFigure.createProject('保留作品（测试）','full'));
  const target=await page.evaluate(()=>window.mkFigure.createProject('删除流程验证（测试）','full'));
  const targetDir=await fs.realpath(path.join(data,'projects',target.id));
  const destination=path.join(await fs.realpath(path.join(data,'test-trash')),target.id);
  const keepBefore=await fs.readFile(path.join(data,'projects',keep.id,'project.json'));
  // Exercise the real IPC, confirmation and Store path checks. Simulate only the
  // OS recycle bin using an owned test folder; never touch real user projects.
  await client.evaluate(({dialog,shell},settings)=>{
    const fs=process.getBuiltinModule('node:fs/promises');
    globalThis.__mkDeleteTest={response:0,fail:false,confirmations:0,trashCalls:0};
    dialog.showMessageBox=async(_parent,options)=>{const state=globalThis.__mkDeleteTest;state.confirmations++;state.lastOptions=options;return {response:state.response};};
    shell.trashItem=async directory=>{
      const state=globalThis.__mkDeleteTest;state.trashCalls++;
      if(directory!==settings.targetDir)throw new Error('Unexpected test target');
      if(state.fail)throw new Error('模拟回收失败');
      await fs.rename(directory,settings.destination);
    };
  },{targetDir,destination});
  const waitConfirmation=async(count)=>{
    for(let i=0;i<100;i++){
      if(await client.evaluate(()=>globalThis.__mkDeleteTest.confirmations)>=count)return;
      await delay(25);
    }
    throw new Error('Confirmation was not shown');
  };
  await page.reload();await page.getByRole('button',{name:`删除 ${target.name}`,exact:true}).waitFor();
  await page.screenshot({path:path.join(out,'01-home.png')});
  assert.equal(await page.locator('.recent-item button button').count(),0);
  const remove=page.getByRole('button',{name:`删除 ${target.name}`,exact:true});
  await remove.click();await waitConfirmation(1);
  const cancelled=await client.evaluate(()=>globalThis.__mkDeleteTest);
  assert.equal(cancelled.trashCalls,0);assert.equal(cancelled.lastOptions.defaultId,0);
  assert.ok(cancelled.lastOptions.message.includes(target.name));
  await fs.access(targetDir);assert.equal(await page.locator('.welcome').count(),1);
  await client.evaluate(()=>{globalThis.__mkDeleteTest.response=1;globalThis.__mkDeleteTest.fail=true;});
  await remove.click();await page.getByRole('alert').filter({hasText:'模拟回收失败'}).waitFor();
  await fs.access(targetDir);assert.equal(await remove.count(),1);
  await client.evaluate(()=>{globalThis.__mkDeleteTest.fail=false;});
  await remove.click();await page.getByRole('status').filter({hasText:'已移入回收站'}).waitFor();
  assert.equal(await remove.count(),0);assert.equal(await page.locator('.recent-item').count(),1);
  await assert.rejects(fs.access(targetDir));await fs.access(path.join(destination,'project.json'));
  assert.deepEqual(await fs.readFile(path.join(data,'projects',keep.id,'project.json')),keepBefore);
  await page.screenshot({path:path.join(out,'02-deleted.png')});
  await page.reload();await page.getByRole('button',{name:`打开 ${keep.name}`,exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:`删除 ${target.name}`,exact:true}).count(),0);
  let rejected=false;try{await page.evaluate(()=>window.mkFigure.deleteProject('../outside'));}catch{rejected=true;}
  assert.ok(rejected);assert.deepEqual(errors,[]);
  const result={passed:true,entryCount:3,exampleRouteRemoved:exampleRemoved,cancelPreservesProject:true,recycleFailurePreservesProject:true,confirmedDeletionRefreshesList:true,deletedAfterReload:true,otherProjectUnchanged:true,unsafeIdRejected:true,simulatedRecycleBin:true,pageErrors:errors};
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await client.close();}
