/**
 * Base dos erros lançados pelo domínio. Erro de domínio é determinístico:
 * repetir a mesma entrada sempre dá o mesmo erro.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor(walletId: string) {
    super(`Wallet ${walletId} has insufficient funds`);
  }
}

/** Pediram para um objeto de domínio uma transição que o estado dele não permite (erro de programação). */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(message: string) {
    super(message);
  }
}

/** Uma invariante que deveria valer por construção foi violada. */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
  constructor(message: string) {
    super(message);
  }
}

/** Violação do contrato de entrada (referência faltando, kind proibido, ids malformados...). */
export class DomainValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
  }
}
