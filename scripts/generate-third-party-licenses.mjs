// Writes the licence and notice files of every production dependency of a workspace to stdout, so a container image can carry
// them (Next.js standalone output and `npm ci --omit=dev` copies do not always keep a package's LICENSE file).
// Usage: node scripts/generate-third-party-licenses.mjs @tallymed/web > THIRD-PARTY-LICENSES.txt
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workspace = process.argv[2] ?? '@tallymed/web';
let out;
try {
  out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable', '-w', workspace], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (error) {
  // npm ls exits non-zero for harmless tree warnings (for example optional platform packages that are not installed).
  if (!error.stdout) throw error;
  out = String(error.stdout);
}
const root = resolve('.');
const dirs = [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))].sort();
const wanted = /^(licen[cs]e|copying|notice|unlicense)(\.|$|-)/i;
const sections = [];
for (const dir of dirs) {
  if (!existsSync(join(dir, 'package.json')) || dir === root || dir.startsWith(join(root, 'apps')) || dir.startsWith(join(root, 'packages'))) continue;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.name.startsWith('@tallymed/')) continue;
  const files = readdirSync(dir).filter((f) => wanted.test(f)).sort();
  const licence = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'unspecified');
  const body = files.map((f) => `--- ${f} ---\n${readFileSync(join(dir, f), 'utf8').trim()}`).join('\n\n') || '(the package ships no licence file; declared licence above)';
  sections.push(`================================================================\n${pkg.name}@${pkg.version}  [${licence}]\n${pkg.repository?.url ?? pkg.homepage ?? ''}\n================================================================\n${body}\n`);
}
process.stdout.write(`Third-party licences for ${workspace} production dependencies (${sections.length} packages)\n\n${sections.join('\n')}`);
