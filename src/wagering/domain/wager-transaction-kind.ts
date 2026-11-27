export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada (estado inicial em memória). */
  Pending = 'PENDING',
  /** Esperando a transação referenciada chegar. */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada. Terminal. */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio. Terminal. */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura. Terminal, auditável. */
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);
