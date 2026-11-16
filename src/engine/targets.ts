/**
 * Namespaced target ids, e.g. `sat:25544`, `body:moon`, `star:123`, `con:Ori`.
 * Kept free of engine imports so the UI and tests can use them cheaply.
 */

import type { TargetRef } from '../types';

export function targetId(target: TargetRef | null): string | null {
  if (!target) return null;
  switch (target.kind) {
    case 'satellite':
      return `sat:${target.id}`;
    case 'body':
      return `body:${target.id}`;
    case 'star':
      return `star:${target.id}`;
    case 'constellation':
      return `con:${target.id}`;
    case 'asterism':
      return `ast:${target.id}`;
    default:
      return null;
  }
}

export function parseTargetId(id: string): TargetRef | null {
  const separator = id.indexOf(':');
  if (separator < 0) return null;
  const prefix = id.slice(0, separator);
  const value = id.slice(separator + 1);
  switch (prefix) {
    case 'sat':
      return { kind: 'satellite', id: value };
    case 'body':
      return { kind: 'body', id: value };
    case 'star':
      return { kind: 'star', id: value };
    case 'con':
      return { kind: 'constellation', id: value };
    case 'ast':
      return { kind: 'asterism', id: value };
    default:
      return null;
  }
}
