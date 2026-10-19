// Displayed money reads "TSh" (owner decision D-8, 2026-10-19); "TZS" stays
// only as the ISO code in data and APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTsh, CURRENCY_DISPLAY_LABEL, CURRENCY_ISO_CODE } from '../src/shared/money-display.mjs';

test('formatTsh: "TSh" then the amount with thousands separators', () => {
  assert.equal(CURRENCY_DISPLAY_LABEL, 'TSh');
  assert.equal(CURRENCY_ISO_CODE, 'TZS');
  assert.equal(formatTsh(279000), 'TSh 279,000');
  assert.equal(formatTsh(1250000), 'TSh 1,250,000');
  assert.equal(formatTsh(500), 'TSh 500');
  assert.equal(formatTsh('45000'), 'TSh 45,000');
  assert.equal(formatTsh(-3000), 'TSh -3,000');
});

test('formatTsh: a missing amount reads as zero, as the old helpers did', () => {
  for (const v of [0, null, undefined, '']) assert.equal(formatTsh(v), 'TSh 0');
});

test('formatTsh: same length as the old "TZS" label, so SMS segment counts do not change', () => {
  for (const n of [0, 999, 45000, 1250000]) {
    assert.equal(formatTsh(n).length, `TZS ${Number(n).toLocaleString('en-US')}`.length);
  }
});

test('no server text writes "TZS <amount>" any more', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.mjs')) files.push(p);
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'functions'));
  // "TZS 1,000", "TZS ${x}" or "${x} TZS" inside a string or template.
  const display = /TZS \$\{|TZS \d|\} TZS\b/;
  const offenders = files.flatMap((f) => readFileSync(f, 'utf8').split('\n')
    .map((line, i) => ({ f: f.slice(root.length + 1), i: i + 1, line }))
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line) && display.test(line.replace(/\s\/\/.*$/, ''))));
  assert.deepEqual(offenders, [], 'use formatTsh from src/shared/money-display.mjs');
});
