// Build-time only: fetch unmodified official native runtimes; no npm install, auth, or global config access.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, chmod, rename, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = join(root, 'resources', 'codex');
const downloadRoot = join(runtimeRoot, '_downloads');
const version = '0.171.0';
// Pins independently checked against official registry metadata on 2026-11-22.
const targets = [
  { id: 'win-x64', suffix: 'win32-x64', triple: 'x86_64-pc-windows-msvc', binary: 'codex.exe',
    integrity: 'sha512-HKWBK25tLQxdEg6svw0CrBf+v0bQhRyF8EBVdNqeRxErqpfFa/dfSar6r3sJt6tyPqozOtgz2BH8B2G3n/+gnQ==' },
  { id: 'mac-arm64', suffix: 'darwin-arm64', triple: 'aarch64-apple-darwin', binary: 'codex',
    integrity: 'sha512-hIYTkRUpuYpkVfTq4cpby0PXqhAVcIgE7f6FoyY1lt2RyARj3GXS1Can/dIYUBItVhXzhb98HYHZNzCX74QRlQ==' },
  { id: 'mac-x64', suffix: 'darwin-x64', triple: 'x86_64-apple-darwin', binary: 'codex',
    integrity: 'sha512-pwN5uNEKx/mZjwBEf/6CKq6SJMfJS5kruV3sJQAk7ebIPvC58Ote3CicIxETDZtjLj35rNv3PLPd7mHCg6hGPw==' },
];
const wanted = new Set(process.argv.slice(2));
if ([...wanted].some(id => !targets.some(target => target.id === id))) throw new Error('Supported targets: win-x64 mac-arm64 mac-x64');
await mkdir(downloadRoot, { recursive: true });

async function fileHash(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex');
}
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response;
}
async function licenses() {
  const source = `https://raw.githubusercontent.com/openai/codex/rust-v${version}`;
  const files = { 'LICENSE-CODEX.txt': `${source}/LICENSE`, 'NOTICE-CODEX.txt': `${source}/NOTICE`,
    'LICENSE-RIPGREP-MIT.txt': 'https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/LICENSE-MIT',
    'LICENSE-RIPGREP-UNLICENSE.txt': 'https://raw.githubusercontent.com/BurntSushi/ripgrep/15.2.0/UNLICENSE',
    'LICENSE-RATATUI-MIT.txt': 'https://raw.githubusercontent.com/ratatui/ratatui/ratatui-v0.30.2/LICENSE',
    'LICENSE-PCRE2.txt': 'https://raw.githubusercontent.com/PCRE2Project/pcre2/pcre2-10.45/LICENCE.md' };
  const result = [];
  for (const [name, url] of Object.entries(files)) {
    const path = join(downloadRoot, name);
    await writeFile(path, await (await get(url)).text());
    result.push({ name, url, path, sha256: await fileHash(path) });
  }
  return result;
}
const licenseFiles = await licenses();

async function unpack(target) {
  const npmVersion = `${version}-${target.suffix}`;
  const metadataUrl = `https://registry.npmjs.org/@openai%2Fcodex/${npmVersion}`;
  const metadata = await (await get(metadataUrl)).json();
  if (metadata.name !== '@openai/codex' || metadata.version !== npmVersion || metadata.dist.integrity !== target.integrity || metadata.license !== 'Apache-2.0') throw new Error(`Registry metadata changed for ${target.id}`);
  const tarballUrl = metadata.dist.tarball;
  if (new URL(tarballUrl).hostname !== 'registry.npmjs.org' || new URL(tarballUrl).protocol !== 'https:') throw new Error('Unexpected tarball origin');
  const archive = join(downloadRoot, `codex-${npmVersion}.tgz`);
  let cached = false;
  try { cached = `sha512-${await fileHash(archive, 'sha512')}` === target.integrity; } catch { /* Not downloaded yet. */ }
  if (!cached) {
    const partial = archive + '.partial';
    const response = await get(tarballUrl);
    if (!response.body) throw new Error('Empty tarball response');
    const hash = createHash('sha512');
    let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; hash.update(chunk); done(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial));
    if (`sha512-${hash.digest('base64')}` !== target.integrity) throw new Error(`SHA-512 integrity failed for ${target.id}; preserved .partial for diagnosis`);
    await rename(partial, archive);
    console.info(`${target.id}: downloaded and SHA-512 verified (${bytes} bytes)`);
  } else console.info(`${target.id}: cached archive SHA-512 verified`);
  const { stdout: listing } = await exec('tar', ['-tzf', archive], { maxBuffer: 1024 * 1024, windowsHide: true });
  const entries = listing.trim().split(/\r?\n/).filter(Boolean);
  if (entries.some(entry => !entry.startsWith('package/') || entry.includes('..') || entry.includes('\\') || isAbsolute(entry))) throw new Error('Unsafe archive paths');
  const installed = join(runtimeRoot, target.id);
  const stage = await mkdtemp(join(runtimeRoot, '.prepare-'+target.id+'-'));
  const destination = join(stage,'new');
  const backup = join(stage,'previous');
  let keepBackup = false;
  try {
    await mkdir(destination);
    await exec('tar', ['-xzf', archive, '--strip-components', '1', '-C', destination], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const executable = `vendor/${target.triple}/bin/${target.binary}`;
    const packageManifest = JSON.parse(await readFile(join(destination, `vendor/${target.triple}/codex-package.json`), 'utf8'));
    if (packageManifest.version !== version || packageManifest.target !== target.triple) throw new Error('Native package manifest mismatch');
    const files = [];
    const executables = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Unexpected runtime symlink');
        if (entry.isDirectory()) await walk(path);
        else {
          const rel = relative(destination, path).replaceAll('\\', '/');
          const bytes = (await stat(path)).size;
          files.push({ path: rel, bytes, sha256: await fileHash(path) });
          if (rel.startsWith('vendor/') && !rel.endsWith('.json') && (rel.includes('/bin/') || rel.includes('/codex-path/') || rel.endsWith('.exe'))) {
            executables.push(rel);
            if (process.platform !== 'win32') await chmod(path, 0o755);
          }
        }
      }
    }
    await walk(join(destination, 'vendor'));
    for (const license of licenseFiles) await writeFile(join(destination, license.name), await readFile(license.path));
    const main = await readFile(join(destination, executable));
    let architecture;
    if (target.id === 'win-x64') {
      const pe = main.readUInt32LE(0x3c);
      if (main.toString('ascii', 0, 2) !== 'MZ' || main.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Expected x64 PE executable');
      architecture = 'PE x86_64';
    } else {
      if (main.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected 64-bit Mach-O executable');
      const cpu = main.readUInt32LE(4);
      if (cpu !== (target.id === 'mac-arm64' ? 0x0100000c : 0x01000007)) throw new Error('Mach-O architecture mismatch');
      architecture = target.id === 'mac-arm64' ? 'Mach-O arm64' : 'Mach-O x86_64';
    }
    const manifest = { version, target: target.id, architecture, executable, executables, layout: 'unmodified official vendor layout',
      npm: { name: metadata.name, version: npmVersion, alias: `@openai/codex-${target.suffix}`, metadataUrl, tarball: tarballUrl, integrity: target.integrity, integrityVerified: true, license: metadata.license },
      licenses: licenseFiles.map(({ name, url, sha256 }) => ({ name, url, sha256 })), files };
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.info(`${target.id}: ${files.length} native files ready, ${architecture}, executable=${executable}`);
    if (target.id === 'win-x64' && process.platform === 'win32') {
      const { stdout } = await exec(join(destination, executable), ['--version'], { windowsHide: true, timeout: 20_000 });
      if (stdout.trim() !== `codex-cli ${version}`) throw new Error(`Unexpected runtime version: ${stdout}`);
      console.info(`${target.id}: native --version passed`);
    }
    let hadPrevious = false;
    try { await rename(installed,backup); hadPrevious=true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(destination,installed); }
    catch (error) {
      if (hadPrevious) {
        keepBackup=true;
        await rename(backup,installed);
        keepBackup=false;
      }
      throw error;
    }
  } finally {
    if (!keepBackup && dirname(stage) === runtimeRoot) await rm(stage,{recursive:true,force:true});
  }

}
await Promise.all(targets.filter(target => !wanted.size || wanted.has(target.id)).map(unpack));
