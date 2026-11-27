/**
 * Motivos estáveis e legíveis por máquina para uma transação terminar REJECTED ou FAILED.
 * Os valores são persistidos e publicados: nunca renomear, só acrescentar.
 *
 * Todo código é terminal para aquele payload: reenviar a mesma requisição é replay
 * e devolve o mesmo resultado. O provedor corrige o payload e manda com um
 * externalTransactionId NOVO, ou desiste.
 */
export enum FailureCode {
  // ---- REJECTED: regras de negócio -----------------------------------------
  /** BET maior que o saldo disponível. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Um ROLLBACK que precisa debitar (revertendo WIN/REFUND) deixaria o saldo negativo. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** O `playerId` do payload não é dono do `walletId`. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** A transação referenciada nunca chegou dentro do orçamento de retries. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência existe mas é de outro provider, player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** O kind da referência não pode ser alvo desta operação (ex.: REFUND de um WIN). */
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  /** A referência terminou REJECTED/FAILED, então não há o que reverter ou liquidar. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** A referência já foi revertida (REFUND ou ROLLBACK). */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Valor do REFUND/ROLLBACK diferente do valor referenciado (reversão parcial está fora do escopo). */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',

  // ---- FAILED: erros permanentes de infraestrutura (auditáveis) -------------
  /** A mensagem não conseguiu ser processada dentro do orçamento de entregas. */
  ProcessingRetriesExhausted = 'PROCESSING_RETRIES_EXHAUSTED',
}

export const REJECTION_CODES: ReadonlySet<FailureCode> = new Set([
  FailureCode.InsufficientFunds,
  FailureCode.ReversalInsufficientFunds,
  FailureCode.CurrencyMismatch,
  FailureCode.PlayerWalletMismatch,
  FailureCode.ReferenceNotFound,
  FailureCode.ReferenceMismatch,
  FailureCode.ReferenceInvalidKind,
  FailureCode.ReferenceNotProcessed,
  FailureCode.ReferenceAlreadyReversed,
  FailureCode.ReferenceAmountMismatch,
]);
