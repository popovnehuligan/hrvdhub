// Copies public/lib/shared.js to apps-script/Shared.gs without the `export` keywords,
// so the app and the Apps Script backend run the very same rules.
//   node tools/build-gs.mjs          — write Shared.gs
//   node tools/build-gs.mjs --check  — fail if Shared.gs is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'public/lib/shared.js'), 'utf8');
const target = path.join(root, 'apps-script/Shared.gs');

export function toAppsScript(code) {
  const body = code.replace(/^export (?=(const|function|class) )/gm, '');
  if (/^export /m.test(body)) throw new Error('shared.js: only `export const/function/class` is supported');
  return `// GENERATED from public/lib/shared.js by tools/build-gs.mjs — edit that file, not this one.\n\n${body}`;
}

const built = toAppsScript(source);
if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current !== built) {
    console.error('apps-script/Shared.gs is out of date: run node tools/build-gs.mjs');
    process.exit(1);
  }
} else {
  fs.writeFileSync(target, built);
  console.log('apps-script/Shared.gs written');
}
