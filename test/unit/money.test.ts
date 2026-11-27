import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/shared/domain/errors';
import { Money } from '../../src/shared/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('parses and serializes with a fixed scale of 2', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('25.05').amount).toBe('25.05');
    expect(brl('0').amount).toBe('0.00');
    expect(brl('0.01').toString()).toBe('0.01 BRL');
    expect(brl('999999999999999.99').amount).toBe('999999999999999.99');
  });

  test('arithmetic is exact (no binary floating point drift)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
    let sum = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) sum = sum.add(brl('0.01'));
    expect(sum.amount).toBe('10.00');
    expect(brl('1.00').subtract(brl('1.01')).amount).toBe('-0.01');
    expect(brl('5.00').negate().amount).toBe('-5.00');
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.amount).toBe('10.00');
    expect(b).not.toBe(a);
    expect(a.negate()).not.toBe(a);
    expect(a.amount).toBe('10.00');
  });

  test('comparisons', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
  });

  test.each([
    ['', 'empty string'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', 'negative Infinity'],
    ['1e3', 'scientific notation'],
    ['1E-2', 'scientific notation (upper case)'],
    ['10.001', 'more than 2 decimals'],
    ['10.005', 'more than 2 decimals (no rounding)'],
    ['-10.00', 'negative in an input contract'],
    ['+10.00', 'explicit plus sign'],
    ['010.00', 'leading zero'],
    ['10.', 'trailing dot'],
    ['.50', 'missing integer part'],
    [' 10.00', 'whitespace'],
    ['10,00', 'comma decimal separator'],
    ['0x10', 'hex'],
    ['1000000000000000.00', 'more than 15 integer digits'],
  ])('rejects %p (%s)', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects non-string amounts (numbers never enter the domain)', () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: 0.1 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', '123'])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('fromSigned accepts negatives for internal values only', () => {
    expect(Money.fromSigned({ amount: '-12.30', currency: 'BRL' }).amount).toBe('-12.30');
    expect(Money.fromSigned({ amount: '-0.00', currency: 'BRL' }).amount).toBe('0.00');
  });

  test('operations across currencies throw a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
