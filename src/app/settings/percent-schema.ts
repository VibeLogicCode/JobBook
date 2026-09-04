import { z } from 'zod';
import { parsePercentToTenThou } from '@/app/settings/percent';

/**
 * A percentage field, validated by the same parser that converts it.
 *
 * Separate from percent.ts so a client component can format a percentage
 * without pulling zod into the browser bundle.
 *
 * Blank and malformed are told apart deliberately. Both would otherwise arrive
 * as null from the parser, and "leave the holdback unset" must not be the same
 * outcome as "the owner typed 'ten percent'".
 */
export const percentField = (options?: { min?: number; max?: number; allowBlank?: boolean }) => {
  const { min = 0, max = 100, allowBlank = true } = options ?? {};
  const bad = 'must be a percentage with at most two decimal places';

  return z
    .string()
    .transform((value) => value.trim())
    .transform((raw) =>
      raw === ''
        ? { blank: true, value: null as bigint | null }
        : { blank: false, value: parsePercentToTenThou(raw) },
    )
    .refine((parsed) => allowBlank || !parsed.blank, 'is required')
    .refine((parsed) => parsed.blank || parsed.value !== null, bad)
    .refine(
      // Compared in the stored scale, so the bound in the message and the bound
      // in the check are the same number: 100% is 10000 ten-thousandths.
      (parsed) =>
        parsed.value === null ||
        (parsed.value >= BigInt(min) * 100n && parsed.value <= BigInt(max) * 100n),
      `must be between ${min}% and ${max}%`,
    )
    .transform((parsed) => parsed.value);
};
