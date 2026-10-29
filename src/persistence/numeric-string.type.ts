import { Type } from '@mikro-orm/core';

/**
 * numeric(20,2) entra e sai como string.
 * number vindo do driver é recusado, sem parseFloat, Number ou toNumber.
 */
export class NumericStringType extends Type<string | null, string | null> {
  override convertToDatabaseValue(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new Error('numeric must be written as string');
    }
    return value;
  }

  override convertToJSValue(value: string | null | undefined | number): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number') {
      throw new Error('numeric arrived as number');
    }
    return value;
  }

  override getColumnType(): string {
    return 'numeric(20,2)';
  }
}
