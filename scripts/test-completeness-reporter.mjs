// node:test reporter that fails the run when results go missing.
//
// Each spec file runs in a child process that streams its results back to the
// runner. If that stream is cut short (on 2026-10-19 `--test-force-exit` cut
// off settlement-engine.specs.mjs after 3 "network cap" tests in CI), the
// runner reports the shorter run as all-pass. This reporter checks:
//   1. every spec file under specs/ reported at least one result, and
//   2. every test the runner announced (test:enqueue) finished with a pass
//      or a fail.
// A file announces all of its top-level tests before it runs any of them, so
// a cut anywhere before its last result leaves an announced test without one.
// Used by `npm test` next to the TAP reporter; it sets a non-zero exit code
// and prints what is missing.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SPEC_DIR = 'specs';
const SPEC_SUFFIX = '.specs.mjs';

function listSpecFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSpecFiles(path);
    return entry.name.endsWith(SPEC_SUFFIX) ? [resolve(path)] : [];
  });
}

const keyOf = d => `${d.file}\u0000${d.nesting}\u0000${d.line}:${d.column}\u0000${d.name}`;

export default async function* completenessReporter(source) {
  const open = new Map(); // key -> count of announced tests without a result
  const filesWithResults = new Set();
  let results = 0;

  for await (const { type, data } of source) {
    if (!data?.file) continue;
    // The runner's own per-file wrapper test (named after the file path) only
    // reports a result when the file itself failed (e.g. an import error), so
    // its announcement is not tracked.
    if (resolve(data.name ?? '') === data.file) {
      if (type === 'test:pass' || type === 'test:fail') filesWithResults.add(data.file);
      continue;
    }
    const key = keyOf(data);
    if (type === 'test:enqueue') {
      open.set(key, (open.get(key) ?? 0) + 1);
    } else if (type === 'test:pass' || type === 'test:fail') {
      results++;
      filesWithResults.add(data.file);
      const n = open.get(key) ?? 0;
      if (n <= 1) open.delete(key); else open.set(key, n - 1);
    }
  }

  const problems = [];
  for (const [key, n] of open) {
    const [file, nesting, loc, name] = key.split('\u0000');
    problems.push(`no result for "${name}" (${file}:${loc}, nesting ${nesting})${n > 1 ? ` ×${n}` : ''}`);
  }
  for (const file of listSpecFiles(SPEC_DIR)) {
    if (!filesWithResults.has(file)) problems.push(`no results from ${file}`);
  }

  if (problems.length) {
    process.exitCode = 1;
    yield `\n✖ Incomplete test run: ${problems.length} problem(s). Results were lost, so the totals above undercount.\n`;
    for (const p of problems.slice(0, 50)) yield `  - ${p}\n`;
    if (problems.length > 50) yield `  … and ${problems.length - 50} more\n`;
  } else {
    yield `✔ Test run complete: ${results} results, every announced test reported.\n`;
  }
}
