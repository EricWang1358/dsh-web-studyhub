import { readFile, readdir } from 'node:fs/promises';

/* The source of the app shell: ui/App.jsx composes, and what it used to hold lives in ui/app/** (hooks and shell parts) and
   ui/review/** (the practice session). Source-reading tests that ask "does the shell do X" read all of it, LF-normalized. */
const SHELL_DIRS = ['ui/app', 'ui/review'];

const normalize = (text) => text.replace(/\r\n/g, '\n');

/** The shell's files as { name, source }, App.jsx first. */
export async function appSourceFiles() {
  const files = [{ name: 'ui/App.jsx', source: normalize(await readFile('ui/App.jsx', 'utf8')) }];
  for (const dir of SHELL_DIRS) {
    for (const entry of (await readdir(dir, { recursive: true })).sort()) {
      const name = `${dir}/${entry}`.replace(/\\/g, '/');
      if (/\.(js|jsx)$/.test(name)) files.push({ name, source: normalize(await readFile(name, 'utf8')) });
    }
  }
  return files;
}

/** All of it as one text, each file introduced by a marker comment. */
export async function readAppSource() {
  return (await appSourceFiles()).map(({ name, source }) => `/* ── ${name} ── */\n${source}`).join('\n');
}

/** One shell file, LF-normalized. */
export async function readShellFile(name) {
  return normalize(await readFile(name, 'utf8'));
}
