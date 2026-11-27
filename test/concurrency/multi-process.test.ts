import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createWallet,
  drainQueue,
  ensureSchema,
  eventually,
  expectConsistent,
  http,
  sendToQueue,
  setupQueues,
  sql,
  submit,
  testConfig,
  testEnv,
  transactionsOf,
  uniquePrefix,
  wagerBody,
  wagerMessage,
} from '../support/harness';
import { type Instance, spawnInstance } from '../support/instances';

/*
 * Processos de SO separados rodando src/main.ts — exatamente o que roda em produção —
 * dividindo um PostgreSQL e um conjunto de filas SQS.
 */

const running: Instance[] = [];
async function spawn(name: string, env: Record<string, string>, waitReady = true) {
  const instance = await spawnInstance(name, env, waitReady);
  running.push(instance);
  return instance;
}

beforeAll(ensureSchema);
afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.stop('SIGKILL')));
});

async function metricOf(instance: Instance, pattern: RegExp): Promise<number> {
  const text = await (await fetch(`${instance.url}/metrics`)).text();
  return Number(text.match(pattern)?.[1] ?? 0);
}

describe('three instances', () => {
  test('mixed HTTP + SQS load with duplicates across 3 processes keeps every invariant', async () => {
    const prefix = uniquePrefix('multi');
    const env = testEnv(prefix);
    await setupQueues(testConfig(prefix));
    const instances = await Promise.all(['inst-1', 'inst-2', 'inst-3'].map((n) => spawn(n, env)));
    const config = testConfig(prefix);

    const wallets = await Promise.all(Array.from({ length: 4 }, (_, i) => createWallet(instances[i % 3]!.url, '500.00')));
    const work: Promise<unknown>[] = [];
    let opIndex = 0;
    for (const { walletId, playerId } of wallets) {
      for (let i = 0; i < 25; i++) {
        const target = instances[opIndex++ % 3]!;
        const kind = i % 5 === 0 ? 'WIN' : 'BET';
        const message = wagerMessage({ walletId, playerId, kind, amount: '2.00' });
        const { idempotencyKey, ...body } = message.data;
        // toda operação é entregue duas vezes: uma por HTTP, outra pela fila
        work.push(submit(target.url, body, idempotencyKey));
        work.push(sendToQueue(config, config.sqs.wagerQueueName, message, walletId));
        // e uma terceira vez por HTTP em outra instância
        work.push(submit(instances[opIndex % 3]!.url, body, idempotencyKey));
      }
      // um par fora de ordem, cada metade numa instância diferente
      const betId = `bet-${randomUUID()}`;
      work.push(
        submit(instances[0]!.url, wagerBody({ walletId, playerId, kind: 'ROLLBACK', amount: '7.00', referenceExternalTransactionId: betId })),
      );
      work.push(submit(instances[2]!.url, wagerBody({ walletId, playerId, kind: 'BET', amount: '7.00', externalTransactionId: betId })));
    }
    await Promise.all(work);

    for (const { walletId } of wallets) {
      await eventually(
        () => transactionsOf(walletId),
        (t) => t.length === 27 && t.every((x) => x.status === 'PROCESSED'),
        30_000,
      );
      const state = await expectConsistent(walletId);
      // 5 WIN (+10.00), 20 BET (−40.00), BET + ROLLBACK se anulam
      expect(state.balance).toBe('470.00');
      expect(state.debits).toBe(21);
      expect(state.credits).toBe(1 + 5 + 1);
      const rec = await http(instances[1]!.url, 'POST', `/wallets/${walletId}/reconciliation`);
      expect(rec.body.consistent).toBe(true);
    }

    // nenhuma transação processada que mexe em saldo pode ter outro número de lançamentos que não 1
    const walletIds = wallets.map((w) => w.walletId);
    const orphans = await sql`
      SELECT t.id FROM wager_transactions t
       WHERE t.wallet_id IN ${sql(walletIds)} AND t.status = 'PROCESSED' AND t.kind <> 'LOSS'
         AND (SELECT count(*) FROM wallet_ledger_entries l WHERE l.transaction_id = t.id) <> 1`;
    expect(orphans.length).toBe(0);

    // o trabalho foi mesmo dividido entre os processos, e a fila foi consumida por vários
    const perInstance = await Promise.all(
      instances.map((i) => metricOf(i, /wagering_transactions_total\{kind="BET",status="PROCESSED",source="(?:http|sqs|worker)"\} (\d+)/)),
    );
    expect(perInstance.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);

    // todo evento commitado é publicado por um dos três publishers do outbox
    // (timeout folgado: os publishers também drenam linhas que outros arquivos de teste deixaram
    // pendentes, das mais antigas primeiro, e o emulador local de SQS é bem mais lento que o SQS)
    await eventually(
      async () => (await sql`SELECT id FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)} AND published_at IS NULL`).length,
      (n) => n === 0,
      60_000,
    );
    const expectedEvents = ((await sql`SELECT id FROM outbox_messages WHERE aggregate_id IN ${sql(walletIds)}`) as Array<{ id: string }>).map(
      (r) => r.id,
    );
    const received = (await drainQueue(config, config.sqs.eventsQueueName, 1)).filter((m) => walletIds.includes(m.body.aggregateId));
    expect([...new Set(received.map((m) => m.body.eventId))].sort()).toEqual(expectedEvents.sort());
  });
});

describe('crashes', () => {
  test('worker killed after COMMIT and before ACK: the redelivery is deduplicated by the inbox', async () => {
    const prefix = uniquePrefix('crash');
    const env = testEnv(prefix, { CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '3' });
    const config = testConfig(prefix);
    await setupQueues(config);
    const api = await spawn('api', { ...env, APP_ROLES: 'api' });
    const { walletId, playerId } = await createWallet(api.url, '100.00');

    const crasher = await spawn('crasher', {
      ...env,
      APP_ROLES: 'consumer',
      FAULT_INJECTION: 'consumer.afterCommitBeforeAck=crash',
    });
    const message = wagerMessage({ walletId, playerId, kind: 'BET', amount: '35.00' });
    await sendToQueue(config, config.sqs.wagerQueueName, message, walletId);

    await crasher.exited; // se matou com SIGKILL logo depois do COMMIT
    expect(crasher.process.signalCode).toBe('SIGKILL');
    const committed = await transactionsOf(walletId);
    expect(committed).toEqual([expect.objectContaining({ status: 'PROCESSED' })]);

    const survivor = await spawn('survivor', { ...env, APP_ROLES: 'consumer' });
    await eventually(
      () => metricOf(survivor, /wagering_duplicates_detected_total\{mechanism="inbox"\} (\d+)/),
      (n) => n >= 1,
      20_000,
    );
    const state = await expectConsistent(walletId);
    expect(state.balance).toBe('65.00');
    expect(state.debits).toBe(1);
    // e a mensagem saiu da fila (ack dado pelo sobrevivente)
    expect((await drainQueue(config, config.sqs.wagerQueueName, 1)).length).toBe(0);
  });

  test('instance killed (SIGKILL) under load, restarted, provider retries everything: final state is exact', async () => {
    const prefix = uniquePrefix('restart-load');
    const env = testEnv(prefix, { CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '3' });
    const config = testConfig(prefix);
    await setupQueues(config);
    const first = await spawn('doomed', env);

    const httpWallet = await createWallet(first.url, '1000.00');
    const sqsWallet = await createWallet(first.url, '1000.00');
    const httpOps = Array.from({ length: 80 }, () => wagerBody({ ...httpWallet, kind: 'BET', amount: '3.00' }));
    const sqsOps = Array.from({ length: 80 }, () => wagerMessage({ ...sqsWallet, kind: 'BET', amount: '3.00' }));
    await Promise.all(sqsOps.map((m) => sendToQueue(config, config.sqs.wagerQueueName, m, sqsWallet.walletId)));

    const inFlight = Promise.allSettled(httpOps.map((body) => submit(first.url, body)));
    await Bun.sleep(150);
    await first.stop('SIGKILL');
    const results = await inFlight;
    const interrupted = results.filter((r) => r.status === 'rejected' || (r.value as { status: number }).status !== 201).length;

    const second = await spawn('reborn', env);
    // at-least-once do lado do provedor: reenvia toda operação HTTP; a fila reentrega o resto
    const retried = await Promise.all(httpOps.map((body) => submit(second.url, body)));
    expect(retried.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(retried.filter((r) => r.status === 200).length).toBe(80 - retried.filter((r) => r.status === 201).length);

    await eventually(() => transactionsOf(sqsWallet.walletId), (t) => t.length === 80, 30_000);
    for (const wallet of [httpWallet, sqsWallet]) {
      const state = await expectConsistent(wallet.walletId);
      expect(state.balance).toBe('760.00');
      expect(state.debits).toBe(80);
    }
    expect(interrupted).toBeGreaterThanOrEqual(0); // só informativo: requisições cortadas pelo kill
  });
});
