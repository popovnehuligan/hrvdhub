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
// One file with everything, for copy-pasting into the Apps Script editor (public/setup.html).
const bundleTarget = path.join(root, 'public/setup/wishlist-script.txt');
const bundle = `${built}\n\n${fs.readFileSync(path.join(root, 'apps-script/Code.gs'), 'utf8')}`;

// The manifest, which the script fetches when it updates itself.
const manifestTarget = path.join(root, 'public/setup/appsscript.json');
const manifest = fs.readFileSync(path.join(root, 'apps-script/appsscript.json'), 'utf8');

if (process.argv.includes('--check')) {
  for (const [file, expected] of [[target, built], [bundleTarget, bundle], [manifestTarget, manifest]]) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current !== expected) {
      console.error(`${path.relative(root, file)} is out of date: run node tools/build-gs.mjs`);
      process.exit(1);
    }
  }
} else {
  fs.writeFileSync(target, built);
  fs.mkdirSync(path.dirname(bundleTarget), { recursive: true });
  fs.writeFileSync(bundleTarget, bundle);
  fs.writeFileSync(manifestTarget, manifest);
  console.log('apps-script/Shared.gs, public/setup/wishlist-script.txt and appsscript.json written');
}
