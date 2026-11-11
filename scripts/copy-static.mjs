import { copyFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('../dist/src/web/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  await copyFile(new URL(`../src/web/${file}`, import.meta.url), new URL(`../dist/src/web/${file}`, import.meta.url));
}
await mkdir(new URL('../dist/data/', import.meta.url), { recursive: true });
await copyFile(new URL('../data/catalog.json', import.meta.url), new URL('../dist/data/catalog.json', import.meta.url));
await copyFile(new URL('../data/studio-transports.json', import.meta.url), new URL('../dist/data/studio-transports.json', import.meta.url));
await mkdir(new URL('../dist/src/studio/web/', import.meta.url), { recursive: true });
for (const file of ['index.html', 'studio.css']) {
  await copyFile(new URL(`../src/studio/web/${file}`, import.meta.url), new URL(`../dist/src/studio/web/${file}`, import.meta.url));
}
