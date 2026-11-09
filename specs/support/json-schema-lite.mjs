// A minimal JSON-Schema checker for the OpenAPI contract specs (no ajv in the dependencies): $ref, const, enum, type (or a list of types),
// properties / required, items / maxItems, minLength / maxLength / pattern, minimum / maximum. Extra properties are allowed (the API may add
// fields); the specs check forbidden keys separately.
const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const matches = (type, v) => (type === 'number' ? typeof v === 'number' : type === 'integer' ? Number.isInteger(v) : typeOf(v) === type);

export function validate(schema, value, doc, at = '$') {
  const errors = [];
  const walk = (s, v, path) => {
    if (s.$ref) { const name = s.$ref.replace('#/components/schemas/', ''); return walk(doc.components.schemas[name], v, path); }
    if ('const' in s && v !== s.const) errors.push(`${path}: expected ${JSON.stringify(s.const)}, got ${JSON.stringify(v)}`);
    if (s.enum && !s.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
    if (s.type) {
      const types = [].concat(s.type);
      if (!types.some(t => matches(t, v))) { errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(v)}`); return undefined; }
    }
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${path}: does not match ${s.pattern}`);
    }
    if (typeof v === 'number') { if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: below ${s.minimum}`); if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: above ${s.maximum}`); }
    if (Array.isArray(v)) {
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
      if (s.items) v.forEach((x, i) => walk(s.items, x, `${path}[${i}]`));
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of s.required ?? []) if (!(k in v)) errors.push(`${path}: missing ${k}`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v && v[k] !== undefined) walk(sub, v[k], `${path}.${k}`);
    }
    return undefined;
  };
  walk(schema, value, at);
  return errors;
}
