import type { JsonSchema } from './types';

export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * A deliberately small JSON Schema subset validator (type, properties, required,
 * additionalProperties, items, enum, minimum, maximum, minLength, minItems, pattern).
 * Unsupported keywords are not silently treated as satisfied: they are listed in
 * docs/SCHEMAS.md and rejected when contracts are loaded.
 */
export const SUPPORTED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minimum', 'maximum', 'minLength', 'minItems', 'pattern', 'description',
]);

export function checkSchemaKeywords(schema: JsonSchema, path = '$'): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) issues.push({ path, message: `Unsupported schema keyword "${key}"` });
  }
  if (schema.properties) {
    for (const [k, s] of Object.entries(schema.properties)) issues.push(...checkSchemaKeywords(s, `${path}.${k}`));
  }
  if (schema.items) issues.push(...checkSchemaKeywords(schema.items, `${path}[]`));
  return issues;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

export function validate(schema: JsonSchema, value: unknown, path = '$'): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (value === undefined) {
    issues.push({ path, message: 'Value is missing' });
    return issues;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      issues.push({ path, message: `Expected ${types.join(' or ')}, received ${actual}` });
      return issues;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    issues.push({ path, message: `Value is not one of ${JSON.stringify(schema.enum)}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `Below minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `Above maximum ${schema.maximum}` });
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push({ path, message: `Shorter than ${schema.minLength}` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) issues.push({ path, message: `Does not match ${schema.pattern}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `Fewer than ${schema.minItems} items` });
    if (schema.items) value.forEach((item, i) => issues.push(...validate(schema.items!, item, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj) || obj[req] === undefined) issues.push({ path: `${path}.${req}`, message: 'Required field is missing' });
    }
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) issues.push(...validate(sub, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) issues.push({ path: `${path}.${k}`, message: 'Unexpected field' });
    }
  }
  return issues;
}
