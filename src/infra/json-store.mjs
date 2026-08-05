// Minimal JSON-file store, swappable for Knex/Postgres later via DI.
// Persists collections to ./.data/<name>.json. Synchronous read on first access; debounced write.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.data');
if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });

const cache = new Map();
const writeTimers = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);
  const file = join(ROOT, `${name}.json`);
  let data = [];
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { /* empty */ }
  cache.set(name, data);
  return data;
}

function persist(name) {
  clearTimeout(writeTimers.get(name));
  writeTimers.set(name, setTimeout(() => {
    writeFileSync(join(ROOT, `${name}.json`), JSON.stringify(cache.get(name), null, 2));
  }, 50));
}

export function collection(name) {
  load(name);
  return {
    all:     () => [...cache.get(name)],
    find:    (pred) => cache.get(name).find(pred),
    filter:  (pred) => cache.get(name).filter(pred),
    insert:  (row) => { cache.get(name).push(row); persist(name); return row; },
    update:  (pred, patch) => {
      const arr = cache.get(name);
      const i = arr.findIndex(pred);
      if (i < 0) return null;
      arr[i] = { ...arr[i], ...patch };
      persist(name);
      return arr[i];
    },
    remove:  (pred) => {
      const arr = cache.get(name);
      const i = arr.findIndex(pred);
      if (i < 0) return null;
      const [row] = arr.splice(i, 1);
      persist(name);
      return row;
    },
    upsert:  (pred, row) => {
      const arr = cache.get(name);
      const i = arr.findIndex(pred);
      if (i < 0) { arr.push(row); } else { arr[i] = { ...arr[i], ...row }; }
      persist(name);
      return row;
    }
  };
}
