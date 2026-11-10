#!/usr/bin/env node
'use strict';

/**
 * Build the JARVIS core that ships inside the app:
 *   extraResources/backend/index.cjs
 *
 * The core is bundled with esbuild so the installed app needs no Node, no
 * node_modules and no terminal. The only runtime requirement is Electron's
 * bundled Node (ELECTRON_RUN_AS_NODE=1), which includes node:sqlite.
 */

import {build} from 'esbuild';
import {mkdir, rm, writeFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const companionRoot = path.resolve(here, '..');
const repoRoot = path.resolve(companionRoot, '..', '..');
const targetDir = path.join(companionRoot, 'extraResources', 'backend');
const entry = path.join(repoRoot, 'src', 'cli', 'index.ts');

await stat(entry).catch(() => {
  console.error(`Core entry not found at ${entry}. Run this from the repository.`);
  process.exit(1);
});

await rm(targetDir, {recursive: true, force: true});
await mkdir(targetDir, {recursive: true});

await build({
  entryPoints: [entry],
  outfile: path.join(targetDir, 'index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  define: {'process.env.NODE_ENV': '"production"'},
  banner: {
    js: "const __jarvisImportMeta = {url: require('node:url').pathToFileURL(__filename).href};",
  },
});

await writeFile(
  path.join(targetDir, 'package.json'),
  `${JSON.stringify({name: 'jarvis-core', version: '3.0.1', private: true, type: 'commonjs'}, null, 2)}\n`,
  'utf8',
);

await writeFile(
  path.join(targetDir, 'README.txt'),
  'Bundled JARVIS core. Started by JARVIS.app; not intended to be run by hand.\n',
  'utf8',
);

const info = await stat(path.join(targetDir, 'index.cjs'));
console.log(`Prepared embedded JARVIS core (${(info.size / 1024 / 1024).toFixed(1)} MB).`);
