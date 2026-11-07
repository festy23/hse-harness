import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSync } from 'oxc-parser';

const extensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.py']);
const excluded = new Set([
  '.git',
  '.agents',
  'node_modules',
  'dist',
  'coverage',
  'data',
  'secrets',
  'docs',
]);

export function inspectSource(filename, source) {
  const parsed = parseSync(filename, source);
  const hashbang = parsed.program.hashbang;
  return [
    ...parsed.errors.map((error) => ({ kind: 'syntax', message: error.message })),
    ...parsed.comments
      .filter(
        (comment) => !hashbang || comment.start !== hashbang.start || comment.end !== hashbang.end,
      )
      .map((comment) => ({
        kind: 'comment',
        line: source.slice(0, comment.start).split('\n').length,
        message: 'Comments are forbidden in code; put explanations in docs.',
      })),
  ];
}

export async function codeFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isSymbolicLink() ||
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        (directory === root && excluded.has(entry.name))
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && extensions.has(extname(entry.name))) {
        files.push(path);
      }
    }
  }
  await visit(root);
  return files.sort();
}

async function main() {
  const root = resolve(process.argv[2] ?? '.');
  const files = await codeFiles(root);
  let failures = 0;
  for (const file of files) {
    if (extname(file) === '.py') {
      continue;
    }
    for (const issue of inspectSource(file, await readFile(file, 'utf8'))) {
      console.error(`${relative(root, file)}:${issue.line ?? 1}: ${issue.message}`);
      failures++;
    }
  }
  const pythonFiles = files.filter((file) => extname(file) === '.py');
  if (pythonFiles.length) {
    const result = spawnSync(
      'python3',
      [fileURLToPath(new URL('./python-code-policy.py', import.meta.url)), ...pythonFiles],
      { encoding: 'utf8' },
    );
    if (result.error) {
      throw new Error('Python 3 is required to check Python sources', { cause: result.error });
    }
    if (result.status !== 0) {
      console.error(result.stderr || 'Python source policy failed');
      failures++;
    }
  }
  if (!files.length) {
    throw new Error('No source files found');
  }
  if (failures) {
    process.exitCode = 1;
  } else {
    console.log(`Code policy passed: ${files.length} files, no comments or syntax errors.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
