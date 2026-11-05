import { utf8Bytes } from './protocol';
import { executionLimits } from './execution-limits';

// Build a detached JSON DTO while enforcing limits before accumulating its text.
export function executionJson(value: unknown, maxBytes: number = executionLimits.maxResultBytes): { value: unknown; json: string } {
  let count = 0, bytes = 0;
  const ancestors = new Set<object>();
  const append = (s: string) => { bytes += utf8Bytes(s); if (bytes > maxBytes) throw new Error('RESOURCE_LIMIT'); return s; };
  const visit = (item: unknown, depth: number): string => {
    if (++count > executionLimits.maxValues || depth > executionLimits.maxDepth) throw new Error('RESULT_NOT_SERIALIZABLE');
    if (typeof item === 'string' && utf8Bytes(item) > maxBytes - bytes) throw new Error('RESOURCE_LIMIT');
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) return append(JSON.stringify(item));
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error('RESULT_NOT_SERIALIZABLE');
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('RESULT_NOT_SERIALIZABLE');
    ancestors.add(item);
    if (Array.isArray(item) && item.length > executionLimits.maxValues) throw new Error('RESULT_NOT_SERIALIZABLE');
    const ownKeys = Reflect.ownKeys(item);
    if (ownKeys.length > executionLimits.maxValues + (Array.isArray(item) ? 1 : 0) || ownKeys.some(key => typeof key !== 'string')) throw new Error('RESULT_NOT_SERIALIZABLE');
    let result = append(Array.isArray(item) ? '[' : '{');
    const enumerable: string[] = [];
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('RESULT_NOT_SERIALIZABLE');
      if (descriptor.enumerable) enumerable.push(key);
    }
    const keys = Array.isArray(item) ? Array.from({ length: item.length }, (_, i) => String(i)) : enumerable;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i], descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('RESULT_NOT_SERIALIZABLE');
      if (i) result += append(',');
      if (!Array.isArray(item)) {
        if (utf8Bytes(key) > maxBytes - bytes) throw new Error('RESOURCE_LIMIT');
        result += append(JSON.stringify(key) + ':');
      }
      result += visit(descriptor.value, depth + 1);
    }
    result += append(Array.isArray(item) ? ']' : '}');
    ancestors.delete(item);
    return result;
  };
  const json = visit(value === undefined ? null : value, 0);
  return { value: JSON.parse(json), json };
}
