/**
 * Erros da camada de aplicação. Cada um corresponde a exatamente um status HTTP e um
 * comportamento do consumer (ack / retry / DLQ) — ver o filtro de erros HTTP e o consumer SQS.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  constructor(reference: string) {
    super(`Transaction ${reference} not found`);
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';
  constructor() {
    super('Cursor is malformed or does not belong to this wallet');
  }
}

/** Falha temporária de infraestrutura (DB/SQS fora, lock timeout, deadlock...). Pode repetir. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';
  constructor(
    message: string,
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** A guarda otimista de um UPDATE condicional não achou nenhuma linha. Pode repetir. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';
  constructor(message: string) {
    super(message);
  }
}

/** Mensagem de fila que nunca vai poder ser processada (malformada, contradiz uma entrega anterior...). */
export class PermanentMessageError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
