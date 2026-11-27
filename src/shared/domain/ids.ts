import { randomFillSync } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): timestamp unix-ms de 48 bits + bits aleatórios. Ids ordenados no tempo
 * deixam os inserts no B-tree quase sempre no fim e os ids ficam ordenáveis por criação.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
