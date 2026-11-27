import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ProviderAuthGuard } from '../../../auth/provider-auth.guard';
import { logContext } from '../../../observability/log-context';
import { uuidv7 } from '../../../shared/domain/ids';
import type { CreateWallet } from '../../application/create-wallet';
import type { ReconcileWallet } from '../../application/reconcile-wallet';
import type { WageringQueries } from '../../application/wagering-queries';
import { createWalletSchema, parseMoney, parseWith } from '../contracts';
import { presentLedgerEntry, presentReconciliation, presentWallet } from './presenters';
import { CREATE_WALLET, RECONCILE_WALLET, WAGERING_QUERIES } from './tokens';

const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: CreateWallet,
    @Inject(RECONCILE_WALLET) private readonly reconcileWallet: ReconcileWallet,
    @Inject(WAGERING_QUERIES) private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = parseWith(createWalletSchema, body);
    const wallet = await this.createWallet.execute(
      { playerId: input.playerId.toLowerCase(), initialBalance: parseMoney(input.initialBalance, 'initialBalance') },
      logContext.current().correlationId ?? uuidv7(),
    );
    const { createdAt: _c, updatedAt: _u, ...view } = presentWallet(wallet);
    return view;
  }

  @Get(':walletId')
  async get(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return presentWallet(await this.queries.getWallet(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId', new ParseUUIDPipe()) walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parseWith(ledgerQuerySchema, query);
    const page = await this.queries.getLedgerPage(walletId, cursor, limit);
    return { walletId, entries: page.entries.map(presentLedgerEntry), nextCursor: page.nextCursor };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return presentReconciliation(await this.reconcileWallet.execute(walletId));
  }
}
