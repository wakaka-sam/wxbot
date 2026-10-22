import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [tag, output] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || !output) {
  throw new Error('Usage: node scripts/release-notes.mjs vX.Y.Z output.md');
}
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
if (tag !== `v${pkg.version}` || lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
  throw new Error('Tag, package.json and package-lock.json versions must agree');
}
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git(['rev-parse', `${tag}^{commit}`]) !== git(['rev-parse', 'HEAD'])) {
  throw new Error('Release must be built from the tagged commit');
}
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const section = changelog.split(/(?=^## )/m).find(s => s.startsWith(`## ${tag} — `));
if (!section) throw new Error(`CHANGELOG.md is missing ${tag}`);
const notes = section.slice(section.indexOf('\n') + 1).trim();
writeFileSync(output, `${notes}\n\n## 安装与下载\n\n` +
  `- [README](https://github.com/wakaka-sam/wxbot/blob/${tag}/README.md)\n` +
  `- [平台注册登录与部署](https://github.com/wakaka-sam/wxbot/blob/${tag}/docs/PLATFORM.md)\n` +
  '- 附件提供 tar.gz、zip 源码包与 SHA256SUMS.txt。需自行安装 Node.js、npm 依赖及可选的 Codex；平台模式还需 Linux 和 bubblewrap。\n');
console.log(`Release notes ready: ${tag}`);
