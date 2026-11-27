import { Migration } from '@mikro-orm/migrations';

/**
 * Invariantes que um CHECK não consegue expressar porque envolvem várias linhas ou tabelas.
 * Elas fazem do banco a autoridade final mesmo para caminhos que não passam pela
 * aplicação (SQL manual, um serviço futuro, um bug):
 *
 *  - o ledger é append-only (sem UPDATE / DELETE / TRUNCATE);
 *  - os lançamentos formam uma cadeia sem buracos por wallet (a versão n+1 começa onde a n terminou);
 *  - toda mudança de saldo tem lançamento na nova versão com o mesmo saldo, e
 *    todo lançamento bate com a wallet e com uma transação PROCESSED que mexe em saldo
 *    (DEFERRABLE INITIALLY DEFERRED: checado no COMMIT, quando todas as linhas da unidade de trabalho já existem);
 *  - colunas de identidade da wallet são imutáveis; a versão anda exatamente +1 se e só se o saldo mudar;
 *  - transações terminais ficam congeladas; colunas de negócio são imutáveis;
 *  - nada de delete físico em wallets / transações; payload do outbox é imutável.
 *
 * Todas lançam SQLSTATE 'WG001' para a aplicação conseguir mapear como violação de invariante.
 */
export class Migration20261126000002_integrity_triggers extends Migration {
  override async up(): Promise<void> {
    // ---- guardas genéricas ------------------------------------------------
    this.addSql(`
      CREATE FUNCTION wg_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '% on % is forbidden', TG_OP, TG_TABLE_NAME USING ERRCODE = 'WG001';
      END $$;
    `);

    // ---- ledger -----------------------------------------------------------
    this.addSql(`
      CREATE TRIGGER ledger_append_only
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wg_forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wg_forbid_mutation();
    `);
    this.addSql(`
      CREATE FUNCTION wg_ledger_chain_check() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        prev_version integer;
        prev_balance numeric(20,2);
        wallet_currency char(3);
      BEGIN
        SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
        IF wallet_currency IS DISTINCT FROM NEW.currency THEN
          RAISE EXCEPTION 'ledger entry currency % differs from wallet currency %', NEW.currency, wallet_currency
            USING ERRCODE = 'WG001';
        END IF;

        SELECT wallet_version, balance_after INTO prev_version, prev_balance
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF NOT FOUND THEN
          -- primeiro movimento: crédito de abertura (versão 1) ou primeiro crédito de uma wallet aberta com zero (versão 2)
          IF NEW.balance_before <> 0 OR NEW.wallet_version > 2 THEN
            RAISE EXCEPTION 'first ledger entry of wallet % must start at zero balance', NEW.wallet_id
              USING ERRCODE = 'WG001';
          END IF;
        ELSIF NEW.wallet_version <> prev_version + 1 OR NEW.balance_before <> prev_balance THEN
          RAISE EXCEPTION 'ledger chain broken for wallet % (prev v% = %, new v% from %)',
            NEW.wallet_id, prev_version, prev_balance, NEW.wallet_version, NEW.balance_before
            USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_chain_check
        BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wg_ledger_chain_check();
    `);
    this.addSql(`
      CREATE FUNCTION wg_ledger_matches_state() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        w RECORD;
        t RECORD;
      BEGIN
        SELECT version, balance INTO w FROM wallets WHERE id = NEW.wallet_id;
        IF w.version < NEW.wallet_version
           OR (w.version = NEW.wallet_version AND w.balance <> NEW.balance_after) THEN
          RAISE EXCEPTION 'ledger entry % does not match wallet % state', NEW.id, NEW.wallet_id
            USING ERRCODE = 'WG001';
        END IF;

        SELECT status, kind, wallet_id, amount, currency INTO t FROM wager_transactions WHERE id = NEW.transaction_id;
        IF t.status <> 'PROCESSED' OR t.kind = 'LOSS' OR t.wallet_id <> NEW.wallet_id
           OR t.amount <> NEW.amount OR t.currency <> NEW.currency THEN
          RAISE EXCEPTION 'ledger entry % does not match a processed balance-affecting transaction', NEW.id
            USING ERRCODE = 'WG001';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_matches_state
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wg_ledger_matches_state();
    `);

    // ---- wallets ----------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION wg_wallet_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet % identity columns are immutable', OLD.id USING ERRCODE = 'WG001';
        END IF;
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet % balance changed without version increment', OLD.id USING ERRCODE = 'WG001';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version changed without balance change', OLD.id USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER wallet_guard_update
        BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wg_wallet_guard_update();
    `);
    this.addSql(`
      CREATE TRIGGER wallet_no_delete
        BEFORE DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wg_forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER wallet_no_truncate
        BEFORE TRUNCATE ON wallets
        FOR EACH STATEMENT EXECUTE FUNCTION wg_forbid_mutation();
    `);
    this.addSql(`
      CREATE FUNCTION wg_wallet_has_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP = 'INSERT' AND NEW.balance > 0) OR (TG_OP = 'UPDATE' AND NEW.balance <> OLD.balance) THEN
          PERFORM 1 FROM wallet_ledger_entries
            WHERE wallet_id = NEW.id AND wallet_version = NEW.version AND balance_after = NEW.balance;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'balance change of wallet % (v%) has no ledger entry', NEW.id, NEW.version
              USING ERRCODE = 'WG001';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_has_ledger_entry
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wg_wallet_has_ledger_entry();
    `);

    // ---- transações -------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION wg_wager_tx_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'WG001';
        END IF;
        IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
          RAISE EXCEPTION 'wager transaction % cannot return to PENDING', OLD.id USING ERRCODE = 'WG001';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
            NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
            OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager transaction % business columns are immutable', OLD.id USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_update
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wg_wager_tx_guard_update();
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_no_delete
        BEFORE DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wg_forbid_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_no_truncate
        BEFORE TRUNCATE ON wager_transactions
        FOR EACH STATEMENT EXECUTE FUNCTION wg_forbid_mutation();
    `);

    // ---- outbox -----------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION wg_outbox_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
           IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
          RAISE EXCEPTION 'outbox message % event columns are immutable', OLD.id USING ERRCODE = 'WG001';
        END IF;
        IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
          RAISE EXCEPTION 'outbox message % is already published', OLD.id USING ERRCODE = 'WG001';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER outbox_guard_update
        BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION wg_outbox_guard_update();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TRIGGER IF EXISTS outbox_guard_update ON outbox_messages;');
    this.addSql('DROP TRIGGER IF EXISTS wager_tx_no_truncate ON wager_transactions;');
    this.addSql('DROP TRIGGER IF EXISTS wager_tx_no_delete ON wager_transactions;');
    this.addSql('DROP TRIGGER IF EXISTS wager_tx_guard_update ON wager_transactions;');
    this.addSql('DROP TRIGGER IF EXISTS wallet_has_ledger_entry ON wallets;');
    this.addSql('DROP TRIGGER IF EXISTS wallet_no_truncate ON wallets;');
    this.addSql('DROP TRIGGER IF EXISTS wallet_no_delete ON wallets;');
    this.addSql('DROP TRIGGER IF EXISTS wallet_guard_update ON wallets;');
    this.addSql('DROP TRIGGER IF EXISTS ledger_matches_state ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER IF EXISTS ledger_chain_check ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER IF EXISTS ledger_no_truncate ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER IF EXISTS ledger_append_only ON wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS wg_outbox_guard_update();');
    this.addSql('DROP FUNCTION IF EXISTS wg_wager_tx_guard_update();');
    this.addSql('DROP FUNCTION IF EXISTS wg_wallet_has_ledger_entry();');
    this.addSql('DROP FUNCTION IF EXISTS wg_wallet_guard_update();');
    this.addSql('DROP FUNCTION IF EXISTS wg_ledger_matches_state();');
    this.addSql('DROP FUNCTION IF EXISTS wg_ledger_chain_check();');
    this.addSql('DROP FUNCTION IF EXISTS wg_forbid_mutation();');
  }
}
