import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  type Capability,
  type Role,
  can,
  canGrantRole,
  canManageUser,
  PermissionError,
  refuseSelfRoleChange,
} from '@/lib/auth/permissions';

/**
 * No database. Everything under test here is pure, and `db` is a lazy proxy,
 * so importing the module opens no socket.
 *
 * The expectation table below is transcribed from the SSO design, section
 * 10.2, and is deliberately a second copy of it. A test that read
 * `CAPABILITY_MATRIX` to decide what to expect would assert that the table
 * equals itself and would pass through any edit, including a wrong one. The
 * `row` field carries the spec's own wording so a failure names the line of
 * the document it broke.
 */

const ROLES: Role[] = ['owner', 'admin', 'bookkeeper'];

interface SpecRow {
  row: string;
  capability: Capability;
  owner: boolean;
  admin: boolean;
  bookkeeper: boolean;
}

const MATRIX_10_2: SpecRow[] = [
  {
    row: 'Create and edit customers, projects, quotes',
    capability: 'quote:write',
    owner: true, admin: true, bookkeeper: false,
  },
  {
    row: 'Send, accept, decline, revise a quote',
    capability: 'quote:transition',
    owner: true, admin: true, bookkeeper: false,
  },
  {
    // "A quote, project, or customer" is the whole of this row. An expense is
    // not on it and never was, which is what lets `expense:write` carry the
    // voiding of an expense without changing what this capability means.
    row: 'Void a quote, project, or customer',
    capability: 'record:void',
    owner: true, admin: true, bookkeeper: false,
  },
  {
    // The bookkeeper's one write. The role prepares the year end, so it enters
    // the receipts -- and retracts the one it typed twice, because splitting
    // entry from correction leaves a double-count standing in the books the
    // role exists to keep.
    row: 'Enter, correct and void an expense or a mileage entry',
    capability: 'expense:write',
    owner: true, admin: true, bookkeeper: true,
  },
  {
    // "Yes, read-only" for bookkeeper. The read is allowed; what is withheld is
    // every capability that changes a priced record.
    row: 'See cost and margin, read the worksheet',
    capability: 'worksheet:read',
    owner: true, admin: true, bookkeeper: true,
  },
  {
    row: 'Generate and download documents',
    capability: 'document:generate',
    owner: true, admin: true, bookkeeper: true,
  },
  {
    // "Yes, except owner rows and except granting owner" for admin. Both
    // exceptions are guardrails, asserted separately below and against the
    // database in the integration suite.
    row: 'Manage users: add, deactivate, set role, set sign-in method',
    capability: 'user:manage',
    owner: true, admin: true, bookkeeper: false,
  },
  {
    row: "Reset a user's provider link, sign a user out everywhere",
    capability: 'user:reset-link',
    owner: true, admin: true, bookkeeper: false,
  },
  {
    row: 'Edit rate items, cost codes, scope templates',
    capability: 'rates:edit',
    owner: true, admin: true, bookkeeper: false,
  },
  {
    row: 'Edit tax rates and their effective dates',
    capability: 'tax:edit',
    owner: true, admin: false, bookkeeper: false,
  },
  {
    row: 'Edit organization identity, branding, and document text',
    capability: 'organization:edit',
    owner: true, admin: false, bookkeeper: false,
  },
  {
    row: 'Turn the SharePoint mirror on or off, read its state',
    capability: 'sync:configure',
    owner: true, admin: false, bookkeeper: false,
  },
  {
    row: 'Read and configure backup, restore, and update settings',
    capability: 'backup:configure',
    owner: true, admin: false, bookkeeper: false,
  },
  {
    row: 'Read the audit log',
    capability: 'audit:read',
    owner: true, admin: true, bookkeeper: true,
  },
  {
    row: 'Accountant export (Phase 3)',
    capability: 'export:read',
    owner: true, admin: true, bookkeeper: true,
  },
];

describe.each(MATRIX_10_2)('$capability -- $row', (entry) => {
  it.each(ROLES)('%s', (role) => {
    expect(can(role, entry.capability)).toBe(entry[role]);
  });
});

describe('the matrix as a whole', () => {
  it('covers every capability in the union, and nothing else', () => {
    // This is the assertion that turns adding a capability without wiring it
    // into a failure rather than a silent omission: a new name in
    // CAPABILITIES with no line in the table above lands here.
    expect([...MATRIX_10_2.map((entry) => entry.capability)].sort()).toEqual(
      [...CAPABILITIES].sort(),
    );
  });

  it('gives every role an explicit boolean for every capability', () => {
    for (const role of ROLES) {
      const column = CAPABILITY_MATRIX[role] as Record<string, unknown>;
      // hasOwn, not truthiness: a capability inherited from Object.prototype
      // would answer a lookup without being a decision anybody made.
      for (const capability of CAPABILITIES) {
        expect(Object.hasOwn(column, capability)).toBe(true);
        expect(typeof column[capability]).toBe('boolean');
      }
      expect(Object.keys(column)).toHaveLength(CAPABILITIES.length);
    }
  });

  it('holds a column for every role in the enum, and nothing else', () => {
    expect(Object.keys(CAPABILITY_MATRIX).sort()).toEqual([...ROLES].sort());
  });

  it('reserves the deployment-wide capabilities to the owner', () => {
    const ownerOnly = CAPABILITIES.filter(
      (capability) => !can('admin', capability) && !can('bookkeeper', capability),
    );
    expect(ownerOnly).toEqual([
      'tax:edit',
      'organization:edit',
      'sync:configure',
      'backup:configure',
    ]);
    // Four rows, though section 10.2's prose says five. The fifth is granting
    // `owner`, which is guardrail 2 rather than a matrix row, so it is
    // asserted where it lives.
    expect(canGrantRole({ id: 'a904', role: 'admin' }, 'owner')).toBe(false);
  });
});

describe('deny by default', () => {
  it('refuses a capability that is not in the matrix', () => {
    // The cast is the point: a route calling a name this module has never
    // heard of must fail closed rather than fall through to allowed.
    expect(can('owner', 'quote:delete' as Capability)).toBe(false);
    expect(can('owner', '' as Capability)).toBe(false);
  });

  it('refuses a name inherited from Object.prototype', () => {
    // `matrix.owner.toString` is a function, and a truthiness check would have
    // admitted it.
    expect(can('owner', 'toString' as Capability)).toBe(false);
    expect(can('owner', 'constructor' as Capability)).toBe(false);
    expect(can('owner', '__proto__' as Capability)).toBe(false);
  });

  it('refuses a role that is not in the enum', () => {
    expect(can('superuser' as Role, 'audit:read')).toBe(false);
    expect(can(undefined as unknown as Role, 'audit:read')).toBe(false);
  });
});

describe('canManageUser', () => {
  const cases: { actor: Role; target: Role; allowed: boolean }[] = [
    { actor: 'owner', target: 'owner', allowed: true },
    { actor: 'owner', target: 'admin', allowed: true },
    { actor: 'owner', target: 'bookkeeper', allowed: true },
    // Guardrail 1: owner rows are read-only to an admin.
    { actor: 'admin', target: 'owner', allowed: false },
    { actor: 'admin', target: 'admin', allowed: true },
    { actor: 'admin', target: 'bookkeeper', allowed: true },
    { actor: 'bookkeeper', target: 'owner', allowed: false },
    { actor: 'bookkeeper', target: 'admin', allowed: false },
    { actor: 'bookkeeper', target: 'bookkeeper', allowed: false },
  ];

  it.each(cases)('$actor managing $target is $allowed', ({ actor, target, allowed }) => {
    expect(canManageUser({ id: 'actor', role: actor }, { id: 'target', role: target })).toBe(
      allowed,
    );
  });

  it('lets an admin edit their own non-role fields', () => {
    // Guardrail 3 covers the role; a display name is not a privilege.
    const self = { id: 'same', role: 'admin' as Role };
    expect(canManageUser(self, self)).toBe(true);
  });
});

describe('canGrantRole', () => {
  const cases: { actor: Role; granted: Role; allowed: boolean }[] = [
    { actor: 'owner', granted: 'owner', allowed: true },
    { actor: 'owner', granted: 'admin', allowed: true },
    { actor: 'owner', granted: 'bookkeeper', allowed: true },
    // Guardrail 2: only an owner promotes an owner.
    { actor: 'admin', granted: 'owner', allowed: false },
    { actor: 'admin', granted: 'admin', allowed: true },
    { actor: 'admin', granted: 'bookkeeper', allowed: true },
    { actor: 'bookkeeper', granted: 'owner', allowed: false },
    { actor: 'bookkeeper', granted: 'admin', allowed: false },
    { actor: 'bookkeeper', granted: 'bookkeeper', allowed: false },
  ];

  it.each(cases)('$actor granting $granted is $allowed', ({ actor, granted, allowed }) => {
    expect(canGrantRole({ id: 'actor', role: actor }, granted)).toBe(allowed);
  });
});

describe('refuseSelfRoleChange', () => {
  it.each(ROLES)('refuses %s changing their own role', (role) => {
    const actor = { id: 'e7c1', role };
    expect(() => refuseSelfRoleChange(actor, actor.id)).toThrow(PermissionError);
    expect(() => refuseSelfRoleChange(actor, actor.id)).toThrow(/their own role/);
  });

  it('carries a reason a caller can branch on without reading the message', () => {
    try {
      refuseSelfRoleChange({ id: 'e7c1', role: 'owner' }, 'e7c1');
      expect.unreachable('a self role change must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionError);
      expect((error as PermissionError).reason).toBe('not-permitted');
    }
  });

  it('permits changing somebody else at every role', () => {
    for (const role of ROLES) {
      expect(() => refuseSelfRoleChange({ id: 'e7c1', role }, 'a904')).not.toThrow();
    }
  });
});
