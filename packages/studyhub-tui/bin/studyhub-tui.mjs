#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = resolve(root, 'dist', 'cli.mjs');

if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href);
} else {
  // Cross-platform dev fallback (Linux bash + Windows PowerShell) using `node --import tsx`
  const { spawn } = await import('node:child_process');
  const tsxLoader = pathToFileURL(resolve(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, resolve(root, 'src', 'cli.tsx'), ...process.argv.slice(2)],
    { stdio: 'inherit', cwd: process.cwd() },
  );
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}
