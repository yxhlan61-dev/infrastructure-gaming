import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const out = join(root, 'public');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'src'), { recursive: true });
for (const file of ['index.html', 'styles.css']) cpSync(join(root, file), join(out, file));
for (const file of ['app.js', 'game.js', 'catalog.js']) cpSync(join(root, 'src', file), join(out, 'src', file));
console.log(`Cloudflare static assets written to ${out}`);
