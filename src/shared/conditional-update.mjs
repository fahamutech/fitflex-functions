// Update a row only if it still has the expected values, and say whether it did.
// Uses the store's single-statement conditional update when the collection has
// one (the database collections do); otherwise falls back to read-compare-write,
// which is what the in-memory collections in unit specs can offer.
export async function updateIf(collection, id, where, patch) {
  if (typeof collection.updateByIdWhereAsync === 'function') return collection.updateByIdWhereAsync(id, where, patch);
  const row = await collection.findByIdAsync(id);
  if (!row) return null;
  for (const [column, expected] of Object.entries(where || {})) {
    const ok = Array.isArray(expected) ? expected.includes(row[column] ?? null) : (row[column] ?? null) === expected;
    if (!ok) return null;
  }
  return collection.updateByIdAsync(id, patch);
}
