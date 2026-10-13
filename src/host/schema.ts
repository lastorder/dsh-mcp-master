/**
 * MCP tool input schemas → the JSON Schema subset the DSH tool registry
 * enforces (type / oneOf / properties / required / additionalProperties /
 * items / enum / const + description / title / default / examples).
 *
 * MCP servers routinely emit vocabulary outside that subset — pydantic's
 * `anyOf: [{...}, {type: null}]`, `$ref` into `$defs`, type arrays, `format`,
 * numeric bounds. Instead of failing registration, unsupported constraints are
 * folded into the description (so the model still sees them) and the node
 * degrades to the closest supported shape.
 */

export type SchemaNode = Record<string, unknown>;

const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null']);
const TYPES = new Set([...SCALARS, 'object', 'array']);
const MAX_DEPTH = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isJson(v, depth + 1));
  if (isRecord(value)) return Object.values(value).every((v) => isJson(v, depth + 1));
  return false;
}

function scalarType(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? 'integer' : 'number';
  return null;
}

function matchesType(type: string, value: unknown): boolean {
  const actual = scalarType(value);
  if (actual === null) return false;
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

const HINT_KEYS: Array<[string, (v: unknown) => string]> = [
  ['format', (v) => `format: ${String(v)}`],
  ['pattern', (v) => `pattern: ${String(v)}`],
  ['minimum', (v) => `minimum ${String(v)}`],
  ['maximum', (v) => `maximum ${String(v)}`],
  ['exclusiveMinimum', (v) => `greater than ${String(v)}`],
  ['exclusiveMaximum', (v) => `less than ${String(v)}`],
  ['minLength', (v) => `min length ${String(v)}`],
  ['maxLength', (v) => `max length ${String(v)}`],
  ['minItems', (v) => `min items ${String(v)}`],
  ['maxItems', (v) => `max items ${String(v)}`],
  ['multipleOf', (v) => `multiple of ${String(v)}`],
];

function constraintHints(node: SchemaNode): string[] {
  const hints: string[] = [];
  for (const [key, render] of HINT_KEYS) {
    const value = node[key];
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') hints.push(render(value));
  }
  return hints;
}

function withHints(description: string, hints: string[]): string {
  if (hints.length === 0) return description;
  const suffix = `(${hints.join('; ')})`;
  return description ? `${description} ${suffix}` : suffix;
}

function annotations(node: SchemaNode, out: SchemaNode): SchemaNode {
  if (typeof node['title'] === 'string') out['title'] = node['title'];
  if (typeof node['description'] === 'string') out['description'] = node['description'];
  return out;
}

function descriptionOf(node: SchemaNode): string {
  return typeof node['description'] === 'string' ? node['description'] : '';
}

/** Resolve a local JSON pointer (`#/$defs/Name`, `#/definitions/Name`). */
function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined;
  const parts = ref.slice(1).split('/').filter(Boolean).map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
  let cur: unknown = root;
  for (const part of parts) {
    if (isRecord(cur)) cur = cur[part];
    else if (Array.isArray(cur)) cur = cur[Number(part)];
    else return undefined;
  }
  return cur;
}

function unconstrained(node: unknown, extraHints: string[] = []): SchemaNode {
  const out: SchemaNode = {};
  if (isRecord(node)) annotations(node, out);
  out['description'] = withHints(descriptionOf(out), extraHints) || 'Any JSON value.';
  return out;
}

function without(node: SchemaNode, ...keys: string[]): SchemaNode {
  return Object.fromEntries(Object.entries(node).filter(([k]) => !keys.includes(k)));
}

class Sanitizer {
  readonly root: unknown;
  readonly refStack: string[] = [];

  constructor(root: unknown) {
    this.root = root;
  }

  node(input: unknown, depth: number): SchemaNode {
    if (!isRecord(input)) return unconstrained(undefined);
    if (depth > MAX_DEPTH) return unconstrained(input, ['nested too deeply to describe']);

    // $ref: inline the target (local pointers only), guarding cycles.
    const ref = input['$ref'];
    if (typeof ref === 'string') {
      const target = resolveRef(this.root, ref);
      const cyclic = this.refStack.includes(ref);
      if (!isRecord(target) || cyclic) return unconstrained(input, [cyclic ? 'recursive structure' : `see ${ref}`]);
      this.refStack.push(ref);
      try {
        return this.node({ ...target, ...without(input, '$ref') }, depth + 1);
      } finally {
        this.refStack.pop();
      }
    }

    // allOf: merge a single member (pydantic wraps refs this way) or plain objects.
    const allOf = input['allOf'];
    if (Array.isArray(allOf)) {
      const rest = without(input, 'allOf');
      if (allOf.length === 1 && isRecord(allOf[0])) return this.node({ ...allOf[0], ...rest }, depth + 1);
      const members = allOf.map((m) => (isRecord(m) && typeof m['$ref'] === 'string' ? resolveRef(this.root, m['$ref']) : m));
      const objects = members.filter(isRecord);
      if (objects.length === allOf.length && objects.every((o) => o['type'] === 'object' || isRecord(o['properties']))) {
        const properties: Record<string, unknown> = {};
        const required: unknown[] = [];
        for (const o of objects) {
          if (isRecord(o['properties'])) Object.assign(properties, o['properties']);
          if (Array.isArray(o['required'])) required.push(...o['required']);
        }
        return this.node({ ...rest, type: 'object', properties, required }, depth + 1);
      }
      return unconstrained(input, ['must satisfy several schemas']);
    }

    const union = Array.isArray(input['anyOf']) ? input['anyOf'] : Array.isArray(input['oneOf']) ? input['oneOf'] : null;
    if (union) return this.union(input, union, depth);

    let type: unknown = input['type'];
    if (Array.isArray(type)) {
      const types = [...new Set(type.filter((t): t is string => typeof t === 'string' && TYPES.has(t)))];
      const nonNull = types.filter((t) => t !== 'null');
      if (nonNull.length === 1) {
        const single = this.node({ ...input, type: nonNull[0] }, depth + 1);
        if (types.includes('null')) single['description'] = withHints(descriptionOf(single), ['nullable']);
        return single;
      }
      if (types.length >= 2) {
        const out = annotations(input, {});
        out['oneOf'] = types.map((t) => ({ type: t }));
        return out;
      }
      return unconstrained(input);
    }
    if (type === undefined) {
      const enumValues = input['enum'];
      if (isRecord(input['properties'])) type = 'object';
      else if (input['items'] !== undefined) type = 'array';
      else if (Array.isArray(enumValues) && enumValues.length > 0) {
        const kinds = new Set(enumValues.map(scalarType));
        if (kinds.size === 1 && !kinds.has(null)) type = [...kinds][0];
        else if ([...kinds].every((k) => k === 'integer' || k === 'number')) type = 'number';
      } else if (input['const'] !== undefined) type = scalarType(input['const']) ?? undefined;
    }
    if (typeof type !== 'string' || !TYPES.has(type)) return unconstrained(input, constraintHints(input));

    const out = annotations(input, { type });
    const hints = constraintHints(input);
    if (input['default'] !== undefined && isJson(input['default'])) out['default'] = input['default'];
    if (Array.isArray(input['examples']) && isJson(input['examples'])) out['examples'] = input['examples'];

    if (type === 'object') {
      const props = isRecord(input['properties']) ? input['properties'] : {};
      const keys = Object.keys(props);
      if (keys.length > 0) {
        const properties: Record<string, SchemaNode> = {};
        for (const key of keys) properties[key] = this.node(props[key], depth + 1);
        out['properties'] = properties;
        if (Array.isArray(input['required'])) {
          const required = [...new Set(input['required'].filter((k): k is string => typeof k === 'string' && Object.hasOwn(properties, k)))];
          if (required.length > 0) out['required'] = required;
        }
      }
      if (typeof input['additionalProperties'] === 'boolean') out['additionalProperties'] = input['additionalProperties'];
      else if (isRecord(input['additionalProperties']) && keys.length === 0) hints.push('map of string keys to values');
      if (out['default'] !== undefined && !isRecord(out['default'])) delete out['default'];
    } else if (type === 'array') {
      if (isRecord(input['items'])) out['items'] = this.node(input['items'], depth + 1);
      else if (Array.isArray(input['items'])) hints.push(`tuple of ${input['items'].length} items`);
      if (input['uniqueItems'] === true) hints.push('unique items');
      if (out['default'] !== undefined && !Array.isArray(out['default'])) delete out['default'];
    } else {
      const enumValues = input['enum'];
      if (Array.isArray(enumValues)) {
        const values = [...new Set(enumValues.filter((v) => matchesType(type as string, v)))];
        if (values.length > 0) out['enum'] = values;
      }
      const constant = input['const'];
      if (constant !== undefined && matchesType(type, constant)) {
        const allowed = out['enum'];
        if (!Array.isArray(allowed) || allowed.includes(constant)) out['const'] = constant;
      }
      if (out['default'] !== undefined && !matchesType(type, out['default'])) delete out['default'];
    }
    if (hints.length > 0) out['description'] = withHints(descriptionOf(out), hints);
    return out;
  }

  union(input: SchemaNode, members: unknown[], depth: number): SchemaNode {
    const rest = without(input, 'anyOf', 'oneOf');
    const branches = members.filter(isRecord);
    const isNull = (b: SchemaNode): boolean => b['type'] === 'null'
      || (Array.isArray(b['enum']) && b['enum'].length === 1 && b['enum'][0] === null)
      || b['const'] === null;
    const nonNull = branches.filter((b) => !isNull(b));
    const first = nonNull[0];
    if (nonNull.length === 1 && first) {
      const single = this.node({ ...first, ...rest }, depth + 1);
      if (nonNull.length < branches.length) single['description'] = withHints(descriptionOf(single), ['optional, may be null']);
      return single;
    }
    const resolved = branches.map((b) => this.node(b, depth + 1));
    // `oneOf` in the registry means "exactly one branch matches"; that is only
    // safe when every branch has a distinct type. Otherwise widen.
    const types = resolved.map((b) => b['type']);
    const normalized = types.map((t) => (t === 'integer' ? 'number' : t));
    const distinct = types.every((t) => typeof t === 'string') && new Set(normalized).size === types.length;
    if (resolved.length >= 2 && distinct) {
      const out = annotations(rest, {});
      out['oneOf'] = resolved;
      return out;
    }
    const kinds = [...new Set(types.filter((t): t is string => typeof t === 'string'))];
    return unconstrained(rest, kinds.length > 0 ? [`one of: ${kinds.join(', ')}`] : []);
  }
}

/**
 * Sanitize a tool's input schema. Always returns an object-rooted schema the
 * registry accepts; an unusable input becomes `{ type: 'object' }`.
 */
export function sanitizeInputSchema(schema: unknown): SchemaNode {
  if (!isRecord(schema)) return { type: 'object', properties: {} };
  let out: SchemaNode;
  try {
    out = new Sanitizer(schema).node({ ...schema, type: schema['type'] ?? 'object' }, 0);
  } catch {
    return { type: 'object', properties: {} };
  }
  if (out['type'] !== 'object') {
    const description = descriptionOf(out);
    return { type: 'object', properties: {}, ...(description ? { description } : {}) };
  }
  delete out['default'];
  return out;
}
