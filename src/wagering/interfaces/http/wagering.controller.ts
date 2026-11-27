import { Body, Controller, ForbiddenException, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { type ProviderIdentity, ProviderAuthGuard } from '../../../auth/provider-auth.guard';
import { logContext } from '../../../observability/log-context';
import { WalletNotFoundError } from '../../application/errors';
import type { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import type { WageringQueries } from '../../application/wagering-queries';
import { idempotencyKeySchema, parseWith, toWagerPayload, wagerDataSchema } from '../contracts';
import { HttpConflictError, MissingIdempotencyKeyError } from './http-error.filter';
import { presentSubmission, presentTransaction, statusCodeFor } from './presenters';
import { PROCESS_WAGER, WAGERING_QUERIES } from './tokens';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(PROCESS_WAGER) private readonly processWager: ProcessWagerTransaction,
    @Inject(WAGERING_QUERIES) private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body() body: unknown,
    @Req() request: Request & { providerIdentity?: ProviderIdentity },
    @Res({ passthrough: true }) response: Response,
  ) {
    if (idempotencyKeyHeader === undefined || idempotencyKeyHeader === '') throw new MissingIdempotencyKeyError();
    const idempotencyKey = parseWith(idempotencyKeySchema, idempotencyKeyHeader);
    const payload = toWagerPayload(parseWith(wagerDataSchema, body));
    logContext.assign({ walletId: payload.walletId, providerId: payload.providerId });
    const callerProvider = request.providerIdentity?.providerId;
    if (callerProvider !== undefined && callerProvider !== payload.providerId) {
      throw new ForbiddenException('Authenticated provider does not match payload providerId');
    }

    const result = await this.processWager.execute(
      { idempotencyKey, payload },
      { source: 'http', correlationId: logContext.current().correlationId ?? idempotencyKey },
    );

    switch (result.type) {
      case 'completed':
        response.status(statusCodeFor(result.transaction, result.replay));
        if (result.replay) response.setHeader('Idempotent-Replay', 'true');
        return presentSubmission(result.transaction, result.replay);
      case 'idempotency_conflict':
        throw new HttpConflictError(
          'IDEMPOTENCY_KEY_CONFLICT',
          'Idempotency-Key was already used with a different payload',
          result.existingTransactionId,
        );
      case 'external_id_conflict':
        throw new HttpConflictError(
          'EXTERNAL_TRANSACTION_ID_CONFLICT',
          'externalTransactionId was already used with a different Idempotency-Key',
          result.existingTransactionId,
        );
      case 'wallet_not_found':
        throw new WalletNotFoundError(result.walletId);
      case 'duplicate_message':
        // Só acontece em entregas via inbox (fila).
        throw new Error('unexpected duplicate_message outcome on HTTP');
    }
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId', new ParseUUIDPipe()) transactionId: string) {
    return presentTransaction(await this.queries.getTransaction(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return presentTransaction(await this.queries.getTransactionByExternalId(providerId, externalTransactionId));
  }
}
