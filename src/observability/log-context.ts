import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de correlação que acompanham as chamadas async e entram em toda linha de log. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const logContext = {
  run<T>(context: LogContext, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...context }, fn);
  },
  /** Acrescenta campos no contexto atual (ex.: o transactionId quando ele passa a existir). */
  assign(fields: LogContext): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
  current(): LogContext {
    return storage.getStore() ?? {};
  },
};
