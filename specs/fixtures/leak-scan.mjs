// Structural leak scan for privacy specs.
//
// Searching `JSON.stringify(response)` for a short seeded value ('411', '7777')
// is flaky: random ids, hashes, timestamps and other rows' prices contain those
// digits by chance. This walks the response instead and reports:
//
//   keys     a RegExp tested against every object key at any depth.
//   numbers  forbidden numbers. A hit is a number field exactly equal to one, or
//            a string holding it as a whole token: strings are split on anything
//            that is not a letter, digit or '.', so "411", "411.0", "411 kcal",
//            "411kcal", a CSV cell "411" and `"calories":411` inside a JSON-encoded
//            string all count, while "a411b", "0411", "1411", "14400" and
//            "00.411Z" (an ISO timestamp's milliseconds) do not.
//   strings  distinctive values (emails, phones, marker text) long enough not to
//            occur by chance. A hit is any string value or key containing one.
//
// Returns the list of hits as readable paths, so `assert.deepEqual(hits, [])`
// shows where a leak sits.

const UNITS = '(?:kcal|cal|kg|cm|m|km|tzs|tsh)?';

function numberToken(n) {
  const [whole, frac] = String(n).split('.');
  // 411 also matches "411.0", "411.00"; 93.7 also matches "93.70".
  const tail = frac ? `\\.${frac}0*` : '(?:\\.0+)?';
  return new RegExp(`^${whole.replace('-', '\\-')}${tail}${UNITS}$`, 'i');
}

export function findLeaks(value, { keys = null, numbers = [], strings = [], path = '$' } = {}) {
  const hits = [];
  const numberRes = numbers.map(n => [n, numberToken(n)]);
  const checkString = (s, at, what) => {
    for (const secret of strings) if (secret && s.includes(secret)) hits.push(`${at} ${what} contains ${JSON.stringify(secret)}`);
    if (!numberRes.length) return;
    for (const raw of s.split(/[^A-Za-z0-9.]+/)) {
      const token = raw.replace(/^\.+|\.+$/g, '');   // sentence full stops, not decimals
      if (!token) continue;
      for (const [n, re] of numberRes) if (re.test(token)) hits.push(`${at} ${what} has ${n} as ${JSON.stringify(token)}`);
    }
  };
  const walk = (v, at) => {
    if (typeof v === 'number' || typeof v === 'bigint') {
      for (const n of numbers) if (Number(v) === n) hits.push(`${at} = ${n}`);
    } else if (typeof v === 'string') {
      checkString(v, at, 'value');
    } else if (v instanceof Date) {
      checkString(v.toISOString(), at, 'date');
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${at}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (keys && keys.test(k)) hits.push(`${at}.${k} (forbidden key)`);
        checkString(k, `${at}.${k}`, 'key');
        walk(x, `${at}.${k}`);
      }
    }
  };
  walk(value, path);
  return hits;
}

/** Header cells of a CSV body (the reports here have no quoted commas). */
export const csvHeader = csv => csv.split('\r\n')[0].split(',').map(c => c.replace(/^"|"$/g, ''));
