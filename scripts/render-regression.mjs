// Isolated Electron process: validates full SVG output independently of monitor size.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import electron from 'electron';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'output', 'render-regression');
await mkdir(out, { recursive: true });
const source = `
import { app, nativeImage } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderSvgPng } from ${JSON.stringify(join(root, 'src/main/render.ts'))};
const out=${JSON.stringify(out)};
app.setPath('userData',join(out,'isolated-user-data'));
app.on('window-all-closed',()=>{});
await app.whenReady();
const results=[];
try {
for(const [width,height] of [[3000,2000],[2000,3000],[4096,1280],[1280,4096],[320,200]]) {
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'"><rect width="100%" height="100%" fill="white"/><rect width="80" height="80" fill="#ff0000"/><rect x="'+(width-80)+'" width="80" height="80" fill="#00ff00"/><rect y="'+(height-80)+'" width="80" height="80" fill="#0000ff"/><rect x="'+(width-80)+'" y="'+(height-80)+'" width="80" height="80" fill="#ff00ff"/><text x="100" y="120" font-family="Times New Roman" font-size="60">Full SVG viewport</text></svg>';
 const png=await renderSvgPng(svg,width,height);
 await writeFile(join(out,width+'x'+height+'.png'),png);
 const image=nativeImage.createFromBuffer(png),size=image.getSize(),pixels=image.toBitmap();
 const at=(x,y)=>{const i=(y*size.width+x)*4;return [pixels[i+2],pixels[i+1],pixels[i]];};
 const corners=[at(20,20),at(width-20,20),at(20,height-20),at(width-20,height-20)];
 const expected=[[255,0,0],[0,255,0],[0,0,255],[255,0,255]];
 const passed=size.width===width&&size.height===height&&JSON.stringify(corners)===JSON.stringify(expected);
 results.push({width,height,size,corners,passed});
}
await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results));
app.exit(results.every(r=>r.passed)?0:1);
}catch(e){console.error(e);app.exit(1);}
`;
// Electron's CommonJS main cannot use top-level await.
await build({ stdin: { contents: source.replace("await app.whenReady();", "void (async()=>{await app.whenReady();") + '\n})();', resolveDir: root, sourcefile: 'render-regression-entry.ts' }, outfile: join(out, 'probe.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [join(out, 'probe.cjs')], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
