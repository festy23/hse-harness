import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codeFiles } from '../scripts/code-policy.mjs';

function lintFixture(root, paths) {
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url)),
      '-c',
      '.oxlintrc.json',
      '-f',
      'json',
      ...paths,
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

test('JavaScript runtime rejects undefined names and reassignment of constants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hse-js-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(new URL('../.oxlintrc.json', import.meta.url), join(root, '.oxlintrc.json'));
  await mkdir(join(root, 'runtime'));
  for (const extension of ['js', 'mjs', 'cjs']) {
    await writeFile(
      join(root, 'runtime', `fixture.${extension}`),
      'function persist(snapshot) { return saveSnaphot(snapshot); } persist({}); const count = 1; count = 0;',
    );
  }
  const invalid = lintFixture(root, ['runtime']);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  const diagnostics = JSON.parse(invalid.stdout).diagnostics;
  for (const extension of ['js', 'mjs', 'cjs']) {
    for (const rule of ['no-undef', 'no-const-assign']) {
      assert.ok(
        diagnostics.some(
          (entry) => entry.filename.endsWith(`.${extension}`) && entry.code === `eslint(${rule})`,
        ),
        `${extension} must enforce ${rule}`,
      );
    }
    await writeFile(
      join(root, 'runtime', `fixture.${extension}`),
      'function persist(snapshot) { return JSON.stringify(snapshot); } process.stdout.write(persist({})); let count = 1; count = 0;',
    );
  }
  const valid = lintFixture(root, ['runtime']);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
});

test('domain rejects infrastructure imports with and without the node prefix', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hse-domain-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copyFile(new URL('../.oxlintrc.json', import.meta.url), join(root, '.oxlintrc.json'));
  await mkdir(join(root, 'src'));
  const imports = [
    'fs',
    'fs/promises',
    'http',
    'https',
    'child_process',
    'node:fs',
    'node:fs/promises',
    'node:http',
    'node:https',
    'node:child_process',
    './mail.js',
    './main.js',
    './cli.js',
  ];
  await writeFile(
    join(root, 'src/domain.ts'),
    imports.map((name) => `import '${name}';`).join('\n'),
  );
  const invalid = lintFixture(root, ['src/domain.ts']);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  const diagnostics = JSON.parse(invalid.stdout).diagnostics.filter(
    (entry) => entry.code === 'eslint(no-restricted-imports)',
  );
  for (const [index, name] of imports.entries()) {
    assert.ok(
      diagnostics.some((entry) => entry.labels.some((label) => label.span.line === index + 1)),
      `${name} must be forbidden: ${invalid.stdout}`,
    );
  }
  await writeFile(join(root, 'src/domain.ts'), "import 'node:crypto'; export const id = 'value';");
  const valid = lintFixture(root, ['src/domain.ts']);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
});

test('code policy rejects comments and suppression directives without rejecting literals', async () => {
  const module = new URL('../scripts/code-policy.mjs', import.meta.url);
  assert.ok(existsSync(module), 'The code policy checker must be installed');
  const { inspectSource } = await import(module.href);
  for (const source of [
    'const n = 1; // note',
    '/* note */ const n = 1;',
    '/** documentation */ export const n = 1;',
    '// oxlint-disable\nconst n = 1;',
    '// eslint-disable\nconst n = 1;',
    '// @ts-nocheck\nconst n: number = "wrong";',
  ]) {
    assert.ok(inspectSource('fixture.ts', source).some((entry) => entry.kind === 'comment'));
  }
  for (const source of [
    'const url = "https://example.com";',
    'const pattern = /https?:\\/\\//;',
    'const template = `/* this is data */`;',
    '#!/usr/bin/env node\nconst n = 1;',
  ]) {
    assert.deepEqual(inspectSource('fixture.ts', source), []);
    assert.deepEqual(inspectSource('fixture.mjs', source), []);
  }
  assert.ok(inspectSource('fixture.ts', 'const =').some((entry) => entry.kind === 'syntax'));
});

test('code policy CLI fails on comments in newly discovered code and ignores generated files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hse-code-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src', 'data'), { recursive: true });
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'generated.js'), '// generated');
  const file = join(root, 'src', 'data', 'new.ts');
  await writeFile(file, 'export const n = 1;');
  assert.deepEqual(await codeFiles(root), [file]);
  const run = () =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../scripts/code-policy.mjs', import.meta.url)), root],
      { encoding: 'utf8' },
    );
  assert.equal(run().status, 0);
  await writeFile(file, '// oxlint-disable\nexport const n = 1;');
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /new.ts:1: Comments are forbidden/);
});

test('lint configuration detects unsafe types, floating promises and architecture violations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hse-lint-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await copyFile(new URL('../.oxlintrc.json', import.meta.url), join(root, '.oxlintrc.json'));
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );
  await writeFile(
    join(root, 'src', 'unsafe.ts'),
    [
      'declare const input: any;',
      'export const output: string = input;',
      'void Promise.resolve(1);',
      'eval("1");',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'src', 'domain.ts'),
    'import { bot } from "./bot"; export const domain = bot;',
  );
  await writeFile(join(root, 'src', 'bot.ts'), 'export const bot = 1;');
  await writeFile(
    join(root, 'src', 'a.ts'),
    'import { b } from "./b"; export function a(): number { return b(); }',
  );
  await writeFile(
    join(root, 'src', 'b.ts'),
    'import { a } from "./a"; export function b(): number { return a(); }',
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/oxlint/bin/oxlint', import.meta.url)),
      '-c',
      '.oxlintrc.json',
      '-f',
      'json',
      'src',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 1, result.stderr);
  const codes = JSON.parse(result.stdout).diagnostics.map((diagnostic) => diagnostic.code);
  for (const rule of [
    'no-explicit-any',
    'no-unsafe-assignment',
    'no-floating-promises',
    'no-eval',
    'no-restricted-imports',
    'no-cycle',
  ]) {
    assert.ok(
      codes.some((code) => code.includes(`(${rule})`)),
      `${rule} must reject the fixture: ${result.stdout}`,
    );
  }
});

test('code policy checks Python comments, docstrings and syntax without rejecting string data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hse-python-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'fixture.py');
  const run = () =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../scripts/code-policy.mjs', import.meta.url)), root],
      { encoding: 'utf8' },
    );
  await writeFile(file, '#!/usr/bin/env python3\nvalue = "# string data"\n');
  assert.equal(run().status, 0);
  for (const source of [
    'value = 1 # note\n',
    '"""module documentation"""\n',
    'def f():\n    """function documentation"""\n    return 1\n',
    'def broken(\n',
  ]) {
    await writeFile(file, source);
    const result = run();
    assert.equal(result.status, 1, source);
    assert.match(result.stderr, /fixture.py:/);
  }
});
