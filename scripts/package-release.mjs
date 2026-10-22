import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const ref = process.argv[2] || 'HEAD';
const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]);
const { version } = JSON.parse(git(['show', `${commit}:package.json`]));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid package version');
// Explicit manifest; data, node_modules, screenshots and machine configuration are never included.
const manifest = ['.gitignore', 'README.md', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'src', 'public', 'test', 'scripts'];
const files = git(['ls-tree', '-r', '--name-only', commit, '--', ...manifest]).split('\n');
for (const file of files) {
  if (/(^|\/)(data|node_modules|test-results|dist|\.env[^/]*)(\/|$)|\.(sqlite(?:-wal|-shm)?|log)$/.test(file)) throw new Error(`Excluded file in release: ${file}`);
}
for (const required of ['package-lock.json', 'src/server.js', 'public/index.html', 'README.md']) {
  if (!files.includes(required)) throw new Error(`Missing release file: ${required}`);
}
const destination = join(root, 'dist');
mkdirSync(destination, { recursive: true });
const sums = [];
for (const [format, extension] of [['tar.gz', 'tar.gz'], ['zip', 'zip']]) {
  const name = `wxbot-v${version}.${extension}`;
  const path = join(destination, name);
  git(['archive', `--format=${format}`, `--prefix=wxbot-v${version}/`, `--output=${path}`, commit, '--', ...manifest]);
  sums.push(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${name}`);
}
writeFileSync(join(destination, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
console.log(JSON.stringify({ version, commit, files: files.length, destination }, null, 2));
