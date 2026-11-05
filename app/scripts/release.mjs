// Release tool (concept 6.3): builds the archives and the signed manifest into release-out/. No upload.
//   node scripts/release.mjs pack  [--key <pem>] [--key-id <id>] [--runtime <Electron directory> | --runtime-from <rollout-update.json>] [--out <directory>]
//   node scripts/release.mjs check [--electron <directory>] [--previous <rollout-<v>-app.tar.gz>]
// pack reads the version from package.json (prerelease = channel beta), expects a built dist/ and asks for the passphrase
// (or takes ROLLOUT_RELEASE_PASSPHRASE). check applies the previous release to the candidate and this one to an
// artificial version +1 (with a test key, best on the Ally because it needs a real Electron).
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://github.com/mace-ops/rollout-cycling-launcher-linux/releases/download';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const treeSize = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).reduce((sum, e) => (e.isFile() ? sum + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size : sum), 0);
const tar = (out, dir) => execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-czf', out, '-C', dir, '.']);

/** Next artificial version: increments the last number of the prerelease tag, otherwise the patch. */
export function bumpVersion(version) {
  const m = /^(\d+\.\d+\.)(\d+)(?:-(.+))?$/.exec(version);
  if (!m) throw new Error(`Version not readable: ${version}`);
  if (!m[3]) return `${m[1]}${Number(m[2]) + 1}`;
  const parts = m[3].split('.');
  const last = parts.length - 1;
  parts[last] = /^\d+$/.test(parts[last]) ? String(Number(parts[last]) + 1) : `${parts[last]}.1`;
  return `${m[1]}${m[2]}-${parts.join('.')}`;
}

/** App archive: package.json (only name, version, main), dist/, vendor/ (mywhoosh.sh with helper and licence) and bootstrap/rollout and bootstrap/rollout-run. `mutate(stageDir)` changes the content before packing (tests). */
export function packApp({ distDir, bootstrap, version, outFile, mutate }) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-pack-'));
  try {
    fs.cpSync(distDir, path.join(stage, 'dist'), { recursive: true });
    fs.cpSync(path.join(path.dirname(bootstrap), '../vendor'), path.join(stage, 'vendor'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'bootstrap'));
    fs.copyFileSync(bootstrap, path.join(stage, 'bootstrap/rollout'));
    fs.copyFileSync(path.join(path.dirname(bootstrap), 'bin-rollout-run.sh'), path.join(stage, 'bootstrap/rollout-run'));
    for (const name of ['rollout', 'rollout-run']) fs.chmodSync(path.join(stage, 'bootstrap', name), 0o755);
    fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({ name: 'rollout', version, main: 'dist/main/main.js' }, null, 2)}\n`);
    mutate?.(stage);
    tar(outFile, stage);
    return { url: `${BASE}/v${version}/${path.basename(outFile)}`, size: fs.statSync(outFile).size, unpacked: treeSize(stage), sha256: sha256(outFile) };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** Electron repacked, with licences (the directory contains them). */
export function packElectron({ electronDir, electronVersion, releaseVersion, outFile }) {
  tar(outFile, electronDir);
  return { electron: electronVersion, min: electronVersion, url: `${BASE}/v${releaseVersion}/${path.basename(outFile)}`, size: fs.statSync(outFile).size, unpacked: treeSize(electronDir), sha256: sha256(outFile) };
}

export function electronVersionOf(dir) {
  const file = path.join(dir, 'version');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return execFileSync(path.join(dir, 'electron'), ['-p', 'process.versions.electron'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).trim();
}

/** Envelope with a signature over the exact bytes of `signed`. */
export function signManifest(manifest, privateKey, keyId) {
  const signed = JSON.stringify(manifest);
  return `${JSON.stringify({ keyId, signature: sign(null, Buffer.from(signed), privateKey).toString('base64'), signed }, null, 2)}\n`;
}

export const publicKeyB64 = (privateKey) => createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

export const channelOf = (version) => (version.includes('-') ? 'beta' : 'stable');

export function manifestFor({ version, app, runtime }) {
  return { format: 1, product: 'rollout', channel: channelOf(version), version, published: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), app, runtime };
}

async function askPassphrase() {
  if (process.env.ROLLOUT_RELEASE_PASSPHRASE !== undefined) return process.env.ROLLOUT_RELEASE_PASSPHRASE;
  if (!process.stdin.isTTY) throw new Error('Passphrase missing: set ROLLOUT_RELEASE_PASSPHRASE or run in a terminal');
  const rl = readline.createInterface({ input: process.stdin, output: new Writable({ write: (_c, _e, cb) => cb() }), terminal: true });
  process.stderr.write('Passphrase of the signing key: ');
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stderr.write('\n');
  return answer;
}

function args(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1]?.startsWith('--') || list[i + 1] === undefined ? true : list[(i += 1)];
    else out._.push(list[i]);
  }
  return out;
}

export async function pack(opts) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid version in package.json: ${version}`);
  const distDir = path.join(root, 'dist');
  if (!fs.existsSync(path.join(distDir, 'main/main.js'))) throw new Error('dist/ is missing, run npm run build first');
  const keyFile = opts.key ?? path.join(os.homedir(), '.config/rollout-release/rollout-update-1.pem');
  const keyId = opts['key-id'] ?? 'rollout-update-1';
  const pem = fs.readFileSync(keyFile);
  let privateKey;
  try { privateKey = createPrivateKey({ key: pem }); } catch { privateKey = createPrivateKey({ key: pem, passphrase: await askPassphrase() }); }
  const out = path.resolve(opts.out ?? path.join(root, 'release-out'));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const app = packApp({ distDir, bootstrap: path.join(root, 'scripts/bin-rollout.sh'), version, outFile: path.join(out, `rollout-${version}-app.tar.gz`) });
  let runtime;
  if (opts.runtime) {
    const ev = electronVersionOf(opts.runtime);
    runtime = packElectron({ electronDir: opts.runtime, electronVersion: ev, releaseVersion: version, outFile: path.join(out, `rollout-runtime-electron-${ev}-linux-x64.tar.gz`) });
  } else if (opts['runtime-from']) {
    const earlier = JSON.parse(JSON.parse(fs.readFileSync(opts['runtime-from'], 'utf8')).signed);
    runtime = earlier.runtime;
  } else {
    throw new Error('Specify --runtime <Electron directory> or --runtime-from <earlier rollout-update.json>');
  }
  const manifest = manifestFor({ version, app, runtime });
  fs.writeFileSync(path.join(out, 'rollout-update.json'), signManifest(manifest, privateKey, keyId));
  console.log(`Release ${version} (${manifest.channel}) in ${out}`);
  for (const name of fs.readdirSync(out)) console.log(`  ${name}  ${(fs.statSync(path.join(out, name)).size / 1e6).toFixed(2)} MB`);
  console.log(`Public key (${keyId}): ${publicKeyB64(privateKey)}`);
  console.log('Next steps by hand: tag, gh release create --draft, upload files, verify, publish (concept 6.3). Nothing was uploaded.');
  return { out, manifest };
}

// Without top-level await: check loads test/update-probe.mjs, which imports this module; otherwise both would wait for each other.
async function cli() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  try {
    if (command === 'pack') await pack(opts);
    else if (command === 'check') {
      const { runCheck } = await import('../test/update-probe.mjs');
      await runCheck(opts);
    } else {
      console.error('Usage: node scripts/release.mjs pack|check (see the head of the file)');
      process.exit(2);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli();
