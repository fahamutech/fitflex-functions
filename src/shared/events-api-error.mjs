// Marathon & running events · S7 — the `api_error` counter (spec §5.3, confirmation 10). The events route files each have their own
// `send` helper (there is no shared wrapper), so each calls noteApiError(group, status) when it is about to answer 5xx or 429.
// The sink is set once by the bootstrap (the analytics service). No sink, a failure or the flag being off: nothing happens, and
// nothing here ever throws into a request. Only the group and the class are counted: no path, no id, no message.
let sink = null;
export const setApiErrorSink = fn => { sink = typeof fn === 'function' ? fn : null; };
export function noteApiError(group, status) {
  try {
    if (!sink) return;
    const cls = status >= 500 ? '5xx' : status === 429 ? '429' : null;
    if (cls) Promise.resolve(sink(group, cls)).catch(() => {});
  } catch { /* best effort */ }
}
