import { createHash } from 'node:crypto';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

/**
 * JSON determinístico: chaves dos objetos ordenadas (recursivamente, por code unit UTF-16),
 * sem espaços, membros `undefined` omitidos. Arrays mantêm a ordem.
 */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const members = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`);
  return `{${members.join(',')}}`;
}

/** `sha256(canonicalJson(value))` em hexadecimal. */
export function sha256OfCanonicalJson(value: Json): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
