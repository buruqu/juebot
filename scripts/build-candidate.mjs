import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const project = fileURLToPath(new URL('../', import.meta.url));
const [version, compiler] = process.argv.slice(2);
if (process.argv.length !== 4 || !/^\d+\.\d+\.\d+-dev\.\d+$/.test(version ?? '')
  || !compiler || !path.isAbsolute(compiler) || !fs.statSync(compiler).isFile()) {
  throw new Error('Usage: node scripts/build-candidate.mjs <version-dev.N> <existing absolute tsc.js>; no dependencies are installed.');
}
const candidate = path.join(project, 'candidates', version);
const bundle = path.join(candidate, 'bundle');
function noLinks(target) {
  const relative = path.relative(project, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('CANDIDATE_OUTSIDE_PROJECT');
  let current = project;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('CANDIDATE_LINK_FORBIDDEN');
    }
  }
}
noLinks(bundle);
noLinks(path.join(candidate, 'build-receipt.json'));
for (const name of fs.readdirSync(bundle, { recursive: true })) noLinks(path.join(bundle, name));
const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'package.json'), 'utf8'));
if (manifest.name !== '@local/dsh-juebot' || manifest.version !== version) throw new Error('CANDIDATE_VERSION_MISMATCH');
const config = JSON.parse(fs.readFileSync(path.join(candidate, 'tsconfig.json'), 'utf8'));
const allowedOptions = ['noEmit', 'rewriteRelativeImportExtensions', 'declaration', 'declarationMap', 'sourceMap', 'rootDir', 'outDir', 'incremental'];
const base = JSON.parse(fs.readFileSync(path.join(project, 'tsconfig.json'), 'utf8'));
if (base.extends || base.references || ['outDir','outFile','declarationDir','tsBuildInfoFile'].some(key => key in base.compilerOptions)
  || Object.keys(config.compilerOptions).some(key => !allowedOptions.includes(key))
  || JSON.stringify(config.include) !== '["../../src/**/*.ts"]'
  || config.compilerOptions.noEmit !== false || config.compilerOptions.declaration !== true
  || config.compilerOptions.rewriteRelativeImportExtensions !== true
  || config.extends !== '../../tsconfig.json' || config.references || config.compilerOptions.outDir !== './bundle/lib'
  || config.compilerOptions.rootDir !== '../../src' || config.compilerOptions.incremental !== false) throw new Error('UNSAFE_CANDIDATE_TSC_CONFIG');
const live = path.join(project, 'bundle');
const snapshot = () => Object.fromEntries(fs.readdirSync(live, { recursive: true }).filter(name => fs.statSync(path.join(live, name)).isFile()).map(name => [name, fs.readFileSync(path.join(live, name)).toString('base64')]));
const before = snapshot();
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: project, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CANDIDATE_CHECK_FAILED:${result.status}`);
}
try {
  run([compiler, '--version']);
  run([compiler, '--noEmit', '--incremental', 'false', '-p', 'tsconfig.json']);
  run([compiler, '-p', path.join(candidate, 'tsconfig.json'), '--outDir', path.join(bundle, 'lib'), '--noEmit', 'false', '--noEmitOnError', 'true']);
  const declarations = fs.readdirSync(path.join(bundle, 'lib')).filter(name => name.endsWith('.d.ts')).map(name => path.join(bundle, 'lib', name));
  run([compiler, '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'ES2023', '--module', 'NodeNext', '--lib', 'ES2023,DOM', ...declarations]);
  for (const name of fs.readdirSync(bundle, { recursive: true }).filter(name => name.endsWith('.js'))) run(['--check', path.join(bundle, name)]);
const hashed = relative => ({ file: relative.replaceAll(path.sep, '/'), sha256: createHash('sha256').update(fs.readFileSync(path.join(project, relative))).digest('hex') });
const sourceFiles = fs.readdirSync(path.join(project, 'src'), { recursive: true }).filter(name => name.endsWith('.ts')).map(name => path.join('src', name));
const outputs = fs.readdirSync(path.join(bundle, 'lib')).filter(name => /\.(?:js|ts)$/.test(name)).map(name => path.relative(project, path.join(bundle, 'lib', name)));
noLinks(path.join(candidate, 'build-receipt.json'));
fs.writeFileSync(path.join(candidate, 'build-receipt.json'), JSON.stringify({ version, node: process.version,
  inputs: [...sourceFiles, 'tsconfig.json', path.relative(project, path.join(candidate, 'tsconfig.json'))].sort().map(hashed),
  outputs: outputs.sort().map(hashed) }, null, 2) + '\n');
} finally {
  if (JSON.stringify(snapshot()) !== JSON.stringify(before)) throw new Error('LIVE_BUNDLE_CHANGED');
}
console.log(`CANDIDATE_BUILD_OK ${version}; live bundle unchanged; not installed.`);
