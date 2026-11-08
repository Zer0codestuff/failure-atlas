import { cloneJson, type Json } from './hash';

/**
 * Redaction before export. The automatic rules catch common credential shapes
 * and sensitive field names; they do not find everything. The preview lists
 * every value that will be replaced and the exported bundle records which
 * rules ran, so a person can inspect what leaves the machine.
 */

export interface RedactionRule {
  id: string;
  description: string;
  /** Matches a key name (case-insensitive) anywhere in the document. */
  key?: RegExp;
  /** Matches inside string values. */
  value?: RegExp;
}

export const DEFAULT_RULES: RedactionRule[] = [
  { id: 'auth-header', description: 'Authorization, cookie and API key headers or fields', key: /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey)$/i },
  { id: 'secret-field', description: 'Fields named like secrets, tokens or passwords', key: /(secret|password|passwd|token|private[-_]?key|credential)/i },
  { id: 'bearer', description: 'Bearer tokens', value: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { id: 'openai-style-key', description: 'Keys shaped like sk-...', value: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'github-token', description: 'GitHub tokens (ghp_, gho_, ghs_, github_pat_)', value: /\b(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: 'aws-access-key', description: 'AWS access key IDs', value: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'slack-token', description: 'Slack tokens', value: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'jwt', description: 'JSON Web Tokens', value: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

export interface RedactionFinding {
  path: string;
  rule: string;
  /** A masked preview: first and last characters only. */
  preview: string;
}

export interface RedactionResult<T> {
  output: T;
  findings: RedactionFinding[];
  rules: string[];
  userPaths: string[];
  disclaimer: string;
}

const DISCLAIMER = 'Automatic redaction matches common credential patterns and field names. It cannot find every secret or personal detail. Review the preview before sharing.';

function mask(s: string): string {
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`;
}

/** Path patterns: dot paths with "*" for any key or index, for example "events.*.data.args.email". */
function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.split('.');
  const q = path.split('.');
  if (p.length !== q.length) return false;
  return p.every((seg, i) => seg === '*' || seg === q[i]);
}

export function redact<T>(input: T, opts: { rules?: RedactionRule[]; userPaths?: string[] } = {}): RedactionResult<T> {
  const rules = opts.rules ?? DEFAULT_RULES;
  const userPaths = opts.userPaths ?? [];
  const findings: RedactionFinding[] = [];
  const out = cloneJson(input) as unknown as Json;

  const walk = (node: Json, path: string): Json => {
    if (userPaths.some((p) => pathMatches(p, path))) {
      findings.push({ path, rule: 'user-selected', preview: mask(typeof node === 'string' ? node : JSON.stringify(node)) });
      return '[REDACTED:user-selected]';
    }
    if (typeof node === 'string') {
      let s = node;
      for (const r of rules) {
        if (!r.value) continue;
        s = s.replace(r.value, (m) => {
          findings.push({ path, rule: r.id, preview: mask(m) });
          return `[REDACTED:${r.id}]`;
        });
      }
      return s;
    }
    if (Array.isArray(node)) return node.map((v, i) => walk(v, path ? `${path}.${i}` : String(i)));
    if (node && typeof node === 'object') {
      const res: Record<string, Json> = {};
      for (const [k, v] of Object.entries(node)) {
        const childPath = path ? `${path}.${k}` : k;
        const keyRule = rules.find((r) => r.key && r.key.test(k) && v !== null && typeof v !== 'object' && typeof v !== 'boolean');
        if (keyRule) {
          findings.push({ path: childPath, rule: keyRule.id, preview: mask(String(v)) });
          res[k] = `[REDACTED:${keyRule.id}]`;
        } else res[k] = walk(v, childPath);
      }
      return res;
    }
    return node;
  };

  const output = walk(out, '') as unknown as T;
  return { output, findings, rules: rules.map((r) => r.id), userPaths, disclaimer: DISCLAIMER };
}
