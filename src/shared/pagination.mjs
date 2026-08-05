// Shared offset-cursor pagination for list endpoints that can grow large
// (members, payments, check-ins). Keeps the first response small so portal
// and mobile clients get a fast first paint, then page in the rest on demand.
export function paginate(rows, query = {}) {
  const total = rows.length;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(query.cursor, 10) || 0, 0);
  const items = rows.slice(offset, offset + limit);
  const nextCursor = offset + limit < total ? offset + limit : null;
  return { items, total, nextCursor };
}
