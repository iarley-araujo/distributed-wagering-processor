<div align="center">

# ㉿ Distributed Wagering Processor

**Serviço financeiro distribuído para transações de apostas — correto sob duplicatas, entregas fora de ordem, concorrência e várias instâncias.**

![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)
![MikroORM](https://img.shields.io/badge/MikroORM-6-1F2937)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![AWS SQS](https://img.shields.io/badge/AWS-SQS-FF9900?logo=amazonsqs&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Testes](https://img.shields.io/badge/testes-150%20passando-2EA44F)

</div>

Processa transações (`BET → WIN | LOSS | REFUND | ROLLBACK`) recebidas de múltiplos provedores por **HTTP** e **SQS**, usando o mesmo caso de uso nos dois caminhos.

### Garantias

| Garantia | Como |
|---|---|
| 💰 **Dinheiro exato** | `Money` em `bigint` de centavos, `NUMERIC(20,2)` no banco — nenhum `number`/float |
| 🔒 **Sem saldo negativo, sem lost update** | lock por wallet (`SELECT … FOR UPDATE`) + update condicional por versão + `CHECK` no schema |
| 🔁 **Idempotência persistente** | `Idempotency-Key` + hash do payload + `UNIQUE` no banco; replay devolve o resultado original |
| 📒 **Ledger auditável** | append-only, cadeia sem buracos e saldo ↔ ledger verificados por triggers no `COMMIT` |
| 📨 **Mensageria segura** | inbox na mesma transação, ack só após commit, retry com backoff, DLQ |
| 📤 **Transactional outbox** | eventos gravados junto com o saldo; publishers concorrentes com lease + `SKIP LOCKED` |
| ⏳ **Fora de ordem** | `ROLLBACK`/`REFUND` antes da referência ficam pendentes e um worker resolve com backoff |
| 🧪 **Testado de verdade** | PostgreSQL e SQS reais, corridas em paralelo, 3 processos, `SIGKILL` entre commit e ack |

As decisões, garantias e trade-offs estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Subir tudo com Docker Compose

```bash
docker compose up --build
```

Sobe PostgreSQL, LocalStack (SQS), roda as migrations, cria as filas e inicia **3 instâncias** da aplicação:

| Instância | URL |
|---|---|
| app-1 | http://localhost:3001 |
| app-2 | http://localhost:3002 |
| app-3 | http://localhost:3003 |

Filas criadas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive) e `wagering-events.fifo` (eventos do outbox).

Rodar a suíte de testes dentro do compose (usa o banco `wagering_test`):

```bash
docker compose --profile test run --rm tests
```

Rodar o teste de carga contra as 3 instâncias do compose:

```bash
docker compose --profile load run --rm load
```

## Rodar localmente (sem Docker para a aplicação)

Pré-requisitos: Bun 1.4+, um PostgreSQL e um endpoint SQS (LocalStack/MiniStack/ElasticMQ). Para subir só a infraestrutura:

```bash
docker compose up -d postgres localstack
```

```bash
bun install
```

```bash
cp .env.example .env
```

```bash
bun run migrate:up
```

```bash
bun run queues:create
```

```bash
bun run start
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` | inicia uma instância (papéis em `APP_ROLES`) |
| `bun run dev` | idem, com watch |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run migrate:up` / `migrate:down` / `migrate:status` | migrations versionadas e reversíveis (`down --all` reverte tudo) |
| `bun run queues:create` | cria as filas FIFO (idempotente) |
| `bun test` | toda a suíte (unit + integração + concorrência) |
| `bun run test:unit` | só testes de unidade (sem infraestrutura) |
| `bun run test:integration` | PostgreSQL + SQS reais |
| `bun run test:concurrency` | corridas reais, 3 processos, SIGKILL |
| `bun run test:load` | teste de carga (sobe 3 instâncias se `LOAD_BASE_URLS` não for informado) |

Os testes de integração/concorrência usam `TEST_DATABASE_URL` (padrão `postgresql://wagering:wagering@localhost:5432/wagering_test`) e `AWS_ENDPOINT_URL` (padrão `http://localhost:4566`). Cada arquivo cria suas próprias filas; as migrations são aplicadas automaticamente.

Variáveis do teste de carga: `LOAD_DURATION_S` (30), `LOAD_CONCURRENCY` (64), `LOAD_WALLETS` (50), `LOAD_HOT_SHARE` (0.2), `LOAD_DUPLICATE_RATE` (0.1), `LOAD_INSTANCES` (3), `LOAD_BASE_URLS`, `LOAD_DATABASE_URL` (padrão: banco `wagering_load`, criado e migrado automaticamente — separado do banco de testes para que o backlog de eventos da carga não atrase a suíte). O relatório é impresso e salvo em `test/load/results/`.

## Tour pela API

```bash
curl -s -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```bash
curl -s -X POST localhost:3002/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Endpoint | Descrição |
|---|---|
| `POST /wallets` | cria wallet; saldo inicial > 0 gera transação `OPENING` + `CREDIT` na mesma transação SQL; duplicada → 409 |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado (mais recente primeiro), cursor opaco e estável |
| `POST /wallets/:walletId/reconciliation` | saldo materializado × ledger; divergência é logada, contada e sinalizada, nunca corrigida |
| `POST /wagering/transactions` | submete operação (`Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | por id do provedor |
| `GET /health/live`, `GET /health/ready` | liveness / readiness (PostgreSQL + SQS), sem autenticação |
| `GET /metrics` | métricas Prometheus |

Status HTTP de `POST /wagering/transactions`: **201** processada · **200** replay · **202** aguardando referência · **422** rejeição de negócio (`failureCode`) · **400** payload inválido · **404** wallet inexistente · **409** conflito de idempotência · **503** falha transitória (reenviar com a mesma key). Detalhes em [ARCHITECTURE.md §9](ARCHITECTURE.md#9-códigos-de-falha-e-status-http).

Mensagem SQS (`wager-transactions.fifo`, use `MessageGroupId = walletId`):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "idempotencyKey": "provider-a:transaction-123", "providerId": "provider-a", "...": "mesmos campos do HTTP" }
}
```

## Estrutura

```
src/
  main.ts, bootstrap.ts, app.module.ts
  config/                     configuração tipada via env
  shared/domain/              Money, erros, canonical JSON, UUIDv7, backoff
  wagering/domain/            Wallet, WagerTransaction, WalletLedgerEntry, WagerSettlement, eventos, inbox/outbox
  wagering/application/       use cases + portas
  wagering/infrastructure/    MikroORM (schemas, repositórios, migrations), SQS, workers
  wagering/interfaces/        contratos zod (HTTP e SQS) e controllers
  observability/              logs JSON, métricas, health
  auth/                       ponto de extensão de autenticação
scripts/                      migrate.ts, create-queues.ts
test/unit | integration | concurrency | load | support
infra/postgres/init/          cria o banco de testes
```

## Como isto foi validado

A suíte completa (**150 testes, 0 falhas**) foi executada contra os serviços do compose — **PostgreSQL 17 e LocalStack 3.8 (SQS) em Docker** — com processos reais da aplicação (`docker compose up -d postgres localstack` + `bun test`, ~70 s). Ela também passou contra PostgreSQL 18 local + emulador SQS `moto`, onde foi rodado o teste de carga. Veja [ARCHITECTURE.md §16–17](ARCHITECTURE.md#16-teste-de-carga-bun-run-testload) para resultados de carga e limitações.
