import { defineConfig } from 'vite';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// JSON files the app fetches from the site root at runtime. The scripts write them next to
// index.html, which the dev server serves, but `vite build` only copies public/. Copy them
// into the build output so production hosting (e.g. Vercel) serves them too. Missing files
// are skipped: the app treats each one as optional.
const RUNTIME_DATA = ['facts.json', 'generated-pages.json', 'attestation-proof.json'];

function copyRuntimeData() {
  let root;
  let outDir;
  return {
    name: 'hunch-runtime-data',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      for (const file of RUNTIME_DATA) {
        try {
          await copyFile(resolve(root, file), resolve(outDir, file));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    },
  };
}

export default defineConfig({
  root: '.',
  plugins: [copyRuntimeData()],
  build: { rollupOptions: { input: ['index.html', 'fact/index.html'] } },
});
