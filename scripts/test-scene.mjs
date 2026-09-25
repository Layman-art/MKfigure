// Test-only fixture; the installed application does not expose a sample route.
import { build } from 'esbuild';
import path from 'node:path';
const result = await build({ entryPoints:[path.join(import.meta.dirname,'../tests/fixtures/example-scene.ts')],bundle:true,write:false,platform:'node',format:'esm' });
const { EXAMPLE_SCENE } = await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));

export async function seedTestScene(page, name = '科研图验证样例') {
  const project = await page.evaluate(async ({name,scene}) => {
    const created=await window.mkFigure.createProject(name,'full');
    created.brief.topic='Neural ODE 测试图';created.brief.language='en';
    await window.mkFigure.saveProject(created);
    return window.mkFigure.renderScene(created.id,scene);
  }, {name,scene:EXAMPLE_SCENE});
  await page.reload();
  await page.getByRole('button',{name:`打开 ${name}`,exact:true}).first().click();
  await page.getByRole('img',{name:'可编辑科研图预览'}).waitFor();
  return project;
}
