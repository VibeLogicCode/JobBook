# Phase 1, Plan 1 — Foundation & Calculation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tested, headless quote and tax calculation engine on a migrated PostgreSQL schema, with exact integer arithmetic and no user interface.

**Architecture:** Next.js 16 project scaffolded to Budget Tracker's conventions, PostgreSQL 16 in Docker Compose, Drizzle for schema and migrations. All monetary arithmetic uses scaled integers and BigInt internally, rounding once at defined boundaries. The engine is pure functions over plain data — it does not read the database, so it is fast to test and impossible to make order-dependent.

**Tech Stack:** Next.js 16, React 19, TypeScript 6, PostgreSQL 16, Drizzle ORM 0.45, Vitest 3, zod, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-30-maple-quote-design.md` and `docs/superpowers/specs/2026-08-30-ui-design.md`

**Plan 1 of 5 for Phase 1.** Later plans: (2) application and worksheet UI, (3) PDF documents, (4) SharePoint sync and backup, (5) first-run setup and accountant export.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node >= 22.** TypeScript `strict: true`. No `any` in committed code.
- **Nothing is ever deleted.** No `DELETE` statement anywhere. Voiding sets `record_status = 'void'` with `voided_at`, `voided_by`, and a required `void_reason`.
- **No company-specific value in code, templates, or logic.** Not "Maple Custom Homes", not `0.13`, not an Ontario assumption. Seed files are the only permitted location, and they are data.
- **Money is integer cents.** JavaScript `number` never holds a monetary value mid-calculation.
- **Quantities are integer thousandths. Rates are integer ten-thousandths.** `qty × rate` is computed in `BigInt` and rounded once, half-up, at the line boundary.
- **Rates are snapshotted onto quote lines** at line creation. Quote lines never reference `rate_items` for a price.
- **Tax is computed on the summed taxable base and rounded once**, not per line.
- Every synced table carries `created_at`, `updated_at`, `created_by`, `record_status`, `voided_at`, `voided_by`, `void_reason`.
- Follow Budget Tracker's layout: `src/db/`, `src/lib/<domain>/`, `tests/{unit,integration,db}/`.
- Commit after every task. Conventional commit prefixes (`feat:`, `test:`, `chore:`).

### Scale constants, fixed for the whole system

| Concept | Storage | Scale | Example |
|---|---|---|---|
| Money | `bigint` cents | 10^2 | `$1,240.50` → `124050` |
| Quantity | `bigint` thousandths | 10^3 | `1240.500 sqft` → `1240500` |
| Rate | `bigint` ten-thousandths | 10^4 | `$4.0000/sqft` → `40000` |
| Percent | `bigint` ten-thousandths | 10^4 | `13%` → `1300` |
| Margin | `integer` basis points | 10^4 | `24.2%` → `2420` |

**Why BigInt is mandatory, not defensive:** a maximum quantity (`999999999` thousandths) times a maximum rate (`999999999` ten-thousandths) is approximately `1e18`, which exceeds `Number.MAX_SAFE_INTEGER` (`9.007e15`). Multiplying with `number` silently loses precision on large quotes.

**Note for Plan 4:** SharePoint mirrors these as Number fields. The sync layer must unscale — a rate must appear as `4.0000` in SharePoint, not `40000`. Storage scale is an internal representation.

---

### Task 1: Project scaffold, database, and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore`, `vitest.config.ts`, `drizzle.config.ts`
- Create: `src/db/client.ts`
- Test: `tests/db/connection.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `db` (Drizzle client instance) from `src/db/client.ts`; `npm test`, `npm run typecheck`, `npm run db:push` scripts

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "contractor-quote",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:up": "docker compose up -d db"
  },
  "dependencies": {
    "drizzle-orm": "0.45.2",
    "next": "^16.3.2",
    "postgres": "^3.4.5",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "@types/react": "^19.2.18",
    "drizzle-kit": "^0.31.0",
    "typescript": "^6.0.3",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `docker-compose.yml`**

Ports are published only for local development against the test database. The production compose file in Plan 4 publishes nothing.

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: quote
      POSTGRES_PASSWORD: quote_dev_only
      POSTGRES_DB: quote
    ports:
      - "127.0.0.1:5433:5432"
    volumes:
      - dbdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U quote"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  dbdata:
```

- [ ] **Step 3: Create `.env.example` and `.gitignore`**

```bash
# .env.example
DATABASE_URL=postgres://quote:quote_dev_only@127.0.0.1:5433/quote
TEST_DATABASE_URL=postgres://quote:quote_dev_only@127.0.0.1:5433/quote_test
```

```
# .gitignore
node_modules/
.next/
.env
.env.*
!.env.example
*.pem
*.pfx
backups/
```

- [ ] **Step 4: Create `tsconfig.json`, `next.config.ts`, `drizzle.config.ts`, `vitest.config.ts`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "skipLibCheck": true,
    "paths": { "@/*": ["./src/*"] },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

```ts
// next.config.ts
import type { NextConfig } from 'next';
const config: NextConfig = { output: 'standalone' };
export default config;
```

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
```

- [ ] **Step 5: Create `src/db/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const queryClient = postgres(url, { max: 10 });
export const db = drizzle(queryClient);
export { queryClient };
```

- [ ] **Step 6: Write the failing test**

```ts
// tests/db/connection.test.ts
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

describe('database connection', () => {
  it('answers a trivial query', async () => {
    const rows = await db.execute(sql`select 1 as one`);
    expect(rows[0]).toEqual({ one: 1 });
  });
});
```

- [ ] **Step 7: Run the test and watch it fail**

Run: `npm install && npm run db:up && npm test`
Expected: FAIL — `DATABASE_URL is not set`, because `.env` does not exist yet.

- [ ] **Step 8: Create `.env` from the example and re-run**

Run: `cp .env.example .env && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js project, Postgres compose, and Vitest harness"
```

---

### Task 2: Scaled-integer arithmetic primitives

The whole system's correctness rests on this file. It is pure, has no imports, and is tested first.

**Files:**
- Create: `src/lib/money/scale.ts`
- Test: `tests/unit/scale.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `divRoundHalfUp(numerator: bigint, denominator: bigint): bigint`
  - `lineTotalCents(qtyMilli: bigint, rateTenThou: bigint): bigint`
  - `applyPercentCents(baseCents: bigint, percentTenThou: bigint): bigint`
  - `marginBasisPoints(revenueCents: bigint, costCents: bigint): number`
  - `markupBasisPoints(revenueCents: bigint, costCents: bigint): number`
  - Constants `QTY_SCALE`, `RATE_SCALE`, `CENT_SCALE`, `LINE_DIVISOR`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/scale.test.ts
import { describe, expect, it } from 'vitest';
import {
  applyPercentCents,
  divRoundHalfUp,
  lineTotalCents,
  marginBasisPoints,
  markupBasisPoints,
} from '@/lib/money/scale';

describe('divRoundHalfUp', () => {
  it('rounds a half up, away from zero', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
  });

  it('rounds below a half down', () => {
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
  });

  it('divides exactly when there is no remainder', () => {
    expect(divRoundHalfUp(10n, 5n)).toBe(2n);
  });

  it('throws on a zero denominator', () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow('denominator must not be zero');
  });
});

describe('lineTotalCents', () => {
  it('multiplies 1240.500 sqft by $4.0000 to $4962.00', () => {
    expect(lineTotalCents(1240500n, 40000n)).toBe(496200n);
  });

  it('multiplies 2 each by $720.0000 to $1440.00', () => {
    expect(lineTotalCents(2000n, 7200000n)).toBe(144000n);
  });

  it('rounds a half-cent up', () => {
    // 1.000 x 0.0050 = 0.005 -> 1 cent (half up)
    expect(lineTotalCents(1000n, 50n)).toBe(1n);
  });

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    // 999999.999 sqft x $99999.9999 -- the product exceeds 2^53
    const result = lineTotalCents(999999999n, 999999999n);
    expect(result).toBe(9999999980000n);
  });
});

describe('applyPercentCents', () => {
  it('takes 13% of $84,300.00', () => {
    expect(applyPercentCents(8430000n, 1300n)).toBe(1095900n);
  });

  it('takes 10% of an amount that rounds', () => {
    // 10% of $0.05 = $0.005 -> 1 cent
    expect(applyPercentCents(5n, 1000n)).toBe(1n);
  });
});

describe('marginBasisPoints', () => {
  it('reports margin as (revenue - cost) / revenue', () => {
    // rev 100.00, cost 75.00 -> 25.00%
    expect(marginBasisPoints(10000n, 7500n)).toBe(2500);
  });

  it('is negative when cost exceeds revenue', () => {
    expect(marginBasisPoints(10000n, 12000n)).toBe(-2000);
  });

  it('returns 0 for zero revenue rather than dividing by zero', () => {
    expect(marginBasisPoints(0n, 5000n)).toBe(0);
  });
});

describe('markupBasisPoints', () => {
  it('differs from margin on the same figures', () => {
    // rev 100.00, cost 75.00 -> markup 33.33%, margin 25.00%
    expect(markupBasisPoints(10000n, 7500n)).toBe(3333);
    expect(marginBasisPoints(10000n, 7500n)).toBe(2500);
  });

  it('returns 0 for zero cost rather than dividing by zero', () => {
    expect(markupBasisPoints(10000n, 0n)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/scale.test.ts`
Expected: FAIL — cannot resolve `@/lib/money/scale`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/money/scale.ts

/** Quantities are stored as integer thousandths: 1240.500 sqft -> 1240500n. */
export const QTY_SCALE = 1000n;
/** Rates and percents are stored as integer ten-thousandths: $4.0000 -> 40000n; 13% -> 1300n. */
export const RATE_SCALE = 10000n;
/** Money is stored as integer cents. */
export const CENT_SCALE = 100n;
/**
 * qtyMilli * rateTenThou carries a scale of 10^7. Cents carry 10^2, so the
 * product is divided by 10^5 to land on cents.
 */
export const LINE_DIVISOR = (QTY_SCALE * RATE_SCALE) / CENT_SCALE;

/**
 * Integer division rounding halves away from zero.
 *
 * Half-up is the convention Canadian tax arithmetic expects, and rounding away
 * from zero keeps a credit and its matching charge symmetric.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('denominator must not be zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * A line's total in cents.
 *
 * BigInt is required rather than defensive: a maximum quantity times a maximum
 * rate is approximately 1e18, which exceeds Number.MAX_SAFE_INTEGER. Computing
 * this with `number` loses precision silently on large quotes.
 */
export function lineTotalCents(qtyMilli: bigint, rateTenThou: bigint): bigint {
  return divRoundHalfUp(qtyMilli * rateTenThou, LINE_DIVISOR);
}

/** A percentage of a cent amount, rounded once to cents. */
export function applyPercentCents(baseCents: bigint, percentTenThou: bigint): bigint {
  return divRoundHalfUp(baseCents * percentTenThou, RATE_SCALE);
}

/**
 * Margin in basis points: (revenue - cost) / revenue.
 *
 * Margin and markup are different numbers on the same figures -- a 33.33%
 * markup is a 25% margin -- and conflating them is how contractors quote
 * themselves into a loss. Both are exposed so the interface can show one and
 * label the other.
 */
export function marginBasisPoints(revenueCents: bigint, costCents: bigint): number {
  if (revenueCents === 0n) return 0;
  return Number(divRoundHalfUp((revenueCents - costCents) * RATE_SCALE, revenueCents));
}

/** Markup in basis points: (revenue - cost) / cost. */
export function markupBasisPoints(revenueCents: bigint, costCents: bigint): number {
  if (costCents === 0n) return 0;
  return Number(divRoundHalfUp((revenueCents - costCents) * RATE_SCALE, costCents));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/scale.test.ts`
Expected: PASS, 16 assertions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money/scale.ts tests/unit/scale.test.ts
git commit -m "feat: add scaled-integer arithmetic primitives for money, rates, and margin"
```

---

### Task 3: Formatting and parsing

Ported from Budget Tracker's `src/lib/money.ts` so both codebases format money identically, extended with the quantity and rate scales this product needs.

**Files:**
- Create: `src/lib/money/format.ts`
- Test: `tests/unit/format.test.ts`

**Interfaces:**
- Consumes: `QTY_SCALE`, `RATE_SCALE` from `@/lib/money/scale`
- Produces:
  - `formatCents(cents: number, opts?: { showSign?: boolean; currency?: boolean; locale?: string }): string`
  - `sumCents(values: number[]): number`
  - `parseAmountToCents(raw: string): number | null`
  - `parseQtyToMilli(raw: string): bigint | null`
  - `parseRateToTenThou(raw: string): bigint | null`
  - `formatQty(qtyMilli: bigint): string`
  - `formatRate(rateTenThou: bigint): string`
  - `formatBasisPoints(bp: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/format.test.ts
import { describe, expect, it } from 'vitest';
import {
  formatBasisPoints,
  formatCents,
  formatQty,
  formatRate,
  parseAmountToCents,
  parseQtyToMilli,
  parseRateToTenThou,
  sumCents,
} from '@/lib/money/format';

describe('formatCents', () => {
  it('formats with a currency symbol and two decimals', () => {
    expect(formatCents(496200)).toBe('$4,962.00');
  });

  it('places the sign before the symbol when negative', () => {
    expect(formatCents(-496200)).toBe('-$4,962.00');
  });

  it('shows an explicit plus only when asked', () => {
    expect(formatCents(100, { showSign: true })).toBe('+$1.00');
    expect(formatCents(100)).toBe('$1.00');
  });

  it('omits the symbol when currency is false', () => {
    expect(formatCents(496200, { currency: false })).toBe('4,962.00');
  });
});

describe('sumCents', () => {
  it('adds integers without float drift', () => {
    expect(sumCents([1, 2, 3])).toBe(6);
  });

  it('returns 0 for an empty list', () => {
    expect(sumCents([])).toBe(0);
  });
});

describe('parseAmountToCents', () => {
  it('parses a plain decimal', () => {
    expect(parseAmountToCents('4962.00')).toBe(496200);
  });

  it('strips currency symbols and thousands separators', () => {
    expect(parseAmountToCents('$4,962.00')).toBe(496200);
  });

  it('reads accounting parentheses as negative', () => {
    expect(parseAmountToCents('(1,440.00)')).toBe(-144000);
  });

  it('returns null on blank or malformed input', () => {
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents('abc')).toBeNull();
  });
});

describe('parseQtyToMilli', () => {
  it('parses three decimal places', () => {
    expect(parseQtyToMilli('1240.5')).toBe(1240500n);
  });

  it('truncates beyond three decimals rather than guessing', () => {
    expect(parseQtyToMilli('1.9999')).toBeNull();
  });

  it('rejects a negative quantity', () => {
    expect(parseQtyToMilli('-5')).toBeNull();
  });
});

describe('parseRateToTenThou', () => {
  it('parses four decimal places', () => {
    expect(parseRateToTenThou('4')).toBe(40000n);
    expect(parseRateToTenThou('4.0025')).toBe(40025n);
  });

  it('rejects more than four decimals', () => {
    expect(parseRateToTenThou('4.00001')).toBeNull();
  });
});

describe('display helpers', () => {
  it('formats a quantity without trailing zero noise', () => {
    expect(formatQty(1240500n)).toBe('1,240.5');
    expect(formatQty(2000n)).toBe('2');
  });

  it('formats a rate to four decimals', () => {
    expect(formatRate(40000n)).toBe('4.0000');
  });

  it('formats basis points as a percentage', () => {
    expect(formatBasisPoints(2420)).toBe('24.2%');
    expect(formatBasisPoints(-2000)).toBe('-20.0%');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/format.test.ts`
Expected: FAIL — cannot resolve `@/lib/money/format`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/money/format.ts
import { QTY_SCALE, RATE_SCALE } from '@/lib/money/scale';

const DEFAULT_LOCALE = 'en-CA';

/**
 * Formats integer cents.
 *
 * Ported from Budget Tracker's src/lib/money.ts so both products render money
 * identically. `locale` is a parameter rather than a constant because the
 * organization record carries one -- nothing here may assume Canada.
 */
export function formatCents(
  cents: number,
  opts: { showSign?: boolean; currency?: boolean; locale?: string } = {},
): string {
  const { showSign = false, currency = true, locale = DEFAULT_LOCALE } = opts;
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const negative = cents < 0;
  const body = formatter.format(Math.abs(cents) / 100);
  const symbol = currency ? '$' : '';
  if (negative) return `-${symbol}${body}`;
  if (showSign && cents > 0) return `+${symbol}${body}`;
  return `${symbol}${body}`;
}

export function sumCents(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Splits a numeric string into sign, whole, and fraction. Returns null if malformed. */
function splitNumeric(raw: string): { negative: boolean; whole: string; fraction: string } | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text.length === 0) return null;

  text = text.replace(/−/g, '-').replace(/ /g, ' ');

  let negative = false;
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) {
    negative = true;
    text = paren[1].trim();
  }

  text = text.replace(/(?:CAD|USD|\$)/gi, '').replace(/\s+/g, '');
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  text = text.replace(/,/g, '');

  if (!/^\d*(?:\.\d*)?$/.test(text) || text === '' || text === '.') return null;

  const [whole = '', fraction = ''] = text.split('.');
  return { negative, whole: whole === '' ? '0' : whole, fraction };
}

/** Parses a currency string into integer cents. Returns null when not a well-formed number. */
export function parseAmountToCents(raw: string): number | null {
  const parts = splitNumeric(raw);
  if (!parts) return null;
  if (parts.fraction.length > 2) return null;
  const padded = parts.fraction.padEnd(2, '0');
  const cents = Number(parts.whole) * 100 + Number(padded);
  if (!Number.isSafeInteger(cents)) return null;
  const signed = parts.negative ? -cents : cents;
  return signed === 0 ? 0 : signed;
}

/**
 * Parses a quantity into integer thousandths.
 *
 * Extra precision is rejected rather than rounded. A user who types 1.9999 sqft
 * has made a mistake or expects four decimals; silently storing 1.999 would
 * change a figure they will later see on a document.
 */
export function parseQtyToMilli(raw: string): bigint | null {
  const parts = splitNumeric(raw);
  if (!parts || parts.negative) return null;
  if (parts.fraction.length > 3) return null;
  const padded = parts.fraction.padEnd(3, '0');
  return BigInt(parts.whole) * QTY_SCALE + BigInt(padded);
}

/** Parses a rate or percent into integer ten-thousandths. Rejects extra precision. */
export function parseRateToTenThou(raw: string): bigint | null {
  const parts = splitNumeric(raw);
  if (!parts) return null;
  if (parts.fraction.length > 4) return null;
  const padded = parts.fraction.padEnd(4, '0');
  const magnitude = BigInt(parts.whole) * RATE_SCALE + BigInt(padded);
  return parts.negative ? -magnitude : magnitude;
}

/** Renders a quantity, dropping trailing zeroes so "2" does not print as "2.000". */
export function formatQty(qtyMilli: bigint, locale = DEFAULT_LOCALE): string {
  const whole = qtyMilli / QTY_SCALE;
  const fraction = (qtyMilli % QTY_SCALE).toString().padStart(3, '0').replace(/0+$/, '');
  const wholeText = new Intl.NumberFormat(locale).format(whole);
  return fraction === '' ? wholeText : `${wholeText}.${fraction}`;
}

/** Renders a rate at its full four decimals -- rates are specifications, not display values. */
export function formatRate(rateTenThou: bigint, locale = DEFAULT_LOCALE): string {
  const negative = rateTenThou < 0n;
  const magnitude = negative ? -rateTenThou : rateTenThou;
  const whole = magnitude / RATE_SCALE;
  const fraction = (magnitude % RATE_SCALE).toString().padStart(4, '0');
  const wholeText = new Intl.NumberFormat(locale).format(whole);
  return `${negative ? '-' : ''}${wholeText}.${fraction}`;
}

/** Renders basis points as a percentage to one decimal. */
export function formatBasisPoints(bp: number): string {
  return `${(bp / 100).toFixed(1)}%`;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money/format.ts tests/unit/format.test.ts
git commit -m "feat: add money, quantity, and rate formatting and parsing"
```

---

### Task 4: Shared column helpers and enums

**Files:**
- Create: `src/db/columns.ts`
- Create: `src/db/enums.ts`
- Test: `tests/unit/columns.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `auditColumns` — spread into every synced table: `createdAt`, `updatedAt`, `createdBy`, `recordStatus`, `voidedAt`, `voidedBy`, `voidReason`
  - `cents(name)`, `qty(name)`, `rate(name)` column builders
  - Enums: `recordStatusEnum`, `roleEnum`, `customerTypeEnum`, `leadSourceEnum`, `projectTypeEnum`, `projectStageEnum`, `calcModeEnum`, `quoteStatusEnum`, `entityTypeEnum`, `filingFrequencyEnum`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/columns.test.ts
import { describe, expect, it } from 'vitest';
import { auditColumns } from '@/db/columns';
import { recordStatusEnum, calcModeEnum } from '@/db/enums';

describe('auditColumns', () => {
  it('carries every column the sync watermark and void model require', () => {
    expect(Object.keys(auditColumns).sort()).toEqual([
      'createdAt',
      'createdBy',
      'recordStatus',
      'updatedAt',
      'voidReason',
      'voidedAt',
      'voidedBy',
    ]);
  });
});

describe('enums', () => {
  it('offers exactly active and void as record statuses', () => {
    expect(recordStatusEnum.enumValues).toEqual(['active', 'void']);
  });

  it('offers the five quote line unit types', () => {
    expect(calcModeEnum.enumValues).toEqual(['sqft', 'each', 'flat', 'percent', 'hour']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/columns.test.ts`
Expected: FAIL — cannot resolve `@/db/columns`.

- [ ] **Step 3: Write `src/db/enums.ts`**

```ts
import { pgEnum } from 'drizzle-orm/pg-core';

export const recordStatusEnum = pgEnum('record_status', ['active', 'void']);
export const roleEnum = pgEnum('role', ['owner', 'admin', 'bookkeeper']);
export const customerTypeEnum = pgEnum('customer_type', ['residential', 'commercial']);
export const leadSourceEnum = pgEnum('lead_source', [
  'call', 'email', 'referral', 'website', 'repeat', 'other',
]);
export const projectTypeEnum = pgEnum('project_type', [
  'custom_home', 'basement', 'renovation', 'kitchen',
  'bathroom', 'addition', 'commercial_ti', 'water_leak', 'other',
]);
export const projectStageEnum = pgEnum('project_stage', [
  'lead', 'site_visit', 'quoting', 'quote_sent', 'won',
  'lost', 'in_progress', 'complete', 'on_hold',
]);
export const contractTypeEnum = pgEnum('contract_type', [
  'lump_sum', 'unit_price', 'cost_plus', 'time_and_material',
]);

/**
 * How a line calculates -- deliberately separate from what it is labelled.
 *
 * An earlier fused enum ('sqft'|'each'|'flat'|'percent'|'hour') conflated the
 * two: sqft, each and hour all compute identically, and only flat and percent
 * differ at all. Worse, it had no member for linear feet, so baseboard, trim,
 * countertop and fencing -- priced per linear foot by every contractor --
 * could not be entered, and a metric deployment could not say m2.
 */
export const calcModeEnum = pgEnum('calc_mode', ['qty', 'flat', 'percent']);

export const quoteKindEnum = pgEnum('quote_kind', ['estimate', 'change_order']);
export const changeReasonEnum = pgEnum('change_reason', [
  'customer_request', 'site_condition', 'design_change',
  'code_requirement', 'error_omission', 'allowance_reconciliation',
]);
export const pricingDisplayEnum = pgEnum('pricing_display', [
  'detailed', 'group_totals', 'lump_sum',
]);
export const clauseKindEnum = pgEnum('clause_kind', ['exclusion', 'assumption']);
export const areaUnitEnum = pgEnum('area_unit', ['sqft', 'sqm']);

// 'expired' is deliberately absent: it derives from valid_until, and a stored
// value is wrong the moment the clock passes it.
export const quoteStatusEnum = pgEnum('quote_status', [
  'draft', 'sent', 'accepted', 'declined', 'superseded',
]);
export const qtySourceEnum = pgEnum('qty_source', [
  'area', 'washrooms', 'kitchens', 'bedrooms', 'fixed', 'manual',
]);
export const entityTypeEnum = pgEnum('entity_type', [
  'organization', 'quote', 'project', 'customer', 'receipt',
  'vendor_invoice', 'purchase_order',
]);
export const filingFrequencyEnum = pgEnum('filing_frequency', ['annual', 'quarterly', 'monthly']);
```

- [ ] **Step 4: Write `src/db/columns.ts`**

```ts
import { bigint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { recordStatusEnum } from '@/db/enums';

/**
 * Columns every mirrored table carries.
 *
 * `updatedAt` drives the SharePoint sync watermark, so a table without it can
 * never be mirrored. `recordStatus` replaces deletion entirely: a watermark
 * sync cannot observe a row that no longer exists, and these are tax records.
 */
export const auditColumns = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  recordStatus: recordStatusEnum('record_status').notNull().default('active'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: uuid('voided_by'),
  voidReason: text('void_reason'),
};

/**
 * Money, in integer cents.
 *
 * `mode: 'number'` is safe: cent values stay far below Number.MAX_SAFE_INTEGER,
 * and it lets these values pass straight to the Money component, which takes a
 * number. BigInt is used inside the calculation engine, where products overflow.
 */
export const cents = (name: string) => bigint(name, { mode: 'number' });

/** Quantity, in integer thousandths. */
export const qty = (name: string) => bigint(name, { mode: 'bigint' });

/** Rate or percent, in integer ten-thousandths. */
export const rate = (name: string) => bigint(name, { mode: 'bigint' });
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run tests/unit/columns.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/columns.ts src/db/enums.ts tests/unit/columns.test.ts
git commit -m "feat: add shared audit columns, scaled column builders, and enums"
```

---

### Task 5: Schema — organization, feature flags, tax rates, users

**Files:**
- Create: `src/db/schema/organization.ts`
- Create: `src/db/schema/index.ts`
- Modify: `drizzle.config.ts` — point `schema` at `./src/db/schema/index.ts`
- Test: `tests/db/organization.test.ts`

**Interfaces:**
- Consumes: `auditColumns`, `cents`, `rate` from `@/db/columns`; enums from `@/db/enums`
- Produces: tables `organization`, `featureFlags`, `taxRates`, `users`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/organization.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization, taxRates, users } from '@/db/schema';

beforeEach(async () => {
  await db.execute(sql`truncate table tax_rates, users, organization restart identity cascade`);
});

describe('organization', () => {
  it('permits exactly one row', async () => {
    await db.insert(organization).values({ id: 1, legalName: 'Acme Ltd', displayName: 'Acme' });
    await expect(
      db.insert(organization).values({ id: 2, legalName: 'Other Ltd', displayName: 'Other' }),
    ).rejects.toThrow();
  });

  it('stores fiscal year end as month and day, not a fixed date', async () => {
    await db.insert(organization).values({
      id: 1, legalName: 'Acme Ltd', displayName: 'Acme',
      fiscalYearEndMonth: 6, fiscalYearEndDay: 30,
    });
    const [row] = await db.select().from(organization);
    expect(row.fiscalYearEndMonth).toBe(6);
    expect(row.fiscalYearEndDay).toBe(30);
  });
});

describe('taxRates', () => {
  it('stores a rate in ten-thousandths with an effective window', async () => {
    await db.insert(taxRates).values({
      label: 'HST', rateTenThou: 1300n, effectiveFrom: '2010-07-01', sortOrder: 1,
    });
    const [row] = await db.select().from(taxRates);
    expect(row.rateTenThou).toBe(1300n);
    expect(row.effectiveTo).toBeNull();
    expect(row.isCompound).toBe(false);
  });
});

describe('users', () => {
  it('defaults every row to active', async () => {
    await db.insert(users).values({
      entraObjectId: 'oid-1', email: 'a@example.com', displayName: 'A', role: 'owner',
    });
    const [row] = await db.select().from(users);
    expect(row.recordStatus).toBe('active');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/db/organization.test.ts`
Expected: FAIL — cannot resolve `@/db/schema`.

- [ ] **Step 3: Write `src/db/schema/organization.ts`**

```ts
import { boolean, check, date, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, rate } from '@/db/columns';
import { filingFrequencyEnum, roleEnum } from '@/db/enums';

/**
 * Single-row tenant configuration. Every company-specific string in the product
 * lives here; nothing is hardcoded (spec section 2.1).
 */
export const organization = pgTable('organization', {
  id: integer('id').primaryKey(),

  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  operatingName: text('operating_name'),
  tagline: text('tagline'),
  ownerName: text('owner_name'),
  ownerTitle: text('owner_title'),
  logoFileId: uuid('logo_file_id'),
  faviconFileId: uuid('favicon_file_id'),
  brandColor: text('brand_color'),

  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  province: text('province'),
  postalCode: text('postal_code'),
  country: text('country'),
  phone: text('phone'),
  altPhone: text('alt_phone'),
  email: text('email'),
  website: text('website'),

  taxRegistrationNumber: text('tax_registration_number'),
  taxRegistrationLabel: text('tax_registration_label'),
  businessNumber: text('business_number'),
  currency: text('currency').notNull().default('CAD'),
  locale: text('locale').notNull().default('en-CA'),
  fiscalYearEndMonth: integer('fiscal_year_end_month'),
  fiscalYearEndDay: integer('fiscal_year_end_day'),
  taxFilingFrequency: filingFrequencyEnum('tax_filing_frequency'),
  holdbackPct: rate('holdback_pct'),
  holdbackLabel: text('holdback_label'),
  holdbackTermsText: text('holdback_terms_text'),
  paymentTermsDays: integer('payment_terms_days'),
  paymentTermsText: text('payment_terms_text'),
  insuranceStatement: text('insurance_statement'),

  quoteNumberPrefix: text('quote_number_prefix'),
  nextQuoteSeq: integer('next_quote_seq').notNull().default(1),
  invoiceNumberPrefix: text('invoice_number_prefix'),
  nextInvoiceSeq: integer('next_invoice_seq').notNull().default(1),
  poNumberPrefix: text('po_number_prefix'),
  nextPoSeq: integer('next_po_seq').notNull().default(1),
  quoteValidityDays: integer('quote_validity_days').notNull().default(30),
  quoteTermsText: text('quote_terms_text'),
  documentFooterText: text('document_footer_text'),

  ...auditColumns,
}, (t) => ({
  // Enforces single-tenancy at the database, not by convention.
  onlyOneRow: check('organization_single_row', sql`${t.id} = 1`),
}));

/** Named toggles. A table rather than boolean columns so Phase 3 and 4 add rows, not migrations. */
export const featureFlags = pgTable('feature_flags', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  config: jsonb('config'),
  ...auditColumns,
}, (t) => ({
  keyUnique: uniqueIndex('feature_flags_key_unique').on(t.key),
}));

/**
 * Tax rates, versioned by effective date rather than edited in place.
 *
 * Editing closes the current row and inserts a new one, so the rate that
 * applied on any past date stays answerable. This works with, not instead of,
 * the per-quote snapshot in quote_taxes.
 */
export const taxRates = pgTable('tax_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  shortLabel: text('short_label'),
  registrationNumber: text('registration_number'),
  rateTenThou: rate('rate_ten_thou').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  isCompound: boolean('is_compound').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
});

/**
 * Keyed on email. The Cloudflare Access JWT does not carry an Entra object id
 * without additional identity-provider claim configuration, and email suffices
 * for three users.
 *
 * Deactivated via `isActive`, never voided: `email` is UNIQUE, so a voided row
 * would permanently block re-adding the same person.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: roleEnum('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => ({
  emailUnique: uniqueIndex('users_email_unique').on(t.email),
}));
```

- [ ] **Step 4: Create `src/db/schema/index.ts` and update `drizzle.config.ts`**

```ts
// src/db/schema/index.ts
export * from '@/db/schema/organization';
```

In `drizzle.config.ts`, change `schema: './src/db/schema.ts'` to `schema: './src/db/schema/index.ts'`.

- [ ] **Step 5: Push the schema and run the test**

Run: `npm run db:push && npx vitest run tests/db/organization.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema drizzle.config.ts drizzle tests/db/organization.test.ts
git commit -m "feat: add organization, feature flag, tax rate, and user schema"
```

---

### Task 6: Schema — customers and projects

**Files:**
- Create: `src/db/schema/customers.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/db/customers.test.ts`

**Interfaces:**
- Consumes: `auditColumns`, `cents` from `@/db/columns`; enums from `@/db/enums`
- Produces: tables `customers`, `projects`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/customers.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects } from '@/db/schema';

beforeEach(async () => {
  await db.execute(sql`truncate table projects, customers restart identity cascade`);
});

describe('customers', () => {
  it('defaults to a non-exempt residential customer', async () => {
    const [row] = await db.insert(customers)
      .values({ name: 'Eleanor Vance', customerType: 'residential' })
      .returning();
    expect(row.isTaxExempt).toBe(false);
    expect(row.province).toBeNull();
  });

  it('stores an exemption number and reason together', async () => {
    const [row] = await db.insert(customers).values({
      name: 'Regional Health', customerType: 'commercial',
      isTaxExempt: true, taxExemptNumber: 'EX-4471', taxExemptReason: 'Public body',
    }).returning();
    expect(row.taxExemptNumber).toBe('EX-4471');
  });
});

describe('projects', () => {
  it('keeps scheduled and actual dates as separate fields', async () => {
    const [customer] = await db.insert(customers)
      .values({ name: 'Eleanor Vance', customerType: 'residential' }).returning();
    const [row] = await db.insert(projects).values({
      customerId: customer.id, projectNumber: 'P-0001', name: 'Basement finish',
      projectType: 'basement', stage: 'lead',
      scheduledStart: '2026-09-01', scheduledEnd: '2026-11-15',
    }).returning();
    expect(row.scheduledStart).toBe('2026-09-01');
    expect(row.actualStart).toBeNull();
  });

  it('rejects a duplicate project number', async () => {
    const [customer] = await db.insert(customers)
      .values({ name: 'A', customerType: 'residential' }).returning();
    const base = {
      customerId: customer.id, name: 'X', projectType: 'basement' as const, stage: 'lead' as const,
    };
    await db.insert(projects).values({ ...base, projectNumber: 'P-0001' });
    await expect(
      db.insert(projects).values({ ...base, projectNumber: 'P-0001' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/db/customers.test.ts`
Expected: FAIL — `customers` is not exported.

- [ ] **Step 3: Write `src/db/schema/customers.ts`**

```ts
import { boolean, date, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, cents } from '@/db/columns';
import { customerTypeEnum, leadSourceEnum, projectStageEnum, projectTypeEnum } from '@/db/enums';

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  companyName: text('company_name'),
  email: text('email'),
  phone: text('phone'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  province: text('province'),
  postalCode: text('postal_code'),
  customerType: customerTypeEnum('customer_type').notNull(),
  leadSource: leadSourceEnum('lead_source'),
  // Exemption is stored with its number and reason: the number belongs on the
  // document, and an unexplained exemption is an audit gap.
  isTaxExempt: boolean('is_tax_exempt').notNull().default(false),
  taxExemptNumber: text('tax_exempt_number'),
  taxExemptReason: text('tax_exempt_reason'),
  notes: text('notes'),
  ...auditColumns,
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  projectNumber: text('project_number').notNull(),
  name: text('name').notNull(),
  siteAddressLine1: text('site_address_line1'),
  siteCity: text('site_city'),
  sitePostalCode: text('site_postal_code'),
  projectType: projectTypeEnum('project_type').notNull(),
  stage: projectStageEnum('stage').notNull().default('lead'),
  // Scheduled and actual are separate so slippage is measurable rather than overwritten.
  scheduledStart: date('scheduled_start'),
  scheduledEnd: date('scheduled_end'),
  actualStart: date('actual_start'),
  actualEnd: date('actual_end'),
  contractValueCents: cents('contract_value_cents'),
  lostReason: text('lost_reason'),
  ...auditColumns,
}, (t) => ({
  numberUnique: uniqueIndex('projects_number_unique').on(t.projectNumber),
}));
```

- [ ] **Step 4: Export from `src/db/schema/index.ts`**

```ts
export * from '@/db/schema/organization';
export * from '@/db/schema/customers';
```

- [ ] **Step 5: Push and run the test**

Run: `npm run db:push && npx vitest run tests/db/customers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema tests/db/customers.test.ts drizzle
git commit -m "feat: add customer and project schema"
```

---

### Task 7: Schema — rate cards, rate items, scope templates

**Files:**
- Create: `src/db/schema/rates.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/db/rates.test.ts`

**Interfaces:**
- Consumes: `auditColumns`, `cents`, `qty`, `rate`; enums
- Produces: tables `rateCards`, `rateItems`, `scopeTemplates`, `scopeTemplateItems`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/rates.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { rateCards, rateItems, scopeTemplateItems, scopeTemplates } from '@/db/schema';

beforeEach(async () => {
  await db.execute(
    sql`truncate table scope_template_items, scope_templates, rate_items, rate_cards restart identity cascade`,
  );
});

async function seedCard() {
  const [card] = await db.insert(rateCards)
    .values({ name: 'Default 2026', effectiveFrom: '2026-01-01', targetMarginBp: 2500 })
    .returning();
  return card;
}

describe('rateItems', () => {
  it('carries both a cost and a sell rate so margin is visible per item', async () => {
    const card = await seedCard();
    const [item] = await db.insert(rateItems).values({
      rateCardId: card.id, code: 'DEM-01', description: 'Strip existing',
      category: 'Demolition', calcMode: 'qty', unitLabel: 'sqft',
      costRateTenThou: 28000n, sellRateTenThou: 40000n,
    }).returning();
    expect(item.costRateTenThou).toBe(28000n);
    expect(item.sellRateTenThou).toBe(40000n);
    expect(item.isTaxable).toBe(true);
  });

  it('rejects a duplicate code within one rate card', async () => {
    const card = await seedCard();
    const base = {
      rateCardId: card.id, description: 'X', category: 'Demolition',
      calcMode: 'flat', unitLabel: '' as const, costRateTenThou: 1n, sellRateTenThou: 2n,
    };
    await db.insert(rateItems).values({ ...base, code: 'DUP' });
    await expect(db.insert(rateItems).values({ ...base, code: 'DUP' })).rejects.toThrow();
  });

  it('allows a non-taxable pass-through item', async () => {
    const card = await seedCard();
    const [item] = await db.insert(rateItems).values({
      rateCardId: card.id, code: 'PRM-01', description: 'Building permit',
      category: 'Permits', calcMode: 'flat', unitLabel: '',
      costRateTenThou: 35000000n, sellRateTenThou: 35000000n, isTaxable: false,
    }).returning();
    expect(item.isTaxable).toBe(false);
  });
});

describe('scopeTemplateItems', () => {
  it('derives quantity from a source and a multiplier, not a formula string', async () => {
    const card = await seedCard();
    const [item] = await db.insert(rateItems).values({
      rateCardId: card.id, code: 'ELE-02', description: 'Pot lights',
      category: 'Electrical', calcMode: 'qty', unitLabel: 'ea',
      costRateTenThou: 900000n, sellRateTenThou: 1400000n,
    }).returning();
    const [template] = await db.insert(scopeTemplates)
      .values({ name: 'Basement Finish', projectType: 'basement' }).returning();
    const [line] = await db.insert(scopeTemplateItems).values({
      scopeTemplateId: template.id, rateItemId: item.id,
      qtySource: 'area', qtyMultiplierTenThou: 200n, lineGroup: 'Electrical', sortOrder: 1,
    }).returning();
    expect(line.qtySource).toBe('area');
    expect(line.qtyMultiplierTenThou).toBe(200n);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/db/rates.test.ts`
Expected: FAIL — `rateCards` is not exported.

- [ ] **Step 3: Write `src/db/schema/rates.ts`**

```ts
import { boolean, date, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, qty, rate } from '@/db/columns';
import { projectTypeEnum, qtySourceEnum, calcModeEnum } from '@/db/enums';

export const rateCards = pgTable('rate_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  /** Target margin in basis points; drives the worksheet's margin gauge bands. */
  targetMarginBp: integer('target_margin_bp').notNull().default(2000),
  ...auditColumns,
});

/**
 * A priced item. Cost and sell are both stored so the worksheet can show live
 * margin while the owner edits, and so he can see a quote drifting toward a
 * loss before he sends it. Cost never appears on a customer document.
 */
export const rateItems = pgTable('rate_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  rateCardId: uuid('rate_card_id').notNull().references(() => rateCards.id),
  code: text('code').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  calcMode: calcModeEnum('calc_mode').notNull(),
  unitLabel: text('unit_label').notNull(),
  costRateTenThou: rate('cost_rate_ten_thou').notNull(),
  sellRateTenThou: rate('sell_rate_ten_thou').notNull(),
  /** False for pass-through disbursements such as municipal permit fees. */
  isTaxable: boolean('is_taxable').notNull().default(true),
  defaultQtyMilli: qty('default_qty_milli'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => ({
  codeUnique: uniqueIndex('rate_items_card_code_unique').on(t.rateCardId, t.code),
}));

export const scopeTemplates = pgTable('scope_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  projectType: projectTypeEnum('project_type').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
});

/**
 * Quantity derives as `source value x multiplier`.
 *
 * An expression evaluator was considered and rejected: a user-editable formula
 * language stored in a database column is an injection surface and an unbounded
 * support burden. The enum covers every case described and extends cheaply.
 */
export const scopeTemplateItems = pgTable('scope_template_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  scopeTemplateId: uuid('scope_template_id').notNull().references(() => scopeTemplates.id),
  rateItemId: uuid('rate_item_id').notNull().references(() => rateItems.id),
  qtySource: qtySourceEnum('qty_source').notNull(),
  qtyMultiplierTenThou: rate('qty_multiplier_ten_thou').notNull().default(10000n),
  fixedQtyMilli: qty('fixed_qty_milli'),
  isOptional: boolean('is_optional').notNull().default(false),
  lineGroup: text('line_group').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns,
});
```

- [ ] **Step 4: Export, push, and run**

Add `export * from '@/db/schema/rates';` to `src/db/schema/index.ts`.

Run: `npm run db:push && npx vitest run tests/db/rates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema tests/db/rates.test.ts drizzle
git commit -m "feat: add rate card, rate item, and scope template schema"
```

---

### Task 8: Schema — quotes, lines, taxes, files, sync state, audit log

**Files:**
- Create: `src/db/schema/quotes.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/db/quotes.test.ts`

**Interfaces:**
- Consumes: `auditColumns`, `cents`, `qty`, `rate`; enums; `customers`, `projects`
- Produces: tables `quotes`, `quoteLines`, `quoteTaxes`, `files`, `syncState`, `auditLog`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/quotes.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers, projects, quoteLines, quotes, quoteTaxes } from '@/db/schema';

beforeEach(async () => {
  await db.execute(
    sql`truncate table quote_taxes, quote_lines, quotes, projects, customers restart identity cascade`,
  );
});

async function seedProject() {
  const [customer] = await db.insert(customers)
    .values({ name: 'Eleanor Vance', customerType: 'residential' }).returning();
  const [project] = await db.insert(projects).values({
    customerId: customer.id, projectNumber: 'P-0001', name: 'Basement finish',
    projectType: 'basement', stage: 'quoting',
  }).returning();
  return project;
}

describe('quotes', () => {
  it('rejects two rows with the same version on one project', async () => {
    const project = await seedProject();
    const base = {
      projectId: project.id, quoteNumber: 'Q-0001',
      quoteDate: '2026-09-01', validUntil: '2026-10-01',
    };
    await db.insert(quotes).values({ ...base, version: 1 });
    await expect(db.insert(quotes).values({ ...base, version: 1 })).rejects.toThrow();
  });

  it('defaults a new quote to draft', async () => {
    const project = await seedProject();
    const [row] = await db.insert(quotes).values({
      projectId: project.id, quoteNumber: 'Q-0001', version: 1,
      quoteDate: '2026-09-01', validUntil: '2026-10-01',
    }).returning();
    expect(row.status).toBe('draft');
  });
});

describe('quoteLines', () => {
  it('snapshots the rate rather than referencing the rate item', async () => {
    const project = await seedProject();
    const [quote] = await db.insert(quotes).values({
      projectId: project.id, quoteNumber: 'Q-0001', version: 1,
      quoteDate: '2026-09-01', validUntil: '2026-10-01',
    }).returning();
    const [line] = await db.insert(quoteLines).values({
      quoteId: quote.id, sortOrder: 1, lineGroup: 'Demolition',
      code: 'DEM-01', description: 'Strip existing', calcMode: 'qty', unitLabel: 'sqft',
      qtyMilli: 1240500n, unitCostTenThou: 28000n, unitPriceTenThou: 40000n,
      lineCostCents: 347340, lineTotalCents: 496200, isTaxable: true,
    }).returning();
    expect(line.unitPriceTenThou).toBe(40000n);
    expect(line.lineTotalCents).toBe(496200);
    // rate_item_id and cost_code_id are PRESENT, as provenance. The snapshot
    // rule is about prices, not origin -- without cost_code_id, Phase 3 job
    // costing has nothing to group actual spend against. What must hold is
    // that changing the rate item does not move this line's price, which the
    // snapshot test in tests/integration/repository.test.ts asserts.
    expect(line.rateItemId).not.toBeNull();
    expect(line.costCodeId).not.toBeNull();
  });
});

describe('quoteTaxes', () => {
  it('stores the taxable base alongside the rate so a document reconciles later', async () => {
    const project = await seedProject();
    const [quote] = await db.insert(quotes).values({
      projectId: project.id, quoteNumber: 'Q-0001', version: 1,
      quoteDate: '2026-09-01', validUntil: '2026-10-01',
    }).returning();
    const [tax] = await db.insert(quoteTaxes).values({
      quoteId: quote.id, label: 'HST', registrationNumber: '80000 0000 RT0001',
      rateTenThou: 1300n, taxableBaseCents: 8430000, taxAmountCents: 1095900, sortOrder: 1,
    }).returning();
    expect(tax.taxableBaseCents).toBe(8430000);
    expect(tax.taxAmountCents).toBe(1095900);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/db/quotes.test.ts`
Expected: FAIL — `quotes` is not exported.

- [ ] **Step 3: Write `src/db/schema/quotes.ts`**

```ts
import {
  bigint, boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, cents, qty, rate } from '@/db/columns';
import { entityTypeEnum, quoteStatusEnum, calcModeEnum } from '@/db/enums';
import { projects } from '@/db/schema/customers';

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  quoteNumber: text('quote_number').notNull(),
  version: integer('version').notNull().default(1),
  status: quoteStatusEnum('status').notNull().default('draft'),
  quoteDate: date('quote_date').notNull(),
  validUntil: date('valid_until').notNull(),

  // Scope inputs are retained so a quote can be explained and regenerated.
  areaSqftMilli: qty('area_sqft_milli'),
  washroomCount: integer('washroom_count'),
  kitchenCount: integer('kitchen_count'),
  bedroomCount: integer('bedroom_count'),

  subtotalCents: cents('subtotal_cents').notNull().default(0),
  taxTotalCents: cents('tax_total_cents').notNull().default(0),
  totalCents: cents('total_cents').notNull().default(0),
  totalCostCents: cents('total_cost_cents').notNull().default(0),
  marginBp: integer('margin_bp').notNull().default(0),

  terms: text('terms'),
  notes: text('notes'),
  internalNotes: text('internal_notes'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  declinedAt: timestamp('declined_at', { withTimezone: true }),
  pdfPath: text('pdf_path'),
  ...auditColumns,
}, (t) => ({
  versionUnique: uniqueIndex('quotes_project_version_unique').on(t.projectId, t.version),
  numberIdx: index('quotes_number_idx').on(t.quoteNumber),
}));

/**
 * A quote line is an immutable financial record.
 *
 * Code, description, unit type, and both rates are copies taken at line
 * creation. There is deliberately no rateItemId: if lines resolved live rates,
 * raising a rate would silently rewrite the value of every historical quote,
 * including ones already accepted by a customer.
 */
export const quoteLines = pgTable('quote_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id),
  sortOrder: integer('sort_order').notNull(),
  lineGroup: text('line_group').notNull(),
  code: text('code').notNull(),
  description: text('description').notNull(),
  calcMode: calcModeEnum('calc_mode').notNull(),
  unitLabel: text('unit_label').notNull(),
  qtyMilli: qty('qty_milli').notNull(),
  unitCostTenThou: rate('unit_cost_ten_thou').notNull(),
  unitPriceTenThou: rate('unit_price_ten_thou').notNull(),
  lineCostCents: cents('line_cost_cents').notNull(),
  lineTotalCents: cents('line_total_cents').notNull(),
  isTaxable: boolean('is_taxable').notNull().default(true),
  isOptional: boolean('is_optional').notNull().default(false),
  isIncluded: boolean('is_included').notNull().default(true),
  notes: text('notes'),
  ...auditColumns,
}, (t) => ({
  quoteIdx: index('quote_lines_quote_idx').on(t.quoteId, t.sortOrder),
}));

/** Snapshotted tax breakdown. Changing a rate must never alter an issued quote. */
export const quoteTaxes = pgTable('quote_taxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id),
  label: text('label').notNull(),
  registrationNumber: text('registration_number'),
  rateTenThou: rate('rate_ten_thou').notNull(),
  taxableBaseCents: cents('taxable_base_cents').notNull(),
  taxAmountCents: cents('tax_amount_cents').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns,
}, (t) => ({
  quoteIdx: index('quote_taxes_quote_idx').on(t.quoteId, t.sortOrder),
}));

/** Polymorphic attachment table. Local disk is authoritative; SharePoint mirrors. */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: entityTypeEnum('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storagePath: text('storage_path').notNull(),
  spDriveItemId: text('sp_drive_item_id'),
  spWebUrl: text('sp_web_url'),
  spSyncedAt: timestamp('sp_synced_at', { withTimezone: true }),
  uploadedBy: uuid('uploaded_by'),
  ...auditColumns,
}, (t) => ({
  entityIdx: index('files_entity_idx').on(t.entityType, t.entityId),
}));

/** Local sync bookkeeping. Not mirrored to SharePoint, so it carries no audit columns. */
export const syncState = pgTable('sync_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  listName: text('list_name').notNull(),
  watermark: timestamp('watermark', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  rowsSynced: integer('rows_synced').notNull().default(0),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
}, (t) => ({
  listUnique: uniqueIndex('sync_state_list_unique').on(t.listName),
}));

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tableName: text('table_name').notNull(),
  recordId: uuid('record_id').notNull(),
  action: text('action').notNull(),
  changedBy: uuid('changed_by'),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  diff: jsonb('diff'),
}, (t) => ({
  recordIdx: index('audit_log_record_idx').on(t.tableName, t.recordId),
}));
```

- [ ] **Step 4: Export, push, and run**

Add `export * from '@/db/schema/quotes';` to `src/db/schema/index.ts`.

Run: `npm run db:push && npx vitest run tests/db/quotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema tests/db/quotes.test.ts drizzle
git commit -m "feat: add quote, line, tax, file, sync state, and audit log schema"
```

---

### Task 9: `updated_at` trigger and the no-DELETE grant

The sync watermark is only correct if `updated_at` always moves. Application code cannot be trusted to remember, so the database does it.

**Files:**
- Create: `drizzle/0001_touch_and_grants.sql`
- Create: `scripts/apply-sql.ts`
- Modify: `package.json` — add `db:sql` script
- Test: `tests/db/triggers.test.ts`

**Interfaces:**
- Consumes: the pushed schema
- Produces: `touch_updated_at()` trigger on every audited table; role `quote_app` without `DELETE`

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/triggers.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { customers } from '@/db/schema';

beforeEach(async () => {
  await db.execute(sql`truncate table projects, customers restart identity cascade`);
});

describe('updated_at trigger', () => {
  it('advances updated_at on every update without the application setting it', async () => {
    const [row] = await db.insert(customers)
      .values({ name: 'Eleanor Vance', customerType: 'residential' }).returning();
    const before = row.updatedAt.getTime();

    await db.execute(sql`select pg_sleep(0.01)`);
    await db.update(customers).set({ name: 'Eleanor V.' }).where(eq(customers.id, row.id));

    const [after] = await db.select().from(customers).where(eq(customers.id, row.id));
    expect(after.updatedAt.getTime()).toBeGreaterThan(before);
  });
});

describe('no-delete grant', () => {
  it('refuses a DELETE issued as the application role', async () => {
    await db.insert(customers).values({ name: 'Eleanor Vance', customerType: 'residential' });

    // SET LOCAL is scoped to a transaction. Outside one it is a no-op, so the
    // DELETE would run as the connection's own (superuser) role -- the test
    // would either fail for the wrong reason or actually empty the table while
    // appearing to prove that deletion is impossible.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role quote_app`);
        await tx.execute(sql`delete from customers`);
      }),
    ).rejects.toThrow(/permission denied/i);

    const rows = await db.select().from(customers);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/db/triggers.test.ts`
Expected: FAIL — `updated_at` does not advance; the role does not exist.

- [ ] **Step 3: Write `drizzle/0001_touch_and_grants.sql`**

```sql
-- updated_at drives the SharePoint sync watermark. A row updated without it
-- moving would never sync again, so the database maintains it rather than
-- trusting every future code path to remember.
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare t text;
begin
  foreach t in array array[
    'organization','feature_flags','tax_rates','users','customers','projects',
    'rate_cards','rate_items','scope_templates','scope_template_items',
    'quotes','quote_lines','quote_taxes','files'
  ] loop
    execute format('drop trigger if exists touch_%1$s on %1$I', t);
    execute format(
      'create trigger touch_%1$s before update on %1$I
       for each row execute function touch_updated_at()', t);
  end loop;
end $$;

-- Nothing is ever deleted (spec section 4). Withholding the privilege turns an
-- accidental delete into a permission error instead of a destroyed tax record.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'quote_app') then
    create role quote_app;
  end if;
end $$;

grant usage on schema public to quote_app;
grant select, insert, update on all tables in schema public to quote_app;
revoke delete, truncate on all tables in schema public from quote_app;
grant usage, select on all sequences in schema public to quote_app;

alter default privileges in schema public
  grant select, insert, update on tables to quote_app;
alter default privileges in schema public
  revoke delete on tables from quote_app;
```

- [ ] **Step 4: Write `scripts/apply-sql.ts` and add the script**

```ts
// scripts/apply-sql.ts
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const file = process.argv[2];
if (!file) throw new Error('usage: db:sql <path-to-sql>');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const sql = postgres(url, { max: 1 });
const text = await readFile(file, 'utf8');
await sql.unsafe(text);
await sql.end();
console.log(`applied ${file}`);
```

Add to `package.json` scripts:

```json
"db:sql": "node --experimental-strip-types scripts/apply-sql.ts"
```

- [ ] **Step 5: Apply and run the test**

Run: `npm run db:sql drizzle/0001_touch_and_grants.sql && npx vitest run tests/db/triggers.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add drizzle/0001_touch_and_grants.sql scripts/apply-sql.ts package.json tests/db/triggers.test.ts
git commit -m "feat: maintain updated_at by trigger and withhold DELETE from the app role"
```

---

### Task 10: Line calculation for sqft, each, flat, and hour

The engine is pure. It takes plain data and returns plain data, reads nothing, and writes nothing.

**Files:**
- Create: `src/lib/quote/types.ts`
- Create: `src/lib/quote/lines.ts`
- Test: `tests/unit/lines.test.ts`

**Interfaces:**
- Consumes: `lineTotalCents` from `@/lib/money/scale`
- Produces:
  - `type CalcMode = 'qty' | 'flat' | 'percent'`
  - `interface LineInput { code, description, calcMode, qtyMilli, unitCostTenThou, unitPriceTenThou, isTaxable, isOptional, isIncluded, lineGroup, sortOrder }`
  - `interface ComputedLine extends LineInput { lineCostCents: number; lineTotalCents: number }`
  - `computeLine(line: LineInput): ComputedLine`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lines.test.ts
import { describe, expect, it } from 'vitest';
import { computeLine } from '@/lib/quote/lines';
import type { LineInput } from '@/lib/quote/types';

function line(overrides: Partial<LineInput> = {}): LineInput {
  return {
    code: 'DEM-01',
    description: 'Strip existing',
    lineGroup: 'Demolition',
    sortOrder: 1,
    calcMode: 'qty',
    unitLabel: 'sqft',
    qtyMilli: 1240500n,
    unitCostTenThou: 28000n,
    unitPriceTenThou: 40000n,
    isTaxable: true,
    isOptional: false,
    isIncluded: true,
    ...overrides,
  };
}

describe('computeLine', () => {
  it('multiplies quantity by rate for a sqft line', () => {
    const result = computeLine(line());
    expect(result.lineTotalCents).toBe(496200);
    expect(result.lineCostCents).toBe(347340);
  });

  it('multiplies count by rate for an each line', () => {
    const result = computeLine(line({
      calcMode: 'qty', unitLabel: 'ea', qtyMilli: 2000n,
      unitCostTenThou: 5000000n, unitPriceTenThou: 7200000n,
    }));
    expect(result.lineTotalCents).toBe(144000);
  });

  it('ignores quantity for a flat line and charges the rate once', () => {
    const result = computeLine(line({
      calcMode: 'flat', unitLabel: '', qtyMilli: 9999n,
      unitCostTenThou: 30000000n, unitPriceTenThou: 35000000n,
    }));
    expect(result.lineTotalCents).toBe(350000);
    expect(result.lineCostCents).toBe(300000);
  });

  it('multiplies hours by rate for an hour line', () => {
    const result = computeLine(line({
      calcMode: 'qty', unitLabel: 'hr', qtyMilli: 7500n,
      unitCostTenThou: 650000n, unitPriceTenThou: 950000n,
    }));
    expect(result.lineTotalCents).toBe(71250);
  });

  it('computes a percent line as zero here, since it needs the subtotal', () => {
    const result = computeLine(line({ calcMode: 'percent', unitLabel: '%', unitPriceTenThou: 1000n }));
    expect(result.lineTotalCents).toBe(0);
    expect(result.lineCostCents).toBe(0);
  });

  it('still computes a total for an excluded line so it can be shown as an upgrade', () => {
    const result = computeLine(line({ isOptional: true, isIncluded: false }));
    expect(result.lineTotalCents).toBe(496200);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/lines.test.ts`
Expected: FAIL — cannot resolve `@/lib/quote/lines`.

- [ ] **Step 3: Write `src/lib/quote/types.ts`**

```ts
/** How a line computes. Deliberately separate from its unit label. */
export type CalcMode = 'qty' | 'flat' | 'percent';

export interface LineInput {
  code: string;
  description: string;
  lineGroup: string;
  sortOrder: number;
  calcMode: CalcMode;
  /** Display only: 'sqft', 'lnft', 'ea', 'hr', 'm2'. Never affects arithmetic. */
  unitLabel: string;
  /** Integer thousandths. Ignored when calcMode is 'flat' or 'percent'. */
  qtyMilli: bigint;
  /**
   * Integer ten-thousandths. For 'percent', this IS the percentage.
   * May be negative: discounts and deductive change orders.
   */
  unitCostTenThou: bigint;
  unitPriceTenThou: bigint;
  isTaxable: boolean;
  isOptional: boolean;
  isIncluded: boolean;
  /** A customer-spendable placeholder, reconciled against actual cost later. Passthrough only. */
  isAllowance: boolean;
  /** Provenance, never read for pricing. Nullable for ad-hoc lines. */
  rateItemId: string | null;
  costCodeId: string | null;
}

export interface ComputedLine extends LineInput {
  lineCostCents: number;
  lineTotalCents: number;
  /**
   * For an EXCLUDED optional line: what accepting it actually adds to the
   * quote -- its own total plus every included percent rate applied to it.
   * Equal to lineTotalCents for included lines.
   *
   * Percent lines apply only to included lines, so a $500 upgrade under 10%
   * overhead and 15% profit raises the total by $625. Printing the raw line
   * total would quote one price and invoice another.
   */
  displayPriceCents: number;
}
```

- [ ] **Step 4: Write `src/lib/quote/lines.ts`**

```ts
import { QTY_SCALE, lineTotalCents } from '@/lib/money/scale';
import type { ComputedLine, LineInput } from '@/lib/quote/types';

/**
 * Computes one line's cost and price.
 *
 * `flat` charges the rate once regardless of the quantity recorded against it,
 * so a stray quantity cannot silently multiply a permit fee.
 *
 * `percent` returns zero here by design: its value depends on the subtotal of
 * every other included line, which this function cannot see. Percent lines are
 * resolved in `applyPercentLines` (Task 11) after the base is known. Returning
 * zero rather than throwing keeps this function total, so a caller can compute
 * a mixed list in one pass.
 */
export function computeLine(line: LineInput): ComputedLine {
  if (line.calcMode === 'percent') {
    return { ...line, lineCostCents: 0, lineTotalCents: 0 };
  }

  const effectiveQty = line.calcMode === 'flat' ? QTY_SCALE : line.qtyMilli;

  return {
    ...line,
    lineCostCents: Number(lineTotalCents(effectiveQty, line.unitCostTenThou)),
    lineTotalCents: Number(lineTotalCents(effectiveQty, line.unitPriceTenThou)),
  };
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run tests/unit/lines.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/quote/types.ts src/lib/quote/lines.ts tests/unit/lines.test.ts
git commit -m "feat: compute sqft, each, flat, and hour quote lines"
```

---

### Task 11: Percent lines

**Files:**
- Create: `src/lib/quote/percent.ts`
- Test: `tests/unit/percent.test.ts`

**Interfaces:**
- Consumes: `applyPercentCents`; `ComputedLine`, `LineInput` from `@/lib/quote/types`; `computeLine`
- Produces: `applyPercentLines(lines: LineInput[]): ComputedLine[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/percent.test.ts
import { describe, expect, it } from 'vitest';
import { applyPercentLines } from '@/lib/quote/percent';
import type { LineInput } from '@/lib/quote/types';

function base(overrides: Partial<LineInput> = {}): LineInput {
  return {
    code: 'X', description: 'X', lineGroup: 'G', sortOrder: 1,
    calcMode: 'flat', unitLabel: '', qtyMilli: 1000n,
    unitCostTenThou: 0n, unitPriceTenThou: 0n,
    isTaxable: true, isOptional: false, isIncluded: true,
    ...overrides,
  };
}

describe('applyPercentLines', () => {
  it('computes a percent line against the included non-percent subtotal', () => {
    const result = applyPercentLines([
      base({ code: 'A', unitPriceTenThou: 10000000n, unitCostTenThou: 8000000n }), // $1000 / $800
      base({ code: 'OH', calcMode: 'percent', unitLabel: '%', sortOrder: 2, unitPriceTenThou: 1000n }), // 10%
    ]);
    expect(result[1].lineTotalCents).toBe(10000); // 10% of $1000.00
  });

  it('applies cost percentage against the cost subtotal, not the price subtotal', () => {
    const result = applyPercentLines([
      base({ code: 'A', unitPriceTenThou: 10000000n, unitCostTenThou: 8000000n }),
      base({
        code: 'OH', calcMode: 'percent', unitLabel: '%', sortOrder: 2,
        unitPriceTenThou: 1000n, unitCostTenThou: 1000n,
      }),
    ]);
    expect(result[1].lineTotalCents).toBe(10000); // 10% of $1000.00
    expect(result[1].lineCostCents).toBe(8000);   // 10% of $800.00
  });

  it('excludes optional lines that are not included from the base', () => {
    const result = applyPercentLines([
      base({ code: 'A', unitPriceTenThou: 10000000n }),
      base({ code: 'OPT', sortOrder: 2, unitPriceTenThou: 5000000n, isOptional: true, isIncluded: false }),
      base({ code: 'OH', calcMode: 'percent', unitLabel: '%', sortOrder: 3, unitPriceTenThou: 1000n }),
    ]);
    expect(result[2].lineTotalCents).toBe(10000); // 10% of $1000, not $1500
  });

  it('does not compound one percent line onto another', () => {
    const result = applyPercentLines([
      base({ code: 'A', unitPriceTenThou: 10000000n }),
      base({ code: 'OH', calcMode: 'percent', unitLabel: '%', sortOrder: 2, unitPriceTenThou: 1000n }),
      base({ code: 'PR', calcMode: 'percent', unitLabel: '%', sortOrder: 3, unitPriceTenThou: 1500n }),
    ]);
    expect(result[1].lineTotalCents).toBe(10000); // 10% of $1000
    expect(result[2].lineTotalCents).toBe(15000); // 15% of $1000, not of $1100
  });

  it('preserves input order', () => {
    const result = applyPercentLines([
      base({ code: 'OH', calcMode: 'percent', unitLabel: '%', sortOrder: 1, unitPriceTenThou: 1000n }),
      base({ code: 'A', sortOrder: 2, unitPriceTenThou: 10000000n }),
    ]);
    expect(result.map((l) => l.code)).toEqual(['OH', 'A']);
    expect(result[0].lineTotalCents).toBe(10000);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/percent.test.ts`
Expected: FAIL — cannot resolve `@/lib/quote/percent`.

- [ ] **Step 3: Write `src/lib/quote/percent.ts`**

```ts
import { applyPercentCents } from '@/lib/money/scale';
import { computeLine } from '@/lib/quote/lines';
import type { ComputedLine, LineInput } from '@/lib/quote/types';

/**
 * Resolves percent lines against the subtotal of every other included line.
 *
 * Overhead, profit, and contingency are line items rather than margin hidden
 * inside unit rates. That is what makes margin honest -- the owner can see what
 * he is charging for them, and so can he when he reads the quote back a year
 * later.
 *
 * Percent lines never compound onto each other: a 10% overhead and a 15% profit
 * both apply to the same base. Compounding is a tax concern (Task 12), not a
 * quote-structure one, and applying it here would make the result depend on
 * line order.
 */
export function applyPercentLines(lines: LineInput[]): ComputedLine[] {
  const computed = lines.map(computeLine);

  const baseCents = computed.reduce(
    (total, line) =>
      line.calcMode !== 'percent' && line.isIncluded ? total + line.lineTotalCents : total,
    0,
  );
  const baseCostCents = computed.reduce(
    (total, line) =>
      line.calcMode !== 'percent' && line.isIncluded ? total + line.lineCostCents : total,
    0,
  );

  return computed.map((line) => {
    if (line.calcMode !== 'percent') return line;
    return {
      ...line,
      lineTotalCents: Number(applyPercentCents(BigInt(baseCents), line.unitPriceTenThou)),
      lineCostCents: Number(applyPercentCents(BigInt(baseCostCents), line.unitCostTenThou)),
    };
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/percent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote/percent.ts tests/unit/percent.test.ts
git commit -m "feat: resolve percent lines against the included subtotal"
```

---

### Task 12: Tax engine

The most jurisdiction-sensitive code in the system, and the only place a customer's own arithmetic can visibly disagree with the document.

**Files:**
- Create: `src/lib/quote/tax.ts`
- Test: `tests/unit/tax.test.ts`

**Interfaces:**
- Consumes: `applyPercentCents`; `ComputedLine`
- Produces:
  - `interface TaxRateInput { label, registrationNumber, rateTenThou, effectiveFrom, effectiveTo, isCompound, sortOrder }`
  - `interface ComputedTax { label, registrationNumber, rateTenThou, taxableBaseCents, taxAmountCents, sortOrder }`
  - `selectRatesInForce(rates: TaxRateInput[], onDate: string): TaxRateInput[]`
  - `computeTaxes(lines: ComputedLine[], rates: TaxRateInput[], opts: { onDate: string; customerExempt: boolean }): ComputedTax[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/tax.test.ts
import { describe, expect, it } from 'vitest';
import { computeTaxes, selectRatesInForce } from '@/lib/quote/tax';
import type { TaxRateInput } from '@/lib/quote/tax';
import type { ComputedLine } from '@/lib/quote/types';

function rate(overrides: Partial<TaxRateInput> = {}): TaxRateInput {
  return {
    label: 'HST', registrationNumber: '80000 0000 RT0001',
    rateTenThou: 1300n, effectiveFrom: '2010-07-01', effectiveTo: null,
    isCompound: false, sortOrder: 1,
    ...overrides,
  };
}

function line(totalCents: number, isTaxable = true, isIncluded = true): ComputedLine {
  return {
    code: 'X', description: 'X', lineGroup: 'G', sortOrder: 1, calcMode: 'flat', unitLabel: '',
    qtyMilli: 1000n, unitCostTenThou: 0n, unitPriceTenThou: 0n,
    isTaxable, isOptional: false, isIncluded,
    lineCostCents: 0, lineTotalCents: totalCents,
  };
}

describe('selectRatesInForce', () => {
  it('picks the rate whose window contains the date', () => {
    const rates = [
      rate({ label: 'HST', rateTenThou: 1500n, effectiveFrom: '2010-07-01', effectiveTo: '2025-03-31' }),
      rate({ label: 'HST', rateTenThou: 1400n, effectiveFrom: '2025-04-01', effectiveTo: null }),
    ];
    expect(selectRatesInForce(rates, '2025-03-15')[0].rateTenThou).toBe(1500n);
    expect(selectRatesInForce(rates, '2025-04-01')[0].rateTenThou).toBe(1400n);
  });

  it('excludes a rate that has not started', () => {
    const rates = [rate({ effectiveFrom: '2027-01-01' })];
    expect(selectRatesInForce(rates, '2026-09-01')).toEqual([]);
  });
});

describe('computeTaxes', () => {
  it('computes a single rate on the summed taxable base', () => {
    const taxes = computeTaxes([line(8430000)], [rate()], {
      onDate: '2026-09-01', customerExempt: false,
    });
    expect(taxes).toHaveLength(1);
    expect(taxes[0].taxableBaseCents).toBe(8430000);
    expect(taxes[0].taxAmountCents).toBe(1095900);
  });

  it('rounds once on the total, not per line', () => {
    // Three lines of $0.05. Per line, 13% rounds to 1 cent each = 3 cents.
    // On the summed base of $0.15, 13% is 1.95 cents -> 2 cents.
    const taxes = computeTaxes([line(5), line(5), line(5)], [rate()], {
      onDate: '2026-09-01', customerExempt: false,
    });
    expect(taxes[0].taxAmountCents).toBe(2);
  });

  it('computes two independent rates for a GST plus PST jurisdiction', () => {
    const taxes = computeTaxes([line(100000)], [
      rate({ label: 'GST', rateTenThou: 500n, sortOrder: 1 }),
      rate({ label: 'PST', rateTenThou: 700n, sortOrder: 2 }),
    ], { onDate: '2026-09-01', customerExempt: false });
    expect(taxes.map((t) => t.taxAmountCents)).toEqual([5000, 7000]);
  });

  it('applies a compound rate on the base plus prior taxes', () => {
    const taxes = computeTaxes([line(100000)], [
      rate({ label: 'GST', rateTenThou: 500n, sortOrder: 1 }),
      rate({ label: 'PST', rateTenThou: 1000n, sortOrder: 2, isCompound: true }),
    ], { onDate: '2026-09-01', customerExempt: false });
    expect(taxes[0].taxAmountCents).toBe(5000);          // 5% of $1000
    expect(taxes[1].taxableBaseCents).toBe(105000);      // $1000 + $50
    expect(taxes[1].taxAmountCents).toBe(10500);         // 10% of $1050
  });

  it('excludes non-taxable lines from the base', () => {
    const taxes = computeTaxes([line(100000), line(35000, false)], [rate()], {
      onDate: '2026-09-01', customerExempt: false,
    });
    expect(taxes[0].taxableBaseCents).toBe(100000);
  });

  it('excludes optional lines that are not included', () => {
    const taxes = computeTaxes([line(100000), line(50000, true, false)], [rate()], {
      onDate: '2026-09-01', customerExempt: false,
    });
    expect(taxes[0].taxableBaseCents).toBe(100000);
  });

  it('returns no tax lines at all for an exempt customer', () => {
    const taxes = computeTaxes([line(100000)], [rate()], {
      onDate: '2026-09-01', customerExempt: true,
    });
    expect(taxes).toEqual([]);
  });

  it('orders output by sortOrder so compound rates follow their base', () => {
    const taxes = computeTaxes([line(100000)], [
      rate({ label: 'PST', rateTenThou: 700n, sortOrder: 2 }),
      rate({ label: 'GST', rateTenThou: 500n, sortOrder: 1 }),
    ], { onDate: '2026-09-01', customerExempt: false });
    expect(taxes.map((t) => t.label)).toEqual(['GST', 'PST']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/tax.test.ts`
Expected: FAIL — cannot resolve `@/lib/quote/tax`.

- [ ] **Step 3: Write `src/lib/quote/tax.ts`**

```ts
import { applyPercentCents } from '@/lib/money/scale';
import type { ComputedLine } from '@/lib/quote/types';

export interface TaxRateInput {
  label: string;
  registrationNumber: string | null;
  /** Integer ten-thousandths: 13% is 1300n. */
  rateTenThou: bigint;
  /** ISO date, inclusive. */
  effectiveFrom: string;
  /** ISO date, inclusive. Null means still in force. */
  effectiveTo: string | null;
  /** Applies on the base plus previously applied taxes. */
  isCompound: boolean;
  sortOrder: number;
}

export interface ComputedTax {
  label: string;
  registrationNumber: string | null;
  rateTenThou: bigint;
  taxableBaseCents: number;
  taxAmountCents: number;
  sortOrder: number;
}

/**
 * The rates in force on a given date.
 *
 * Effective dating answers which rate a new or back-dated quote picks up, and
 * survives a rate change such as Nova Scotia's 15% to 14% on 2025-04-01. It
 * works alongside the per-quote snapshot, which protects quotes already issued;
 * neither alone is sufficient.
 */
export function selectRatesInForce(rates: TaxRateInput[], onDate: string): TaxRateInput[] {
  return rates
    .filter((r) => r.effectiveFrom <= onDate && (r.effectiveTo === null || r.effectiveTo >= onDate))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Computes the tax breakdown for a set of computed lines.
 *
 * Tax is calculated on the summed taxable base and rounded once. Rounding each
 * line separately drifts by a cent or two across a forty-line quote, and then
 * the customer's own arithmetic disagrees with the document in front of them.
 */
export function computeTaxes(
  lines: ComputedLine[],
  rates: TaxRateInput[],
  opts: { onDate: string; customerExempt: boolean },
): ComputedTax[] {
  if (opts.customerExempt) return [];

  const baseCents = lines.reduce(
    (total, line) => (line.isIncluded && line.isTaxable ? total + line.lineTotalCents : total),
    0,
  );

  let accumulatedTaxCents = 0;

  return selectRatesInForce(rates, opts.onDate).map((rate) => {
    const taxableBaseCents = rate.isCompound ? baseCents + accumulatedTaxCents : baseCents;
    const taxAmountCents = Number(applyPercentCents(BigInt(taxableBaseCents), rate.rateTenThou));
    accumulatedTaxCents += taxAmountCents;
    return {
      label: rate.label,
      registrationNumber: rate.registrationNumber,
      rateTenThou: rate.rateTenThou,
      taxableBaseCents,
      taxAmountCents,
      sortOrder: rate.sortOrder,
    };
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/tax.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote/tax.ts tests/unit/tax.test.ts
git commit -m "feat: add tax engine with effective dating, compounding, and exemptions"
```

---

### Task 13: Quote totals assembly

**Files:**
- Create: `src/lib/quote/totals.ts`
- Test: `tests/unit/totals.test.ts`

**Interfaces:**
- Consumes: `applyPercentLines`, `computeTaxes`, `marginBasisPoints`
- Produces:
  - `interface QuoteTotals { lines, taxes, subtotalCents, taxTotalCents, totalCents, totalCostCents, marginBp, optionalTotalCents }`
  - `computeQuote(lines: LineInput[], rates: TaxRateInput[], opts: { onDate: string; customerExempt: boolean }): QuoteTotals`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/totals.test.ts
import { describe, expect, it } from 'vitest';
import { computeQuote } from '@/lib/quote/totals';
import type { TaxRateInput } from '@/lib/quote/tax';
import type { LineInput } from '@/lib/quote/types';

const hst: TaxRateInput = {
  label: 'HST', registrationNumber: null, rateTenThou: 1300n,
  effectiveFrom: '2010-07-01', effectiveTo: null, isCompound: false, sortOrder: 1,
};

function line(overrides: Partial<LineInput> = {}): LineInput {
  return {
    code: 'X', description: 'X', lineGroup: 'G', sortOrder: 1, calcMode: 'flat', unitLabel: '',
    qtyMilli: 1000n, unitCostTenThou: 0n, unitPriceTenThou: 0n,
    isTaxable: true, isOptional: false, isIncluded: true,
    ...overrides,
  };
}

describe('computeQuote', () => {
  it('assembles subtotal, tax, and total', () => {
    const result = computeQuote(
      [line({ unitPriceTenThou: 10000000n, unitCostTenThou: 7500000n })],
      [hst],
      { onDate: '2026-09-01', customerExempt: false },
    );
    expect(result.subtotalCents).toBe(100000);
    expect(result.taxTotalCents).toBe(13000);
    expect(result.totalCents).toBe(113000);
    expect(result.totalCostCents).toBe(75000);
    expect(result.marginBp).toBe(2500);
  });

  it('keeps optional lines out of the subtotal and reports them separately', () => {
    const result = computeQuote([
      line({ unitPriceTenThou: 10000000n }),
      line({ code: 'OPT', sortOrder: 2, unitPriceTenThou: 4200000n, isOptional: true, isIncluded: false }),
    ], [hst], { onDate: '2026-09-01', customerExempt: false });
    expect(result.subtotalCents).toBe(100000);
    expect(result.optionalTotalCents).toBe(42000);
  });

  it('includes percent lines in the subtotal', () => {
    const result = computeQuote([
      line({ unitPriceTenThou: 10000000n, unitCostTenThou: 8000000n }),
      line({ code: 'OH', sortOrder: 2, calcMode: 'percent', unitLabel: '%', unitPriceTenThou: 1000n, unitCostTenThou: 0n }),
    ], [hst], { onDate: '2026-09-01', customerExempt: false });
    expect(result.subtotalCents).toBe(110000);
    expect(result.totalCostCents).toBe(80000);
  });

  it('produces a total equal to subtotal when the customer is exempt', () => {
    const result = computeQuote([line({ unitPriceTenThou: 10000000n })], [hst], {
      onDate: '2026-09-01', customerExempt: true,
    });
    expect(result.taxes).toEqual([]);
    expect(result.totalCents).toBe(result.subtotalCents);
  });

  it('reports a negative margin when cost exceeds price', () => {
    const result = computeQuote(
      [line({ unitPriceTenThou: 10000000n, unitCostTenThou: 12000000n })],
      [hst], { onDate: '2026-09-01', customerExempt: false },
    );
    expect(result.marginBp).toBe(-2000);
  });

  it('returns zeroes for an empty quote without dividing by zero', () => {
    const result = computeQuote([], [hst], { onDate: '2026-09-01', customerExempt: false });
    expect(result.subtotalCents).toBe(0);
    expect(result.totalCents).toBe(0);
    expect(result.marginBp).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/totals.test.ts`
Expected: FAIL — cannot resolve `@/lib/quote/totals`.

- [ ] **Step 3: Write `src/lib/quote/totals.ts`**

```ts
import { marginBasisPoints } from '@/lib/money/scale';
import { applyPercentLines } from '@/lib/quote/percent';
import { computeTaxes, type ComputedTax, type TaxRateInput } from '@/lib/quote/tax';
import type { ComputedLine, LineInput } from '@/lib/quote/types';

export interface QuoteTotals {
  lines: ComputedLine[];
  taxes: ComputedTax[];
  subtotalCents: number;
  taxTotalCents: number;
  totalCents: number;
  totalCostCents: number;
  marginBp: number;
  /** Sum of optional lines that are excluded; printed as available upgrades. */
  optionalTotalCents: number;
}

/**
 * The single entry point for pricing a quote.
 *
 * Pure: it reads nothing and writes nothing, so it is cheap to test
 * exhaustively and cannot become order-dependent on database state. Callers
 * persist the result; they never recompute a total from a stored quote's lines
 * using current rates.
 */
export function computeQuote(
  lines: LineInput[],
  rates: TaxRateInput[],
  opts: { onDate: string; customerExempt: boolean },
): QuoteTotals {
  const computed = applyPercentLines(lines);

  const included = computed.filter((l) => l.isIncluded);
  const subtotalCents = included.reduce((t, l) => t + l.lineTotalCents, 0);
  const totalCostCents = included.reduce((t, l) => t + l.lineCostCents, 0);
  const optionalTotalCents = computed
    .filter((l) => !l.isIncluded)
    .reduce((t, l) => t + l.lineTotalCents, 0);

  const taxes = computeTaxes(computed, rates, opts);
  const taxTotalCents = taxes.reduce((t, tax) => t + tax.taxAmountCents, 0);

  return {
    lines: computed,
    taxes,
    subtotalCents,
    taxTotalCents,
    totalCents: subtotalCents + taxTotalCents,
    totalCostCents,
    marginBp: marginBasisPoints(BigInt(subtotalCents), BigInt(totalCostCents)),
    optionalTotalCents,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/totals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote/totals.ts tests/unit/totals.test.ts
git commit -m "feat: assemble quote subtotal, tax, total, cost, and margin"
```

---

### Task 14: Scope template expansion

**Files:**
- Create: `src/lib/quote/template.ts`
- Test: `tests/unit/template.test.ts`

**Interfaces:**
- Consumes: `QTY_SCALE`, `RATE_SCALE`, `divRoundHalfUp`; `LineInput`
- Produces:
  - `type QtySource = 'area' | 'washrooms' | 'kitchens' | 'bedrooms' | 'fixed' | 'manual'`
  - `interface ScopeInputs { areaSqftMilli, washroomCount, kitchenCount, bedroomCount }`
  - `interface TemplateItem { code, description, lineGroup, sortOrder, calcMode, qtySource, qtyMultiplierTenThou, fixedQtyMilli, costRateTenThou, sellRateTenThou, isTaxable, isOptional }`
  - `expandTemplate(items: TemplateItem[], inputs: ScopeInputs): LineInput[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/template.test.ts
import { describe, expect, it } from 'vitest';
import { expandTemplate } from '@/lib/quote/template';
import type { ScopeInputs, TemplateItem } from '@/lib/quote/template';

const inputs: ScopeInputs = {
  areaSqftMilli: 1240500n, washroomCount: 1, kitchenCount: 0, bedroomCount: 2,
};

function item(overrides: Partial<TemplateItem> = {}): TemplateItem {
  return {
    code: 'DEM-01', description: 'Strip existing', lineGroup: 'Demolition', sortOrder: 1,
    calcMode: 'qty', unitLabel: 'sqft', qtySource: 'area', qtyMultiplierTenThou: 10000n, fixedQtyMilli: null,
    costRateTenThou: 28000n, sellRateTenThou: 40000n, isTaxable: true, isOptional: false,
    ...overrides,
  };
}

describe('expandTemplate', () => {
  it('takes the area straight through at a multiplier of one', () => {
    const [line] = expandTemplate([item()], inputs);
    expect(line.qtyMilli).toBe(1240500n);
  });

  it('scales the area by the multiplier', () => {
    // One pot light per 50 sqft is a multiplier of 0.02.
    const [line] = expandTemplate([item({ qtySource: 'area', qtyMultiplierTenThou: 200n })], inputs);
    expect(line.qtyMilli).toBe(24810n); // 1240.5 x 0.02 = 24.81
  });

  it('reads a room count as a whole quantity', () => {
    const [line] = expandTemplate([item({ qtySource: 'washrooms', calcMode: 'qty', unitLabel: 'ea' })], inputs);
    expect(line.qtyMilli).toBe(1000n);
  });

  it('uses the fixed quantity when the source is fixed', () => {
    const [line] = expandTemplate([
      item({ qtySource: 'fixed', fixedQtyMilli: 2000n, calcMode: 'qty', unitLabel: 'ea' }),
    ], inputs);
    expect(line.qtyMilli).toBe(2000n);
  });

  it('emits a manual line at zero for the owner to fill in', () => {
    const [line] = expandTemplate([item({ qtySource: 'manual', calcMode: 'qty', unitLabel: 'hr' })], inputs);
    expect(line.qtyMilli).toBe(0n);
  });

  it('drops a line whose derived quantity is zero, except manual ones', () => {
    const lines = expandTemplate([
      item({ code: 'KIT-01', qtySource: 'kitchens', calcMode: 'qty', unitLabel: 'ea' }),
      item({ code: 'TM-01', qtySource: 'manual', calcMode: 'qty', unitLabel: 'hr', sortOrder: 2 }),
    ], inputs);
    expect(lines.map((l) => l.code)).toEqual(['TM-01']);
  });

  it('marks optional template items as excluded so they price as upgrades', () => {
    const [line] = expandTemplate([item({ isOptional: true })], inputs);
    expect(line.isOptional).toBe(true);
    expect(line.isIncluded).toBe(false);
  });

  it('rounds a derived quantity half up to thousandths', () => {
    // 1240.5 x 0.0005 = 0.62025 -> 0.620
    const [line] = expandTemplate([item({ qtyMultiplierTenThou: 5n })], inputs);
    expect(line.qtyMilli).toBe(620n);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/unit/template.test.ts`
Expected: FAIL — cannot resolve `@/lib/quote/template`.

- [ ] **Step 3: Write `src/lib/quote/template.ts`**

```ts
import { QTY_SCALE, RATE_SCALE, divRoundHalfUp } from '@/lib/money/scale';
import type { CalcMode, LineInput } from '@/lib/quote/types';

export type QtySource = 'area' | 'washrooms' | 'kitchens' | 'bedrooms' | 'fixed' | 'manual';

export interface ScopeInputs {
  areaSqftMilli: bigint;
  washroomCount: number;
  kitchenCount: number;
  bedroomCount: number;
}

export interface TemplateItem {
  code: string;
  description: string;
  lineGroup: string;
  sortOrder: number;
  calcMode: CalcMode;
  unitLabel: string;
  qtySource: QtySource;
  qtyMultiplierTenThou: bigint;
  fixedQtyMilli: bigint | null;
  costRateTenThou: bigint;
  sellRateTenThou: bigint;
  isTaxable: boolean;
  isOptional: boolean;
}

function sourceQtyMilli(source: QtySource, inputs: ScopeInputs, fixed: bigint | null): bigint {
  switch (source) {
    case 'area':
      return inputs.areaSqftMilli;
    case 'washrooms':
      return BigInt(inputs.washroomCount) * QTY_SCALE;
    case 'kitchens':
      return BigInt(inputs.kitchenCount) * QTY_SCALE;
    case 'bedrooms':
      return BigInt(inputs.bedroomCount) * QTY_SCALE;
    case 'fixed':
      return fixed ?? 0n;
    case 'manual':
      return 0n;
  }
}

/**
 * Turns a scope template plus the owner's measurements into quote lines.
 *
 * This is the standardisation the product exists for: enter square footage and
 * room counts, get a consistent line set, then adjust. Quantity derives as
 * `source value x multiplier`, which covers every case described -- drywall is
 * area x 1, pot lights are area x 0.02, a washroom rough-in is washrooms x 1 --
 * without introducing a formula language.
 *
 * A line whose derived quantity is zero is dropped rather than emitted at zero:
 * a basement with no kitchen should not produce a kitchen line the owner must
 * delete. `manual` lines are the exception, since zero is their expected
 * starting value.
 */
export function expandTemplate(items: TemplateItem[], inputs: ScopeInputs): LineInput[] {
  return items
    .map((item) => {
      const source = sourceQtyMilli(item.qtySource, inputs, item.fixedQtyMilli);
      const qtyMilli =
        item.qtySource === 'manual'
          ? 0n
          : divRoundHalfUp(source * item.qtyMultiplierTenThou, RATE_SCALE);

      return {
        code: item.code,
        description: item.description,
        lineGroup: item.lineGroup,
        sortOrder: item.sortOrder,
        calcMode: item.calcMode,
        unitLabel: item.unitLabel,
        qtyMilli,
        unitCostTenThou: item.costRateTenThou,
        unitPriceTenThou: item.sellRateTenThou,
        isTaxable: item.isTaxable,
        isOptional: item.isOptional,
        isIncluded: !item.isOptional,
        _isManual: item.qtySource === 'manual',
      };
    })
    .filter((line) => line._isManual || line.qtyMilli !== 0n)
    .map(({ _isManual, ...line }) => line);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/unit/template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote/template.ts tests/unit/template.test.ts
git commit -m "feat: expand scope templates into quote lines from measurements"
```

---

### Task 15: Document number allocation under concurrency

Two quotes created in the same second must never receive the same number. A read-then-write on `organization.next_quote_seq` races; a row lock does not.

**Files:**
- Create: `src/lib/quote/numbering.ts`
- Test: `tests/integration/numbering.test.ts`

**Interfaces:**
- Consumes: `db`, `organization`
- Produces: `allocateQuoteNumber(tx: Transaction): Promise<string>`, `allocateProjectNumber(tx: Transaction): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/numbering.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { organization } from '@/db/schema';
import { allocateQuoteNumber } from '@/lib/quote/numbering';

beforeEach(async () => {
  await db.execute(sql`truncate table organization restart identity cascade`);
  await db.insert(organization).values({
    id: 1, legalName: 'Acme Ltd', displayName: 'Acme',
    quoteNumberPrefix: 'QT', nextQuoteSeq: 1,
  });
});

describe('allocateQuoteNumber', () => {
  it('formats the prefix, year, and a zero-padded sequence', async () => {
    const number = await db.transaction((tx) => allocateQuoteNumber(tx));
    expect(number).toMatch(/^QT-\d{4}-0001$/);
  });

  it('increments across sequential calls', async () => {
    const first = await db.transaction((tx) => allocateQuoteNumber(tx));
    const second = await db.transaction((tx) => allocateQuoteNumber(tx));
    expect(first).not.toBe(second);
    expect(second.endsWith('0002')).toBe(true);
  });

  it('issues twenty unique numbers under concurrent allocation', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => db.transaction((tx) => allocateQuoteNumber(tx))),
    );
    expect(new Set(numbers).size).toBe(20);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/integration/numbering.test.ts`
Expected: FAIL — cannot resolve `@/lib/quote/numbering`.

- [ ] **Step 3: Write `src/lib/quote/numbering.ts`**

```ts
import { eq, sql } from 'drizzle-orm';
import { organization } from '@/db/schema';
import type { db as Database } from '@/db/client';

type Tx = Parameters<Parameters<typeof Database.transaction>[0]>[0];

/**
 * Allocates the next number in a series.
 *
 * The UPDATE ... RETURNING takes a row lock for the transaction's duration, so
 * two concurrent callers serialise on it. A read-then-write would let both read
 * the same value and issue duplicate document numbers -- a defect a customer
 * notices, on paper, after the fact.
 *
 * Must be called inside the same transaction that inserts the record, so a
 * rolled-back quote does not burn a number.
 */
async function allocate(
  tx: Tx,
  column: 'nextQuoteSeq' | 'nextInvoiceSeq' | 'nextPoSeq',
  prefixColumn: 'quoteNumberPrefix' | 'invoiceNumberPrefix' | 'poNumberPrefix',
  fallbackPrefix: string,
): Promise<string> {
  const [row] = await tx
    .update(organization)
    .set({ [column]: sql`${organization[column]} + 1` })
    .where(eq(organization.id, 1))
    .returning({ seq: organization[column], prefix: organization[prefixColumn] });

  if (!row) throw new Error('organization row is missing; run setup first');

  const seq = row.seq - 1;
  const prefix = row.prefix ?? fallbackPrefix;
  const year = new Date().getUTCFullYear();
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

export function allocateQuoteNumber(tx: Tx): Promise<string> {
  return allocate(tx, 'nextQuoteSeq', 'quoteNumberPrefix', 'QT');
}

export function allocateProjectNumber(tx: Tx): Promise<string> {
  return allocate(tx, 'nextInvoiceSeq', 'invoiceNumberPrefix', 'P');
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/integration/numbering.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote/numbering.ts tests/integration/numbering.test.ts
git commit -m "feat: allocate document numbers under a row lock to avoid duplicates"
```

---

### Task 16: Quote creation, versioning, and voiding

**Files:**
- Create: `src/lib/quote/repository.ts`
- Test: `tests/integration/repository.test.ts`

**Interfaces:**
- Consumes: `db`, schema tables, `computeQuote`, `expandTemplate`, `allocateQuoteNumber`
- Produces:
  - `createQuoteFromTemplate(args): Promise<{ quoteId: string }>`
  - `reviseQuote(args): Promise<{ quoteId: string; version: number }>`
  - `voidQuote(args): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/repository.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  customers, organization, projects, quoteLines, quotes, quoteTaxes,
  rateCards, rateItems, scopeTemplateItems, scopeTemplates, taxRates,
} from '@/db/schema';
import { createQuoteFromTemplate, reviseQuote, voidQuote } from '@/lib/quote/repository';

let projectId: string;
let templateId: string;
let rateItemId: string;

beforeEach(async () => {
  await db.execute(sql`
    truncate table quote_taxes, quote_lines, quotes, scope_template_items, scope_templates,
    rate_items, rate_cards, tax_rates, projects, customers, organization
    restart identity cascade
  `);

  await db.insert(organization).values({
    id: 1, legalName: 'Acme Ltd', displayName: 'Acme',
    quoteNumberPrefix: 'QT', nextQuoteSeq: 1, quoteValidityDays: 30,
    taxRegistrationNumber: '80000 0000 RT0001',
  });
  await db.insert(taxRates).values({
    label: 'HST', registrationNumber: '80000 0000 RT0001',
    rateTenThou: 1300n, effectiveFrom: '2010-07-01', sortOrder: 1,
  });

  const [customer] = await db.insert(customers)
    .values({ name: 'Eleanor Vance', customerType: 'residential' }).returning();
  const [project] = await db.insert(projects).values({
    customerId: customer.id, projectNumber: 'P-0001', name: 'Basement finish',
    projectType: 'basement', stage: 'quoting',
  }).returning();
  projectId = project.id;

  const [card] = await db.insert(rateCards)
    .values({ name: 'Default', effectiveFrom: '2026-01-01', targetMarginBp: 2500 }).returning();
  const [item] = await db.insert(rateItems).values({
    rateCardId: card.id, code: 'DEM-01', description: 'Strip existing',
    category: 'Demolition', calcMode: 'qty', unitLabel: 'sqft',
    costRateTenThou: 28000n, sellRateTenThou: 40000n,
  }).returning();
  rateItemId = item.id;

  const [template] = await db.insert(scopeTemplates)
    .values({ name: 'Basement Finish', projectType: 'basement' }).returning();
  templateId = template.id;
  await db.insert(scopeTemplateItems).values({
    scopeTemplateId: template.id, rateItemId: item.id,
    qtySource: 'area', qtyMultiplierTenThou: 10000n, lineGroup: 'Demolition', sortOrder: 1,
  });
});

const scope = {
  areaSqftMilli: 1240500n, washroomCount: 1, kitchenCount: 0, bedroomCount: 2,
};

describe('createQuoteFromTemplate', () => {
  it('creates version 1 with lines, taxes, and stored totals', async () => {
    const { quoteId } = await createQuoteFromTemplate({
      projectId, scopeTemplateId: templateId, scope, quoteDate: '2026-09-01',
    });

    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote.version).toBe(1);
    expect(quote.status).toBe('draft');
    expect(quote.subtotalCents).toBe(496200);
    expect(quote.taxTotalCents).toBe(64506);
    expect(quote.totalCents).toBe(560706);

    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceTenThou).toBe(40000n);

    const taxes = await db.select().from(quoteTaxes).where(eq(quoteTaxes.quoteId, quoteId));
    expect(taxes[0].label).toBe('HST');
  });

  it('sets validUntil from the organization validity window', async () => {
    const { quoteId } = await createQuoteFromTemplate({
      projectId, scopeTemplateId: templateId, scope, quoteDate: '2026-09-01',
    });
    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote.validUntil).toBe('2026-10-01');
  });
});

describe('rate snapshotting', () => {
  it('leaves an existing quote untouched when the rate item changes', async () => {
    const { quoteId } = await createQuoteFromTemplate({
      projectId, scopeTemplateId: templateId, scope, quoteDate: '2026-09-01',
    });

    await db.update(rateItems).set({ sellRateTenThou: 90000n })
      .where(eq(rateItems.id, rateItemId));

    const lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    expect(lines[0].unitPriceTenThou).toBe(40000n);
    expect(lines[0].lineTotalCents).toBe(496200);

    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote.totalCents).toBe(560706);
  });
});

describe('reviseQuote', () => {
  it('creates version 2 and supersedes version 1 without altering its lines', async () => {
    const { quoteId } = await createQuoteFromTemplate({
      projectId, scopeTemplateId: templateId, scope, quoteDate: '2026-09-01',
    });
    const { quoteId: v2Id, version } = await reviseQuote({ quoteId });

    expect(version).toBe(2);

    const [v1] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(v1.status).toBe('superseded');

    const v1Lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, quoteId));
    const v2Lines = await db.select().from(quoteLines).where(eq(quoteLines.quoteId, v2Id));
    expect(v2Lines).toHaveLength(v1Lines.length);
    expect(v2Lines[0].id).not.toBe(v1Lines[0].id);
    expect(v2Lines[0].unitPriceTenThou).toBe(v1Lines[0].unitPriceTenThou);
  });

  it('keeps the same quote number across versions', async () => {
    const { quoteId } = await createQuoteFromTemplate({
      projectId, scopeTemplateId: templateId, scope, quoteDate: '2026-09-01',
    });
    const { quoteId: v2Id } = await reviseQuote({ quoteId });
    const [v1] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    const [v2] = await db.select().from(quotes).where(eq(quotes.id, v2Id));
    expect(v2.quoteNumber).toBe(v1.quoteNumber);
  });
});

describe('voidQuote', () => {
  it('marks the row void with a reason instead of deleting it', async () => {
    const { quoteId } = await createQuoteFromTemplate({
      projectId, scopeTemplateId: templateId, scope, quoteDate: '2026-09-01',
    });
    await voidQuote({ quoteId, reason: 'Duplicate entry' });

    const [quote] = await db.select().from(quotes).where(eq(quotes.id, quoteId));
    expect(quote.recordStatus).toBe('void');
    expect(quote.voidReason).toBe('Duplicate entry');
    expect(quote.voidedAt).not.toBeNull();
  });

  it('refuses to void without a reason', async () => {
    const { quoteId } = await createQuoteFromTemplate({
      projectId, scopeTemplateId: templateId, scope, quoteDate: '2026-09-01',
    });
    await expect(voidQuote({ quoteId, reason: '  ' })).rejects.toThrow('void_reason is required');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/integration/repository.test.ts`
Expected: FAIL — cannot resolve `@/lib/quote/repository`.

- [ ] **Step 3: Write `src/lib/quote/repository.ts`**

```ts
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  customers, organization, projects, quoteLines, quotes, quoteTaxes,
  rateItems, scopeTemplateItems, taxRates,
} from '@/db/schema';
import { allocateQuoteNumber } from '@/lib/quote/numbering';
import { expandTemplate, type ScopeInputs, type TemplateItem } from '@/lib/quote/template';
import { computeQuote } from '@/lib/quote/totals';
import type { TaxRateInput } from '@/lib/quote/tax';
import type { LineInput } from '@/lib/quote/types';

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function loadTaxRates(): Promise<TaxRateInput[]> {
  const rows = await db.select().from(taxRates)
    .where(and(eq(taxRates.isActive, true), eq(taxRates.recordStatus, 'active')))
    .orderBy(asc(taxRates.sortOrder));
  return rows.map((r) => ({
    label: r.label,
    registrationNumber: r.registrationNumber,
    rateTenThou: r.rateTenThou,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isCompound: r.isCompound,
    sortOrder: r.sortOrder,
  }));
}

export async function createQuoteFromTemplate(args: {
  projectId: string;
  scopeTemplateId: string;
  scope: ScopeInputs;
  quoteDate: string;
  createdBy?: string;
}): Promise<{ quoteId: string }> {
  const [org] = await db.select().from(organization).where(eq(organization.id, 1));
  if (!org) throw new Error('organization row is missing; run setup first');

  const [project] = await db.select().from(projects).where(eq(projects.id, args.projectId));
  if (!project) throw new Error(`project ${args.projectId} not found`);
  const [customer] = await db.select().from(customers).where(eq(customers.id, project.customerId));

  const templateRows = await db
    .select({ template: scopeTemplateItems, item: rateItems })
    .from(scopeTemplateItems)
    .innerJoin(rateItems, eq(scopeTemplateItems.rateItemId, rateItems.id))
    .where(eq(scopeTemplateItems.scopeTemplateId, args.scopeTemplateId))
    .orderBy(asc(scopeTemplateItems.sortOrder));

  const templateItems: TemplateItem[] = templateRows.map(({ template, item }) => ({
    code: item.code,
    description: item.description,
    lineGroup: template.lineGroup,
    sortOrder: template.sortOrder,
    calcMode: item.calcMode,
        unitLabel: item.unitLabel,
    qtySource: template.qtySource,
    qtyMultiplierTenThou: template.qtyMultiplierTenThou,
    fixedQtyMilli: template.fixedQtyMilli,
    // Snapshot happens here: the rate is read once and never referenced again.
    costRateTenThou: item.costRateTenThou,
    sellRateTenThou: item.sellRateTenThou,
    isTaxable: item.isTaxable,
    isOptional: template.isOptional,
  }));

  const lines = expandTemplate(templateItems, args.scope);
  const rates = await loadTaxRates();
  const totals = computeQuote(lines, rates, {
    onDate: args.quoteDate,
    customerExempt: customer?.isTaxExempt ?? false,
  });

  return db.transaction(async (tx) => {
    const quoteNumber = await allocateQuoteNumber(tx);

    const [quote] = await tx.insert(quotes).values({
      projectId: args.projectId,
      quoteNumber,
      version: 1,
      quoteDate: args.quoteDate,
      validUntil: addDays(args.quoteDate, org.quoteValidityDays),
      areaSqftMilli: args.scope.areaSqftMilli,
      washroomCount: args.scope.washroomCount,
      kitchenCount: args.scope.kitchenCount,
      bedroomCount: args.scope.bedroomCount,
      subtotalCents: totals.subtotalCents,
      taxTotalCents: totals.taxTotalCents,
      totalCents: totals.totalCents,
      totalCostCents: totals.totalCostCents,
      marginBp: totals.marginBp,
      createdBy: args.createdBy,
    }).returning();

    if (totals.lines.length > 0) {
      await tx.insert(quoteLines).values(totals.lines.map((line) => ({
        quoteId: quote.id,
        sortOrder: line.sortOrder,
        lineGroup: line.lineGroup,
        code: line.code,
        description: line.description,
        calcMode: line.calcMode,
        unitLabel: line.unitLabel,
        qtyMilli: line.qtyMilli,
        unitCostTenThou: line.unitCostTenThou,
        unitPriceTenThou: line.unitPriceTenThou,
        lineCostCents: line.lineCostCents,
        lineTotalCents: line.lineTotalCents,
        isTaxable: line.isTaxable,
        isOptional: line.isOptional,
        isIncluded: line.isIncluded,
        createdBy: args.createdBy,
      })));
    }

    if (totals.taxes.length > 0) {
      await tx.insert(quoteTaxes).values(totals.taxes.map((tax) => ({
        quoteId: quote.id,
        label: tax.label,
        registrationNumber: tax.registrationNumber,
        rateTenThou: tax.rateTenThou,
        taxableBaseCents: tax.taxableBaseCents,
        taxAmountCents: tax.taxAmountCents,
        sortOrder: tax.sortOrder,
        createdBy: args.createdBy,
      })));
    }

    return { quoteId: quote.id };
  });
}

/**
 * Creates the next version of a quote by copying its lines and taxes.
 *
 * Lines are copied rather than shared: the customer negotiated against version
 * 1, and version 1 must continue to say what it said. The quote number is
 * carried forward so both versions are recognisably the same document.
 */
export async function reviseQuote(args: {
  quoteId: string;
  createdBy?: string;
}): Promise<{ quoteId: string; version: number }> {
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(quotes).where(eq(quotes.id, args.quoteId));
    if (!source) throw new Error(`quote ${args.quoteId} not found`);

    const siblings = await tx.select({ version: quotes.version }).from(quotes)
      .where(eq(quotes.projectId, source.projectId));
    const nextVersion = Math.max(...siblings.map((s) => s.version)) + 1;

    await tx.update(quotes).set({ status: 'superseded' }).where(eq(quotes.id, source.id));

    const [copy] = await tx.insert(quotes).values({
      projectId: source.projectId,
      quoteNumber: source.quoteNumber,
      version: nextVersion,
      status: 'draft',
      quoteDate: source.quoteDate,
      validUntil: source.validUntil,
      areaSqftMilli: source.areaSqftMilli,
      washroomCount: source.washroomCount,
      kitchenCount: source.kitchenCount,
      bedroomCount: source.bedroomCount,
      subtotalCents: source.subtotalCents,
      taxTotalCents: source.taxTotalCents,
      totalCents: source.totalCents,
      totalCostCents: source.totalCostCents,
      marginBp: source.marginBp,
      terms: source.terms,
      notes: source.notes,
      internalNotes: source.internalNotes,
      createdBy: args.createdBy,
    }).returning();

    const sourceLines = await tx.select().from(quoteLines)
      .where(eq(quoteLines.quoteId, source.id)).orderBy(asc(quoteLines.sortOrder));
    if (sourceLines.length > 0) {
      await tx.insert(quoteLines).values(sourceLines.map(({ id, quoteId, createdAt, updatedAt, ...rest }) => ({
        ...rest, quoteId: copy.id, createdBy: args.createdBy,
      })));
    }

    const sourceTaxes = await tx.select().from(quoteTaxes)
      .where(eq(quoteTaxes.quoteId, source.id)).orderBy(asc(quoteTaxes.sortOrder));
    if (sourceTaxes.length > 0) {
      await tx.insert(quoteTaxes).values(sourceTaxes.map(({ id, quoteId, createdAt, updatedAt, ...rest }) => ({
        ...rest, quoteId: copy.id, createdBy: args.createdBy,
      })));
    }

    return { quoteId: copy.id, version: nextVersion };
  });
}

/** Voids a quote. Nothing is ever deleted, and a reason is mandatory. */
export async function voidQuote(args: {
  quoteId: string;
  reason: string;
  voidedBy?: string;
}): Promise<void> {
  if (args.reason.trim().length === 0) throw new Error('void_reason is required');
  await db.update(quotes).set({
    recordStatus: 'void',
    voidedAt: new Date(),
    voidedBy: args.voidedBy,
    voidReason: args.reason.trim(),
  }).where(eq(quotes.id, args.quoteId));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/integration/repository.test.ts`
Expected: PASS. The snapshot test is the important one — changing a rate item must not move an existing quote.

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote/repository.ts tests/integration/repository.test.ts
git commit -m "feat: create, revise, and void quotes with snapshotted rates"
```

---

### Task 17: White-label guard and full suite

A grep test is the only thing that reliably keeps tenant values out of a codebase over a year of edits.

**Files:**
- Create: `tests/ops/white-label.test.ts`
- Create: `.github/workflows/test.yml`
- Test: itself

**Interfaces:**
- Consumes: the whole source tree
- Produces: a failing build when a tenant-specific literal appears outside `src/db/seed/`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ops/white-label.test.ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SEARCH_DIRS = ['src', 'scripts'];
const EXEMPT = [path.join('src', 'db', 'seed')];

/**
 * Values that belong to a tenant, never to the product.
 *
 * `0.13` is included deliberately: an Ontario HST rate appearing in code rather
 * than in the tax_rates table is exactly the bug this guard exists to catch.
 */
const FORBIDDEN = [
  /maple\s*custom\s*homes/i,
  /maplecustomhomes/i,
  /general contracting done right/i,
  /\b0\.13\b/,
  /\b647-?960-?4017\b/,
];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|css|sql|json)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe('white-label guard', () => {
  it('finds no tenant-specific literal outside the seed directory', async () => {
    const offences: string[] = [];

    for (const dir of SEARCH_DIRS) {
      for await (const file of walk(path.join(ROOT, dir))) {
        const relative = path.relative(ROOT, file);
        if (EXEMPT.some((e) => relative.startsWith(e))) continue;
        const text = await readFile(file, 'utf8');
        for (const pattern of FORBIDDEN) {
          if (pattern.test(text)) offences.push(`${relative} matches ${pattern}`);
        }
      }
    }

    expect(offences).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it pass, then prove it can fail**

Run: `npx vitest run tests/ops/white-label.test.ts`
Expected: PASS.

Now prove the guard works. Temporarily add `const RATE = 0.13;` to `src/lib/quote/tax.ts`, re-run, and confirm FAIL with the file named. Then remove it and confirm PASS again. A guard that has never failed is not a guard.

- [ ] **Step 3: Write `.github/workflows/test.yml`**

```yaml
name: test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: quote
          POSTGRES_PASSWORD: quote_dev_only
          POSTGRES_DB: quote
        ports: ['5433:5432']
        options: >-
          --health-cmd "pg_isready -U quote"
          --health-interval 5s --health-timeout 3s --health-retries 10
    env:
      DATABASE_URL: postgres://quote:quote_dev_only@127.0.0.1:5433/quote
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run db:push
      - run: npm run db:sql drizzle/0001_touch_and_grants.sql
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 4: Run the whole suite**

Run: `npm run typecheck && npm test`
Expected: PASS, every test file green.

- [ ] **Step 5: Commit**

```bash
git add tests/ops/white-label.test.ts .github/workflows/test.yml
git commit -m "test: guard against tenant-specific literals and run the suite in CI"
```

---

## Plan Self-Review

**Spec coverage.** Sections covered by this plan: 2.1 white-label (Tasks 5, 17), 4 data model and the no-delete rule (Tasks 4–9), 4.1 rate snapshotting (Task 16), 4.2 cost and sell on every item (Task 7), 5.1 line types (Tasks 10–11), 5.2 scope templates (Task 14), 5.3 margin not markup (Task 2), 5.4 versioning (Task 16), 5.5 optional lines (Tasks 13–14), 6.3 regional rules as configuration (Tasks 5, 12), 9.1 fiscal periods as settings (Task 5).

Deliberately deferred, each to a named plan: Cloudflare Access and roles (Plan 2), the worksheet and all interface work (Plan 2), PDF generation (Plan 3), SharePoint generator, provisioning, sync, restore, and backup (Plan 4), setup wizard, seed data, and accountant export (Plan 5).

**Deviation from the spec, recorded here rather than silently.** The spec describes money as `numeric(12,2)`, quantities as `numeric(12,3)`, and rates as `numeric(12,4)`. This plan stores all three as scaled integers instead. The reason is that `numeric` reaches JavaScript as a string through Drizzle, and every read would need parsing back into exact arithmetic anyway; scaled integers are exact end to end and match Budget Tracker's integer-cents idiom and its `Money` component. **Plan 4 must unscale on the way to SharePoint** — a rate has to appear there as `4.0000`, not `40000`.

**Placeholder scan.** No TBDs. Every code step carries complete code. Every test step carries real assertions with expected values computed by hand.

**Type consistency.** `LineInput` and `ComputedLine` are defined once in `src/lib/quote/types.ts` and imported everywhere. `TaxRateInput` and `ComputedTax` are defined once in `src/lib/quote/tax.ts`. Scale helpers take and return `bigint`; persisted cent values are `number`; the boundary is `Number(...)` at the end of each engine function, and it is the same in every task.
