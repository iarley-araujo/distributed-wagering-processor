import { Migration } from '@mikro-orm/migrations';

/**
 * Tabelas, tipos de coluna e constraints declarativas (CHECK / UNIQUE / FK / índices parciais).
 * Dinheiro é NUMERIC(20,2) + CHAR(3): exato, escala fixa, lido pelo driver como string.
 */
export class Migration20261126000001_core_schema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL CONSTRAINT wallets_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2)  NOT NULL CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        version     integer        NOT NULL CONSTRAINT wallets_version_ck CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid          PRIMARY KEY,
        provider_id                        varchar(64)   NOT NULL CONSTRAINT wager_tx_provider_ck CHECK (provider_id <> ''),
        external_transaction_id            varchar(128)  NOT NULL CONSTRAINT wager_tx_external_id_ck CHECK (external_transaction_id <> ''),
        idempotency_key                    varchar(255)  NOT NULL CONSTRAINT wager_tx_idempotency_key_ck CHECK (idempotency_key <> ''),
        payload_hash                       char(64)      NOT NULL CONSTRAINT wager_tx_payload_hash_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
        player_id                          uuid          NOT NULL,
        round_id                           varchar(128)  NOT NULL CONSTRAINT wager_tx_round_ck CHECK (round_id <> ''),
        game_id                            varchar(128)  NOT NULL CONSTRAINT wager_tx_game_ck CHECK (game_id <> ''),
        kind                               varchar(16)   NOT NULL CONSTRAINT wager_tx_kind_ck
                                             CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(20,2) NOT NULL CONSTRAINT wager_tx_amount_positive_ck CHECK (amount > 0),
        currency                           char(3)       NOT NULL CONSTRAINT wager_tx_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  varchar(128),
        reference_transaction_id           uuid          REFERENCES wager_transactions (id),
        status                             varchar(20)   NOT NULL CONSTRAINT wager_tx_status_ck
                                             CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       varchar(64)   CONSTRAINT wager_tx_failure_code_value_ck CHECK (failure_code IN (
                                             'INSUFFICIENT_FUNDS','REVERSAL_INSUFFICIENT_FUNDS','CURRENCY_MISMATCH',
                                             'PLAYER_WALLET_MISMATCH','REFERENCE_NOT_FOUND','REFERENCE_MISMATCH',
                                             'REFERENCE_INVALID_KIND','REFERENCE_NOT_PROCESSED','REFERENCE_ALREADY_REVERSED',
                                             'REFERENCE_AMOUNT_MISMATCH','PROCESSING_RETRIES_EXHAUSTED')),
        resulting_balance                  numeric(20,2) CONSTRAINT wager_tx_resulting_balance_ck CHECK (resulting_balance >= 0),
        reference_attempts                 integer       NOT NULL DEFAULT 0 CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0),
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz   NOT NULL,
        processed_at                       timestamptz,
        updated_at                         timestamptz   NOT NULL,

        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_reference_required_ck
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_opening_internal_ck
          CHECK ((kind = 'OPENING') = (provider_id = '__internal__') AND (kind <> 'OPENING' OR reference_external_transaction_id IS NULL)),
        CONSTRAINT wager_tx_no_self_reference_ck
          CHECK (reference_external_transaction_id IS DISTINCT FROM external_transaction_id),
        CONSTRAINT wager_tx_failure_code_ck
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_processed_at_ck
          CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_pending_reference_schedule_ck
          CHECK ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)),
        CONSTRAINT wager_tx_reference_link_ck
          CHECK (reference_transaction_id IS NULL OR (status = 'PROCESSED' AND reference_external_transaction_id IS NOT NULL))
      );
    `);

    // Uma transação referenciada pode ser revertida (REFUND ou ROLLBACK) no máximo uma vez.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
    `);
    // Varredura do worker por PENDING_REFERENCE vencidas, e busca do "nudge" quando a referência chega.
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX wager_tx_pending_dependents_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_created_idx ON wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL REFERENCES wallets (id),
        transaction_id  uuid          NOT NULL REFERENCES wager_transactions (id),
        direction       varchar(6)    NOT NULL CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2) NOT NULL CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        currency        char(3)       NOT NULL CONSTRAINT ledger_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before  numeric(20,2) NOT NULL CONSTRAINT ledger_balance_before_ck CHECK (balance_before >= 0),
        balance_after   numeric(20,2) NOT NULL CONSTRAINT ledger_balance_after_ck CHECK (balance_after >= 0),
        wallet_version  integer       NOT NULL CONSTRAINT ledger_wallet_version_ck CHECK (wallet_version >= 1),
        created_at      timestamptz   NOT NULL,

        CONSTRAINT ledger_arithmetic_ck CHECK (
          balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END
        ),
        -- no máximo um lançamento por (transação, wallet)
        CONSTRAINT ledger_one_entry_per_transaction_uq UNIQUE (transaction_id, wallet_id),
        -- um lançamento por mudança de saldo: a versão da wallet é a sequência do ledger (serve também à paginação)
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version)
      );
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(128) NOT NULL,
        message_id     varchar(256) NOT NULL,
        payload_hash   char(64)     NOT NULL,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id                uuid          PRIMARY KEY,
        aggregate_id      uuid          NOT NULL,
        event_type        varchar(128)  NOT NULL,
        payload           jsonb         NOT NULL,
        occurred_at       timestamptz   NOT NULL,
        attempts          integer       NOT NULL DEFAULT 0 CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
        next_attempt_at   timestamptz   NOT NULL,
        published_at      timestamptz,
        lease_owner       varchar(128),
        lease_expires_at  timestamptz,
        last_error        varchar(1024),
        CONSTRAINT outbox_lease_ck CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
      );
    `);
    // Casa com a query de claim (ORDER BY occurred_at, id nas linhas não publicadas): o scan
    // para depois de LIMIT linhas em vez de ordenar o backlog inteiro.
    this.addSql(`
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (occurred_at, id)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
