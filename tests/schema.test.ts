import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeInputSchema } from '../src/host/schema.ts';

/** The registry's supported keyword subset (mirrors dsh-tools assertSupportedJsonSchema). */
const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);

function assertSupported(node: unknown, path = 'schema'): void {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${path} must be an object`);
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) assert.ok(ALLOWED.has(key), `${path}.${key} is not supported`);
  assert.ok(!('type' in record && 'oneOf' in record), `${path} has both type and oneOf`);
  if (Array.isArray(record['type'])) assert.fail(`${path}.type is an array`);
  if (record['properties']) for (const [k, v] of Object.entries(record['properties'] as object)) assertSupported(v, `${path}.properties.${k}`);
  if (record['items']) assertSupported(record['items'], `${path}.items`);
  if (record['oneOf']) (record['oneOf'] as unknown[]).forEach((b, i) => assertSupported(b, `${path}.oneOf[${i}]`));
  if (Array.isArray(record['required'])) {
    for (const r of record['required']) assert.ok(Object.hasOwn((record['properties'] ?? {}) as object, r as string), `${path}.required names unknown ${String(r)}`);
  }
  if ('additionalProperties' in record) assert.equal(typeof record['additionalProperties'], 'boolean');
}

describe('schema sanitizer', () => {
  it('turns a pydantic/FastMCP schema into the supported subset', () => {
    const out = sanitizeInputSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      title: 'search_issuesArguments',
      properties: {
        query: { type: 'string', minLength: 1, description: 'JQL' },
        limit: { anyOf: [{ type: 'integer', maximum: 50 }, { type: 'null' }], default: 10 },
        fields: { type: ['array', 'null'], items: { type: 'string' } },
        sort: { $ref: '#/$defs/Sort' },
        filter: { allOf: [{ $ref: '#/$defs/Filter' }] },
        meta: { type: 'object', additionalProperties: { type: 'string' } },
        when: { type: 'string', format: 'date-time' },
        either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        overlapping: { anyOf: [{ type: 'string' }, { type: 'string', enum: ['a'] }] },
      },
      required: ['query', 'ghost'],
      $defs: {
        Sort: { type: 'string', enum: ['asc', 'desc'] },
        Filter: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
      },
    });
    assertSupported(out);
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(out['required'], ['query']);
    assert.equal(props['limit']?.['type'], 'integer');
    assert.equal(props['limit']?.['default'], 10);
    assert.match(String(props['limit']?.['description']), /maximum 50/);
    assert.equal(props['fields']?.['type'], 'array');
    assert.deepEqual(props['sort']?.['enum'], ['asc', 'desc']);
    assert.equal(props['filter']?.['type'], 'object');
    assert.match(String(props['when']?.['description']), /date-time/);
    assert.equal((props['either']?.['oneOf'] as unknown[]).length, 2);
    assert.equal(props['overlapping']?.['type'], undefined, 'overlapping branches widen instead of becoming oneOf');
  });

  it('survives recursive references', () => {
    const out = sanitizeInputSchema({ type: 'object', properties: { node: { $ref: '#/$defs/Node' } }, $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } } });
    assertSupported(out);
  });

  it('always returns an object root', () => {
    assert.deepEqual(sanitizeInputSchema(undefined), { type: 'object', properties: {} });
    assert.equal(sanitizeInputSchema({ type: 'string' })['type'], 'object');
    assertSupported(sanitizeInputSchema({ properties: { a: { enum: [1, 2] } } }));
  });
});
