# ㉿ ARCHITECTURE — Distributed Wagering Processor

Este documento explica **por que** o sistema é como é: as garantias, onde cada uma é aplicada, as alternativas descartadas e as limitações conhecidas.

---

## 1. Visão geral

```
            HTTP (providers)                          SQS wager-transactions.fifo
                  │                                              │
        ┌─────────▼─────────┐                        ┌───────────▼───────────┐
        │ WageringController│                        │ WagerTransactionConsumer│  inbox receipt
        └─────────┬─────────┘                        └───────────┬───────────┘
                  │            mesmo use case                    │
                  └──────────────► ProcessWagerTransaction ◄─────┘
                                         │  1 transação SQL
              ┌──────────────┬───────────┼─────────────┬───────────────┐
              ▼              ▼           ▼             ▼               ▼
          inbox_messages  wallets   wager_transactions  wallet_ledger_entries  outbox_messages
                          (FOR UPDATE)                  (append-only)          │
                                                                               ▼
     PendingReferenceWorker ── reavalia PENDING_REFERENCE          OutboxPublisher (N instâncias,
                                                                   lease + SKIP LOCKED)
                                                                               │
                                                                   SQS wagering-events.fifo
```

Cada instância roda os papéis `api`, `consumer`, `outbox` e `pending-references` (configurável via `APP_ROLES`, para escalar papéis separadamente). **Nenhum estado relevante vive em memória**: idempotência, inbox, referências pendentes e eventos não publicados estão no PostgreSQL. Por isso qualquer número de instâncias pode rodar ao mesmo tempo, e qualquer uma pode morrer a qualquer momento.

### Camadas

```
src/
  shared/domain/          Money, erros de domínio, canonical JSON, UUIDv7, backoff
  wagering/domain/        Wallet (aggregate root), WagerTransaction, WalletLedgerEntry,
                          WagerSettlement (regras puras), eventos, Inbox/Outbox
  wagering/application/   use cases + portas (UnitOfWork, repositórios, Clock, Telemetry, FaultInjector)
  wagering/infrastructure/
    persistence/          MikroORM: EntitySchema, mappers, repositórios, migrations
    messaging/            SQS gateway, consumer, outbox publisher
    workers/              pending-reference worker
  wagering/interfaces/    contratos (zod) compartilhados por HTTP e SQS, controllers, filtro de erros
  observability/          logger JSON + contexto (AsyncLocalStorage), métricas Prometheus, health
  auth/                   ponto de extensão de autenticação (ver §14)
```

- O **domínio** não importa NestJS nem MikroORM. Entidades têm construtor `private`, factories `create/open/from` (validam) e `rehydrate` (não revalida transições).
- A **aplicação** é TypeScript puro (sem decorators); o `AppModule` faz a fiação com factories. Os use cases dependem de **portas** (`UnitOfWork`, `WageringTelemetry`, `Clock`, `FaultInjector`).
- HTTP e SQS usam **os mesmos contratos** (`interfaces/contracts.ts`) e **o mesmo use case** — é impossível um transporte aceitar algo que o outro rejeita.

---

## 2. Stack e versões

| Item | Versão | Observação |
|---|---|---|
| Bun | 1.4.5 | runtime, package manager e test runner |
| TypeScript | 5.9, `strict` + `noUncheckedIndexedAccess` | |
| NestJS | 11.2 (linha `legacy`) | 12.x existe; preferi a major que conheço a fundo num sistema financeiro |
| MikroORM | 6.6 (`latest-v6`) | 7.x existe (trocou knex por kysely); mesma razão |
| PostgreSQL | 17 (compose) / 18 (validado localmente) | |
| SQS | LocalStack 3.8 (compose) | qualquer endpoint SQS-compatível via `AWS_ENDPOINT_URL` |
| Validação | zod 3.25 | |
| Métricas | prom-client 15 | |

---

## 3. ORM: MikroORM e a estratégia transacional

**Por que MikroORM** (preferencial no desafio): `EntityManager.transactional()` com fork por unidade de trabalho (identity map isolado por requisição), `LockMode.PESSIMISTIC_WRITE`, migrations versionadas com `up`/`down`, e `EntitySchema` — que permite mapear tabelas **sem decorators nas classes de domínio**.

**Mapeamento:** registros de persistência (`schemas.ts`) + mappers explícitos (`mappers.ts`) que chamam `Wallet.rehydrate(...)`, `WagerTransaction.rehydrate(...)` etc. O domínio nunca vê um tipo do ORM.

**Mapeamento do `Money`:** duas colunas, `amount NUMERIC(20,2)` + `currency CHAR(3)`. O driver devolve `numeric` como **string** (`"975.00"`), que vira `Money` no mapper — em nenhum ponto o valor passa por `number`. Somas na reconciliação são feitas em SQL `NUMERIC` e lidas como texto.

**Estratégia transacional** (`MikroOrmUnitOfWork`):

- uma `em.fork({ clear: true }).transactional(...)` por operação; o use case recebe um `TransactionScope` com repositórios ligados àquela transação;
- `READ COMMITTED` (padrão) + `SELECT ... FOR UPDATE` na wallet: depois de obter o lock, cada statement enxerga o commit de quem segurava o lock antes (ver §5);
- `SET LOCAL lock_timeout` (5 s) e `statement_timeout` (15 s) por transação: um lock preso vira erro **transitório** rápido (503 / retry), nunca espera infinita;
- `REPEATABLE READ` + `readOnly` na reconciliação (snapshot consistente de wallet + ledger sem lock);
- erros do driver são traduzidos (`pg-errors.ts`) para a taxonomia da aplicação: `TransientInfrastructureError` (40001, 40P01, 55P03, 57014, 08xxx, 53300, ECONNREFUSED…) ou `InvariantViolationError` (trigger `WG001`, CHECK, FK).

**Onde uso o ORM e onde uso SQL explícito.** Leituras usam `find/findOne/count` e o lock usa `LockMode`. As escritas **cuja semântica é o próprio mecanismo de correção** são statements explícitos executados na ordem do código, não deixados para o `flush` do Unit of Work:
`INSERT … ON CONFLICT DO NOTHING RETURNING` (idempotência e inbox), `UPDATE wallets … WHERE version = :expected` (guarda otimista), o claim do outbox com `FOR UPDATE SKIP LOCKED`. Um flush diferido esconderia a ordem de locks e inserts, que é exatamente o que precisa ser auditável aqui. Trade-off: menos "mágica" do ORM, mais SQL para revisar — aceitável para ~10 statements críticos.

---

## 4. Money

`Money` é imutável; internamente guarda **unidades mínimas em `bigint`** com escala fixa 2. Toda aritmética é exata (`0.10 + 0.20 = 0.30`; somar `0.01` mil vezes dá `10.00`).

- Entrada: string decimal `^(0|[1-9]\d*)(\.\d{1,2})?$`; aceita 0–2 casas e **normaliza** para 2 (`"25"` → `"25.00"`).
- Rejeita: `NaN`, `Infinity`, notação científica, string vazia, espaços, vírgula, zeros à esquerda, `+`, mais de 2 casas (**não arredonda** — arredondar um valor de provedor é erro financeiro), negativos em contratos, números JS (`25` ou `0.1` como `number`), mais de 15 dígitos inteiros (cabe com folga em `NUMERIC(20,2)`, inclusive em somas).
- `Money.fromSigned` existe só para valores internos (diferença da reconciliação).
- Operações entre moedas diferentes lançam `CurrencyMismatchError`. O modelo é multi-moeda (uma wallet por `player + currency`); o desafio usa BRL. **Limitação:** escala 2 para todas as moedas (JPY=0, BHD=3 exigiriam escala por moeda).

---

## 5. Concorrência

**Unidade de concorrência: a wallet.** Estratégia: **lock pessimista por linha** (`SELECT … FOR UPDATE` na wallet) + **update condicional por versão** + **constraints no banco**.

Protocolo de `ProcessWagerTransaction` (uma transação SQL):

1. *(SQS)* `INSERT inbox ON CONFLICT DO NOTHING` — uma entrega duplicada concorrente bloqueia no índice único até a primeira terminar e então vê o conflito.
2. **Fast path de idempotência sem lock**: um replay nunca toca a linha quente da wallet (50 réplicas paralelas não disputam o lock).
3. `SELECT wallet FOR UPDATE` — serializa todos os escritores **daquela** wallet, em todas as instâncias. Wallets diferentes não se bloqueiam (não existe lock global).
4. Re-checa a idempotency key **sob o lock** (em READ COMMITTED, o statement vê o commit de quem segurava o lock).
5. Decide com regras puras (`WagerSettlement`) e escreve: `INSERT transaction ON CONFLICT DO NOTHING` (primeira escrita; cobre a mesma key chegando com outra wallet), ledger, `UPDATE wallets SET balance, version WHERE id AND version = :expected` (se 0 linhas → `ConcurrencyConflictError`, retryable — nunca acontece com o lock, é defesa em profundidade), outbox.
6. `COMMIT` — os triggers diferidos revalidam saldo ≥ 0, cadeia do ledger e correspondência saldo ↔ ledger.

**Por que pessimista e não otimista com retry?** Em iGaming a "hot wallet" é o caso normal (um jogador em slot rápido, rodadas com BET+WIN quase simultâneos). Com otimismo, N escritores concorrentes geram O(N²) tentativas e latência imprevisível; com `FOR UPDATE` eles formam uma fila ordenada no banco, cada um espera só o tempo de uma transação curta (~ms). O `version` continua existindo como guarda e como sequência do ledger.

**Por que não advisory locks?** O lock de linha já é por wallet, é liberado automaticamente no commit/rollback/morte da conexão e não exige convenção de chaves.

**Deadlocks.** Cada transação toca **uma** wallet e adquire locks sempre na ordem *inbox → wallet → linha da transação*. O worker de referências pendentes adquire *wallet → transação*, a mesma ordem. Não há ciclo possível.

**Cenário obrigatório** (100.00, duas apostas de 80.00 simultâneas) é testado 20× seguidas em 3 instâncias: sempre exatamente 1 `PROCESSED`, 1 `REJECTED/INSUFFICIENT_FUNDS`, saldo 20.00, um único `DEBIT`.

---

## 6. Idempotência

- **`Idempotency-Key` é a fonte da verdade** (obrigatório; 400 `IDEMPOTENCY_KEY_REQUIRED`). Default recomendado `{providerId}:{externalTransactionId}`.
- Duas unicidades no schema: `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`.
- **Payload hash v1**: `sha256_hex(canonicalJson({providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money:{amount, currency}, referenceExternalTransactionId?}))`. JSON canônico = chaves ordenadas recursivamente, sem espaços, opcionais ausentes omitidos; `amount` normalizado para escala 2 antes (`"25"` ≡ `"25.00"`). Header e metadados de transporte (`messageId`, `occurredAt`) não entram.
- Mesma key + mesmo hash → **replay**: mesmo `transactionId`, mesmo status, **mesmo saldo observado na época** (`resulting_balance` gravado na transação), `idempotentReplay: true`, HTTP 200 (ou o mesmo 422/202/500 do original) e header `Idempotent-Replay: true`.
- Mesma key + hash diferente → **409 `IDEMPOTENCY_KEY_CONFLICT`** (com `existingTransactionId`), nunca replay.
- Mesmo `externalTransactionId` com outra key → **409 `EXTERNAL_TRANSACTION_ID_CONFLICT`**.
- Corrida da mesma key: o `INSERT … ON CONFLICT DO NOTHING` espera a transação concorrente terminar e então reporta o conflito — não há janela entre "verificar" e "inserir".
- **Inbox (SQS)** por `(consumer_name, message_id)`, gravado na mesma transação dos efeitos. Hash do inbox = envelope sem `occurredAt`; mesmo `messageId` com corpo diferente é bug do produtor → DLQ `INBOX_PAYLOAD_MISMATCH`.

Nada disso depende de memória: o teste de restart reinicia a aplicação e o replay devolve o resultado original.

---

## 7. Regras de negócio e interpretações adotadas

| Operação | Efeito | Ledger | Regras |
|---|---|---|---|
| `BET` | débito | 1 `DEBIT` | saldo insuficiente → `INSUFFICIENT_FUNDS` |
| `WIN` | crédito | 1 `CREDIT` | referência opcional; se presente deve ser `BET` do mesmo escopo |
| `LOSS` | nenhum | nenhum | referência opcional, idem |
| `REFUND` | crédito | 1 `CREDIT` | exige referência a `BET` `PROCESSED`, mesmo valor, uma vez |
| `ROLLBACK` | inverso da referência | 1 invertido | referencia `BET`/`WIN`/`REFUND` `PROCESSED`, mesmo valor, uma vez |

Interpretações (todas testadas):

1. **Escopo da referência**: mesmo `provider`, `player`, `wallet`, moeda e `roundId`; senão `REFERENCE_MISMATCH`.
2. **"Revertida uma única vez"**: adotei a leitura **mais estrita** — uma transação referenciada pode ser revertida **no máximo uma vez no total** (por `REFUND` *ou* `ROLLBACK`). A leitura literal ("uma vez por tipo") permitiria `REFUND` + `ROLLBACK` da mesma `BET`, creditando-a duas vezes. Garantido no schema por índice único parcial `(reference_transaction_id) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK')`. Reverter um `REFUND` (via `ROLLBACK`) é permitido.
3. **Reversão que deixaria saldo negativo** (ROLLBACK de WIN/REFUND) → `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS`; fica `REJECTED` e auditável.
4. **WIN/LOSS com referência ausente** também ficam `PENDING_REFERENCE` (a referência, quando informada, é sempre validada).
5. **Referência que está ela mesma pendente** (ex.: `ROLLBACK` de um `REFUND` que espera sua `BET`) → continua aguardando; referência `REJECTED/FAILED` → `REFERENCE_NOT_PROCESSED`.
6. **Wallet inexistente** → 404 `WALLET_NOT_FOUND` (HTTP) / ack + log (SQS). Não é persistida (não há wallet para a FK); é determinística, então o replay dá o mesmo resultado.
7. **Player que não é dono da wallet / moeda diferente** → `REJECTED` com `PLAYER_WALLET_MISMATCH` / `CURRENCY_MISMATCH` (persistida, auditável).
8. Todo `amount` de transação deve ser > 0 (inclusive `LOSS`); saldo inicial pode ser 0.
9. `OPENING` é interno: provider reservado `__internal__`, rejeitado por zod, pela factory e por CHECK no banco.

### Estados

```
PENDING ─┬─▶ PROCESSED            (terminal)
         ├─▶ REJECTED             (terminal)
         ├─▶ FAILED               (terminal)
         └─▶ PENDING_REFERENCE ─┬─▶ PENDING_REFERENCE (retry reagendado, attempts+1)
                                ├─▶ PROCESSED / REJECTED / FAILED
```

Transição a partir de terminal lança `InvalidTransactionStateError` (erro de programação) e é bloqueada também por trigger. `PENDING` é o estado de nascimento em memória; como a decisão é síncrona, a linha é gravada já no estado final da primeira tentativa.

---

## 8. Referências fora de ordem

- A transação fica `PENDING_REFERENCE` com `next_reference_attempt_at`; evento `WagerTransactionPendingReference`; HTTP **202**.
- O `PendingReferenceWorker` (todas as instâncias) busca as vencidas pelo índice parcial e processa cada uma **na sua própria transação, sob o lock da wallet**, reaproveitando as mesmas regras (`WagerSettlement`). Duas instâncias pegando a mesma linha se serializam no lock; a segunda vê que já não está pendente.
- **"Nudge"**: quando uma `BET/WIN/REFUND` é processada, as pendentes que esperam por ela têm o próximo attempt antecipado para agora (na mesma transação) — a reversão costuma se resolver em < 1 poll.
- **Orçamento**: backoff exponencial com jitter, base 2 s, teto 5 min, **10 tentativas** ≈ 7–14 min. Justificativa: cobre o orçamento de retry do consumer (5 entregas com backoff até 60 s ≈ 2–4 min) mais margem para indisponibilidade de um provedor/fila; depois disso o provedor já desistiu da rodada. Esgotado: `REJECTED` + `REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_PROCESSED` se a referência existe mas nunca concluiu) + `WagerTransactionRejected`. Tudo configurável (`PENDING_REF_*`).

---

## 9. Códigos de falha e status HTTP

### `failureCode` (persistido, estável, legível por máquina)

| Código | Status | Significado / o que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo. Não reenviar. |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | ROLLBACK que debitaria abaixo de zero. Escalar para operação. |
| `CURRENCY_MISMATCH` | REJECTED | moeda ≠ wallet. Corrigir payload (novo externalTransactionId). |
| `PLAYER_WALLET_MISMATCH` | REJECTED | player não é dono da wallet. Corrigir payload. |
| `REFERENCE_NOT_FOUND` | REJECTED | referência nunca chegou no orçamento. Investigar/desistir. |
| `REFERENCE_MISMATCH` | REJECTED | referência de outro provider/player/wallet/moeda/rodada. |
| `REFERENCE_INVALID_KIND` | REJECTED | ex.: REFUND de WIN, ROLLBACK de LOSS. |
| `REFERENCE_NOT_PROCESSED` | REJECTED | referência terminou REJECTED/FAILED. |
| `REFERENCE_ALREADY_REVERSED` | REJECTED | referência já revertida. Não reenviar. |
| `REFERENCE_AMOUNT_MISMATCH` | REJECTED | valor ≠ referência (reversão parcial fora de escopo). |
| `PROCESSING_RETRIES_EXHAUSTED` | FAILED | erro de infraestrutura persistente; mensagem na DLQ. |

A lista também é um `CHECK` no banco — um código novo exige migration (intencional: o contrato é estável).

### HTTP (o mesmo mapeamento em todos os endpoints)

| Situação | HTTP | `error.code` / corpo | Reenviar? |
|---|---|---|---|
| processada (nova / replay) | 201 / 200 | `status: PROCESSED` | — |
| aceita, processamento pendente | 202 | `status: PENDING_REFERENCE` | não; consultar GET ou eventos |
| rejeição de negócio | 422 | `status: REJECTED`, `failureCode` | não |
| payload inválido / key ausente / cursor inválido | 400 | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_CURSOR` | corrigir |
| recurso inexistente | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | não |
| conflito de idempotência / duplicidade | 409 | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` | não |
| falha transitória (DB fora, lock timeout, deadlock) | 503 + `Retry-After` | `TRANSIENT_FAILURE`, `retryable: true` | **sim, mesma key** |
| transação FAILED (replay) | 500 | `status: FAILED`, `failureCode` | não |
| erro inesperado (nada foi aplicado) | 500 | `INTERNAL_ERROR` | sim, mesma key (é replay-safe) |

Todo erro tem o formato `{ "error": { "code", "message", "retryable", "details?" } }`.

---

## 10. Consumidor SQS

- Long polling, até 10 mensagens; mensagens do mesmo `MessageGroupId` (produtor deve usar o `walletId`) processadas **em ordem**, grupos em paralelo. Se uma mensagem do grupo falha, as seguintes do mesmo lote voltam à fila (visibilidade 0) para não furar a ordem.
- **ack (`DeleteMessage`) só depois do commit.** Se o ack falhar, a reentrega é deduplicada pelo inbox.

| Classe | Exemplos | Ação |
|---|---|---|
| negócio | processada, rejeitada, conflito de key, wallet inexistente | **ack** |
| transitório | DB indisponível, lock timeout, deadlock, `ConcurrencyConflict`, desconhecido | `ChangeMessageVisibility` com backoff exponencial (1 s → 60 s) |
| permanente | JSON inválido, schema inválido, `INBOX_PAYLOAD_MISMATCH`, violação de invariante | **DLQ imediata** (com atributos `failureReason`, `failureDetail`, `receiveCount`) |
| orçamento esgotado | `ApproximateReceiveCount ≥ CONSUMER_MAX_ATTEMPTS` (5) | grava a transação como **`FAILED/PROCESSING_RETRIES_EXHAUSTED`** (best effort, mesma transação do inbox + evento `WagerTransactionFailed`) e manda para a DLQ |

- **RedrivePolicy** da fila com `maxReceiveCount = max + 2`: rede de segurança para mensagens venenosas que derrubam o processo antes de o código conseguir roteá-las.
- **SIGTERM**: readiness passa a 503 (balanceador drena), o long poll é abortado, mensagens em andamento terminam (até `SHUTDOWN_GRACE_MS`), as recebidas e não iniciadas voltam com visibilidade 0; leases do outbox são liberadas; por último fecha o pool do banco.
- Ordem FIFO e deduplicação do SQS são **otimização**; a correção vem do banco (inbox + idempotência + lock), por isso os testes enviam duplicatas com `MessageDeduplicationId` diferentes de propósito.

---

## 11. Transactional Outbox

- Os eventos são gravados em `outbox_messages` **na mesma transação** da alteração financeira. Nada é publicado antes do commit.
- **Claim com lease**: `UPDATE … SET lease_owner, lease_expires_at WHERE id IN (SELECT … WHERE published_at IS NULL AND next_attempt_at <= now() AND lease expirada/nula ORDER BY occurred_at, id LIMIT n FOR UPDATE SKIP LOCKED) RETURNING *`. Publishers concorrentes pegam linhas disjuntas; nenhuma transação fica aberta durante a chamada de rede; se o publisher morre, a lease expira e outra instância assume.
- `markPublished` só vale para o dono atual da lease. Falha de envio → `scheduleRetry` (backoff 0,5 s → 60 s), `last_error` gravado. **Não existe "desistir"**: um evento confirmado precisa ser publicado; atraso aparece como `wagering_outbox_lag_seconds`.
- **At-least-once**: se o processo morre entre o SQS aceitar e o `markPublished`, o evento é publicado de novo. É seguro porque **o id do outbox é o `eventId`** e também o `MessageDeduplicationId` do SQS FIFO; consumidores deduplicam por `eventId`.
- Ordem: mensagens do mesmo aggregate (wallet) vão para a mesma "lane" do publisher e saem em ordem; entre publishers diferentes a ordem é best-effort — o `WalletBalanceChanged` carrega `walletVersion` para o consumidor ordenar/descartar.
- Cenário exigido (commit → processo morre antes de publicar → outra instância publica → duplicata segura) é testado tanto in-process (falha injetada após o envio) quanto com reinício da aplicação.

Eventos: `WagerTransactionProcessed` (inclusive LOSS e OPENING), `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference`, e `WagerTransactionFailed`. Envelope = classe abstrata `IntegrationEvent<T>` com uma subclasse por evento; `eventType`/`version` vivem no tipo; `data` usa `MoneyProps` (strings). `aggregateId` = `walletId` em todos (a wallet é a fronteira de consistência e de ordenação).

---

## 12. Schema: o que o banco garante sozinho

O banco é a autoridade final — inclusive contra SQL manual ou um bug futuro. Os testes `schema-constraints.test.ts` executam SQL direto (sem a aplicação) e verificam cada recusa.

| Garantia | Mecanismo |
|---|---|
| uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| saldo nunca negativo | `CHECK (balance >= 0)` na wallet e `balance_before/after >= 0` no ledger |
| unicidade de idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| reversão única | índice único parcial em `reference_transaction_id` |
| no máximo 1 lançamento por transação/wallet | `UNIQUE (transaction_id, wallet_id)` |
| um lançamento por mudança de saldo | `UNIQUE (wallet_id, wallet_version)` |
| aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)` |
| ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| ledger sem buracos | trigger `BEFORE INSERT`: versão n+1 começa no `balance_after` da n |
| saldo ↔ ledger (nos dois sentidos) | **constraint triggers `DEFERRABLE INITIALLY DEFERRED`**: no COMMIT, toda mudança de saldo tem lançamento na nova versão com o mesmo saldo, e todo lançamento corresponde ao estado da wallet e a uma transação `PROCESSED` que afeta saldo, com mesmo valor e moeda |
| `version` só muda com o saldo, sempre +1 | trigger na wallet; colunas de identidade imutáveis |
| transação terminal congelada; campos de negócio imutáveis | trigger na `wager_transactions` |
| sem exclusão física | triggers em `wallets` e `wager_transactions` |
| regras de forma | `CHECK`s: `amount > 0`, referência obrigatória para REFUND/ROLLBACK, `OPENING` só interno, `failure_code` ⇔ REJECTED/FAILED, `processed_at` ⇔ terminal, agenda ⇔ PENDING_REFERENCE |
| payload do outbox imutável | trigger |

Índices: parciais para o worker (`status='PENDING_REFERENCE'`), para o "nudge" e para o outbox pendente (`(occurred_at, id) WHERE published_at IS NULL`, que casa com o `ORDER BY` do claim); `(wallet_id, wallet_version)` serve a paginação e a reconstrução do saldo.

Migrations: `Migration…01_core_schema` (tabelas/constraints) e `Migration…02_integrity_triggers`, ambas com `down`; testadas `up → down → down → up` num banco novo.

---

## 13. Observabilidade

- **Logs JSON** (uma linha por evento) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instanceId`, propagados por `AsyncLocalStorage`. Chaves sensíveis (`amount`, `balance*`, `money`, `payload`, `body`, `data`, segredos) são **redigidas** pelo logger — logs carregam identificadores e desfechos (`status`, `failureCode`), não valores financeiros.
- **Métricas** (`GET /metrics`, Prometheus): `wagering_transactions_total{kind,status,source}`, `wagering_duplicates_detected_total{mechanism}`, `wagering_idempotency_conflicts_total`, `wagering_retries_total{component,reason}`, `wagering_dlq_messages_total{reason}`, `wagering_lock_conflicts_total{reason}`, `wagering_wallet_lock_wait_seconds`, `wagering_processing_duration_seconds{source}`, `wagering_outbox_lag_seconds`, `wagering_outbox_pending_messages`, `wagering_outbox_publish_delay_seconds`, `wagering_reconciliation_divergences_total`, `wagering_http_request_duration_seconds`, além das métricas de processo.
- **Health**: `/health/live` (processo vivo; não checa dependências para não causar restart em cascata) e `/health/ready` (PostgreSQL + SQS alcançáveis e não em shutdown). Abertos, sem autenticação.
- `X-Correlation-Id` aceito/gerado e devolvido em toda resposta.

---

## 14. Autenticação — decisão

**Não implementada**, por decisão de timebox (não pontua; não deveria competir com correção). O ponto de extensão está no código: `ProviderAuthGuard` aplicado a todos os controllers de negócio, delegando para a porta `ProviderIdentityPort`; o adaptador padrão chama-se honestamente `TrustAllProviderIdentity`. O controller já compara `identity.providerId` com o `providerId` do payload (403 se diferirem) quando a identidade existir.

Desenho que eu adotaria:

1. **Keycloak** (ou Zitadel) no compose, um *client* por provedor com **OAuth2 client credentials**; o token traz um claim `provider_id`.
2. Adaptador `JwtProviderIdentity` validando assinatura via **JWKS** do IdP (cache com rotação), `iss`, `aud`, `exp`; sem tabela de usuários nem senhas próprias.
3. Autorização mínima: provedor só submete/consulta transações com o seu `providerId`; endpoints de wallet/reconciliação exigem um papel de backoffice.
4. Health e métricas continuam abertos (métricas idealmente só na rede interna). Mensagens da fila são canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio (escopo da referência etc.).

---

## 15. Testes

Tudo roda contra **PostgreSQL real e SQS real (emulado)** — nada de mocks de banco ou fila. 150 testes em 13 arquivos.

| Exigência | Onde |
|---|---|
| Money (escala, arredondamento, inválidos), invariantes da Wallet, regras BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, key com payload divergente | `test/unit/*` |
| migrations e constraints | `integration/schema-constraints` |
| atomicidade wallet/ledger/inbox/outbox | `integration/atomicity` (falha injetada imediatamente antes do COMMIT; snapshot tirado com a transação aberta) |
| inbox e redelivery; retry e DLQ; FAILED; shutdown | `integration/sqs-consumer` |
| publishers concorrentes sobre o mesmo outbox; morte entre publicar e marcar | `integration/outbox` |
| recuperação após reinicialização | `integration/restart-recovery` |
| 50× a mesma aposta em paralelo; cenário 100/80/80; contenção pesada; wallets distintas em paralelo; ROLLBACK/REFUND antes da referência; reversões duplas paralelas | `concurrency/races` (3 apps no mesmo processo, pools distintos) |
| **≥ 3 processos** simultâneos (HTTP + SQS + duplicatas); worker morto (**SIGKILL**) depois do commit e antes do ack; instância morta sob carga e reiniciada | `concurrency/multi-process` (processos `bun src/main.ts` reais) |

Invariante final verificada em todos: `wallet.balance == saldo reconstruído pelo ledger` (e `version − 1 == nº de lançamentos após a abertura`).

Seam de falhas: `FaultInjector` (porta) com pontos `process.beforeCommit`, `consumer.afterCommitBeforeAck`, `outbox.afterPublishBeforeMark`; em produção `FAULT_INJECTION` fica vazio e o injetor é um *lookup* sem efeito.

---

## 16. Teste de carga (`bun run test:load`)

**Ambiente**: notebook Linux, 8× AMD Ryzen 5 7520U, 7 GB RAM; PostgreSQL 18 local; SQS emulado por **moto** (Python); 3 instâncias + gerador de carga + banco + emulador **na mesma máquina** (CPU saturada — os números medem o conjunto, não só o serviço).

**Metodologia**: closed-loop, 64 usuários virtuais por 30 s, round-robin em 3 instâncias, 50 wallets; mix 70% BET / 18% WIN / 5% LOSS / 7% ROLLBACK; 10% de reenvios idênticos. Ao fim: drenagem do outbox, métricas somadas das instâncias e reconciliação de **todas** as wallets (falha se alguma divergir).

| Cenário | req | RPS | p50 | p95 | p99 | erros | duplicatas detectadas | lock conflicts | espera média lock | wallets divergentes |
|---|---|---|---|---|---|---|---|---|---|---|
| 20% em 1 hot wallet | 9 059 | 299 | 29 ms | 1 520 ms | 2 791 ms | 0 | 904 / 904 | 0 | 203 ms | **0 / 50** |
| sem hot wallet | 10 307 | 342 | 157 ms | 424 ms | 606 ms | 0 | 1 014 / 1 014 | 0 | 62 ms | **0 / 50** |

**Análise honesta**

- **Correção sob carga**: zero erros, todas as duplicatas viraram replay, nenhuma divergência saldo/ledger, nenhum timeout de lock.
- **Hot wallet**: a serialização por wallet é o custo da garantia. Com 20% do tráfego numa wallet, ~13 usuários fazem fila nela: o p50 global cai (os outros usuários disputam menos), mas a cauda explode (p99 ~2,8 s) — é o tempo de fila da hot wallet. O teto de uma wallet é ~1/(duração da transação). Mitigações possíveis (não implementadas): transações mais curtas (menos round-trips — p.ex. uma função SQL), agrupar operações da mesma wallet numa transação, ou sub-wallets.
- **Throughput** (~300–340 RPS) está limitado pela CPU da máquina compartilhada, não por contenção (0 lock conflicts).
- **Outbox lag não foi medível de forma útil aqui**: o moto degrada linearmente com a profundidade da fila FIFO — `SendMessageBatch` levou **17 ms com a fila vazia e 1 170 ms com ~2,7 k mensagens**, e o `ReceiveMessage` idem (o consumidor de eventos do teste recebeu só ~200 mensagens em 2 min). A query de claim, em contraste, levou 21 ms com 14 k linhas pendentes. Lag máximo observado: ~30 s, e o outbox **não** drenou em 120 s após a carga nesse ambiente. A medição correta exige SQS real ou LocalStack; o script já mede e reporta isso (`maxOutboxLagS`, `outboxDrainAfterLoadS`, `distinctEventIdsReceived`).

---

## 17. Limitações e próximos passos

- A suíte completa passa contra o PostgreSQL e o LocalStack **do compose** (150/150). O teste de carga da §16 foi medido antes, com moto; repeti-lo contra o LocalStack daria números de outbox lag mais representativos. Se a imagem do LocalStack passar a exigir token, qualquer endpoint SQS (MiniStack, ElasticMQ) funciona via `AWS_ENDPOINT_URL`.
- Escala monetária fixa (2) para todas as moedas.
- Ordem de eventos entre publishers diferentes é best-effort (usar `walletVersion`).
- Retenção: inbox e outbox publicados crescem indefinidamente; falta job de limpeza (o trigger permite `DELETE` de outbox; inbox pode ser particionado por data).
- Reconciliação é sob demanda; um job periódico com alerta na métrica de divergência seria o próximo passo.
- Ledger em partida simples (por wallet); partidas dobradas (contas de casa/provedor) seriam um diferencial.
- Throughput por hot wallet limitado pela serialização (ver §16).
- O outbox publica do mais antigo para o mais novo: um backlog grande e antigo atrasa eventos novos (justo, mas sem prioridade). Por isso o teste de carga usa um banco próprio (`wagering_load`): rodá-lo no banco de testes deixou ~23 k eventos pendentes e fez os testes que esperam publicação estourarem o timeout.
