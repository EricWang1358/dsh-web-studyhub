import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkerConversionScript, MARKER_SCRIPT_FILENAME } from '../lib/marker-external.js';

const python = ['python3', 'python'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);

const outputDirectories = dir => readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('studyhub-marker-'));

function fixture(t, { mode = 'success', filename = process.platform === 'win32' ? '资料 & $(touch surprise); quoted.pdf' : '资料 & $(touch surprise); "quoted".pdf' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-marker-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, MARKER_SCRIPT_FILENAME);
  writeFileSync(script, createMarkerConversionScript());
  const pdf = join(dir, filename);
  writeFileSync(pdf, '%PDF-1.4\nsynthetic test fixture');
  const fake = join(dir, 'fake-marker.py');
  writeFileSync(fake, `import json, pathlib, sys\nargs = sys.argv[1:]\npathlib.Path(${JSON.stringify(join(dir, 'arguments.json'))}).write_text(json.dumps(args), encoding='utf-8')\nout = pathlib.Path(args[args.index('--output_dir') + 1])\nmode = ${JSON.stringify(mode)}\nif mode == 'failure': sys.exit(7)\nif mode != 'missing':\n    nested = out / 'converted'\n    nested.mkdir()\n    (nested / 'converted.md').write_text('Ordinary unpaginated text' if mode == 'unpaginated' else '' if mode == 'empty' else '{0}------------------------------------------------\\n\\nA synthetic page.', encoding='utf-8')\n`);
  const launcher = join(dir, 'test-launcher.py');
  writeFileSync(launcher, `import pathlib, runpy, sys, types\nmodule = runpy.run_path(sys.argv[1])\ncontext = module['main'].__globals__\nmode = sys.argv[2]\nsys.argv = [sys.argv[1]] + sys.argv[3:]\nif mode == 'cancel':\n    class Root:\n        def withdraw(self): pass\n        def destroy(self): pass\n    sys.modules['tkinter'] = types.SimpleNamespace(Tk=Root, filedialog=types.SimpleNamespace(askopenfilename=lambda **kwargs: ''))\nelif mode == 'no-picker': sys.modules['tkinter'] = None\nif mode == 'not-installed':\n    context['sys'].executable = ${JSON.stringify(join(dir, 'empty-env', 'python'))}\n    context['shutil'].which = lambda name: None\nelse: context['find_marker_command'] = lambda: [sys.executable, ${JSON.stringify(fake)}]\ntry: sys.exit(module['main']())\nexcept Exception as error:\n    print('Conversion failed: ' + str(error), file=sys.stderr)\n    sys.exit(1)\n`);
  return { dir, script, pdf, run: (behavior = 'fake', args = [pdf]) => spawnSync(python, [launcher, script, behavior, ...args], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 15000 }) };
}

test('downloaded helper is standalone and never installs Marker or enables paid/cloud LLM flags', () => {
  const script = createMarkerConversionScript();
  assert.equal(MARKER_SCRIPT_FILENAME, 'studyhub-marker-convert.py');
  assert.match(script, /shell=False/);
  assert.match(script, /first use may download model weights/);
  assert.match(script, /--paginate_output/);
  assert.doesNotMatch(script, /pip install|--use_llm|--llm_service|requests\.|https?:\/\//);
});

test('external helper passes hostile filenames as a single absolute argument and preserves previous output', { skip: !python }, t => {
  const files = fixture(t);
  for (let index = 0; index < 2; index++) {
    const result = files.run();
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(join(files.dir, 'arguments.json'), 'utf8'));
    assert.deepEqual(args.slice(0, 5), [files.pdf, '--output_format', 'markdown', '--paginate_output', '--output_dir']);
    assert.equal(args.length, 6);
    assert.match(result.stdout, /Conversion complete/);
    assert.ok(result.stdout.includes(join(args[5], 'converted', 'converted.md')));
  }
  assert.equal(outputDirectories(files.dir).length, 2);
  assert.ok(!readdirSync(files.dir).includes('surprise'));
});

test('external helper rejects invalid PDFs and missing installations before starting conversion', { skip: !python }, t => {
  const files = fixture(t);
  let result = files.run('not-installed');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not installed/);
  writeFileSync(files.pdf, 'This is not a PDF');
  result = files.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PDF header/);
  result = files.run('fake', [join(files.dir, 'missing.pdf')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /existing PDF/);
  assert.equal(outputDirectories(files.dir).length, 0);
});

test('external helper cancels safely and explains CLI usage when a picker is unavailable', { skip: !python }, t => {
  const files = fixture(t);
  const cancelled = files.run('cancel', []);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /Cancelled/);
  const unavailable = files.run('no-picker', []);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /python studyhub-marker-convert.py/);
  assert.equal(outputDirectories(files.dir).length, 0);
});

test('external helper fails on failed conversion and empty, missing or unpaginated Markdown', { skip: !python }, t => {
  for (const mode of ['failure', 'empty', 'missing', 'unpaginated']) {
    const files = fixture(t, { mode });
    const result = files.run();
    assert.equal(result.status, mode === 'failure' ? 7 : 1, result.stderr);
    assert.doesNotMatch(result.stdout, /Conversion complete/);
    assert.match(result.stderr, mode === 'failure' ? /exit code 7/ : /no non-empty paginated Markdown/);
  }
});
