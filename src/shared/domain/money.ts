// ㉿ Money: dinheiro exato, sem ponto flutuante.
import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Formato DTO usado em todos os contratos (HTTP, SQS, eventos, persistência). */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export const MONEY_SCALE = 2;
const SCALE_FACTOR = 10n ** BigInt(MONEY_SCALE);
/** 15 dígitos inteiros garantem que qualquer valor (e somas de muitos valores) cabe em NUMERIC(20,2). */
const MAX_INTEGER_DIGITS = 15;

const UNSIGNED_AMOUNT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const SIGNED_AMOUNT = /^-?(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável com escala fixa de 2.
 *
 * Por dentro o valor fica como um inteiro de centavos (unidades mínimas) num `bigint`,
 * então toda operação é exata: não existe ponto flutuante binário em nenhum ponto do
 * caminho entre a requisição e o banco (`NUMERIC(20,2)`, lido de volta como string).
 *
 * Valores nunca são arredondados. Entrada com mais de 2 casas é rejeitada, porque
 * arredondar calado o valor de um provedor seria um erro financeiro.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Faz o parse de um valor de contrato. Rejeita string vazia, NaN/Infinity, notação científica,
   * zeros à esquerda, mais de 2 casas e negativos. Aceita de 0 a 2 casas
   * ("25", "25.5", "25.50") e normaliza para escala 2.
   */
  static from(props: MoneyProps): Money {
    return Money.parse(props, UNSIGNED_AMOUNT);
  }

  /** Igual ao {@link from}, mas aceita sinal de menos. Só para valores internos (ex.: diferença da reconciliação). */
  static fromSigned(props: MoneyProps): Money {
    return Money.parse(props, SIGNED_AMOUNT);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  /** String decimal com exatamente 2 casas, ex.: "-12.05". */
  get amount(): string {
    return this.formatAmount();
  }

  private formatAmount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / SCALE_FACTOR;
    const fraction = (abs % SCALE_FACTOR).toString().padStart(MONEY_SCALE, '0');
    return `${negative ? '-' : ''}${integer}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parse(props: MoneyProps, pattern: RegExp): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object with amount and currency');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Amount must be a decimal string');
    }
    const match = pattern.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`Invalid amount "${amount}": expected a plain decimal with at most ${MONEY_SCALE} places`);
    }
    const integerPart = match[1] ?? '';
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(`Amount "${amount}" exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    const fractionPart = (match[2] ?? '').padEnd(MONEY_SCALE, '0');
    const magnitude = BigInt(integerPart) * SCALE_FACTOR + BigInt(fractionPart);
    const minorUnits = amount.startsWith('-') ? -magnitude : magnitude;
    return new Money(minorUnits === 0n ? 0n : minorUnits, Money.assertCurrency(currency));
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected an ISO-4217 code`);
    }
    return currency;
  }
}
