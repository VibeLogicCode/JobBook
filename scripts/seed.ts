/**
 * Loads the demo tenant.
 *
 * Idempotent by design: it clears the business tables first, so running it
 * twice does not produce two of everything. It refuses to run against a
 * database that already holds a different organization, because "seed the demo
 * data" must never be one keystroke away from wiping a real company's quotes.
 */
import { eq, sql } from 'drizzle-orm';
import { closeDb, db } from '@/db/client';
import {
  costCodes, customers, organization, projects, quotes, rateItems, scopeTemplateItems,
  scopeTemplates, taxRates, users,
} from '@/db/schema';
import {
  DEMO_COST_CODES, DEMO_CUSTOMERS, DEMO_ORGANIZATION, DEMO_RATE_ITEMS, DEMO_TAX_RATE,
  DEMO_TEMPLATES, DEMO_USERS,
} from '@/db/seed/demo';
import { seedScheduleTemplates } from '@/db/seed/schedule-templates';
import { createQuoteFromTemplate } from '@/lib/quote/repository';

async function main() {
  const [existing] = await db.select().from(organization).where(eq(organization.id, 1));
  if (existing && existing.legalName !== DEMO_ORGANIZATION.legalName && !process.env.SEED_FORCE) {
    throw new Error(
      `this database belongs to ${existing.legalName}. Set SEED_FORCE=1 only if you mean to replace it.`,
    );
  }

  console.log('clearing the business tables');
  await db.execute(sql`
    truncate table audit_log, stage_history, quote_taxes, quote_lines, quotes, quote_clauses,
    scope_template_items, scope_templates, rate_items, cost_codes, tax_rates,
    projects, customers, users, organization, document_sequences, sp_item_map, sync_state
    restart identity cascade
  `);

  await db.insert(organization).values(DEMO_ORGANIZATION);
  await db.insert(taxRates).values(DEMO_TAX_RATE);
  await db.insert(users).values(DEMO_USERS);

  const codeIds = new Map<string, string>();
  for (const [index, code] of DEMO_COST_CODES.entries()) {
    const [row] = await db
      .insert(costCodes)
      .values({ ...code, sortOrder: index })
      .returning();
    codeIds.set(code.code, row!.id);
  }

  const itemIds = new Map<string, string>();
  for (const item of DEMO_RATE_ITEMS) {
    const [row] = await db
      .insert(rateItems)
      .values({
        code: item.code,
        description: item.description,
        costCodeId: codeIds.get(item.costCode) ?? null,
        calcMode: item.calcMode,
        unitLabel: item.unitLabel,
        costRateTenThou: item.cost,
        sellRateTenThou: item.sell,
        isTaxable: item.isTaxable ?? true,
        isAllowance: item.isAllowance ?? false,
        sortOrder: item.sortOrder,
      })
      .returning();
    itemIds.set(item.code, row!.id);
  }

  const templateIds = new Map<string, string>();
  for (const template of DEMO_TEMPLATES) {
    const [row] = await db
      .insert(scopeTemplates)
      .values({
        name: template.name,
        projectType: template.projectType,
        description: template.description,
      })
      .returning();
    templateIds.set(template.name, row!.id);

    await db.insert(scopeTemplateItems).values(
      template.items.map((item, index) => ({
        scopeTemplateId: row!.id,
        rateItemId: itemIds.get(item.code)!,
        qtySource: item.source,
        qtyMultiplierTenThou: item.multiplier,
        fixedQtyMilli: item.fixedQty ?? null,
        isOptional: item.optional ?? false,
        isAllowance: item.allowance ?? false,
        lineGroup: item.group,
        sortOrder: index,
      })),
    );
  }

  // The one worked example for the schedule template editor (a separate piece
  // of work), so it opens onto something real rather than an empty list. Runs
  // after the loop above so its "Wet bar rough-in" task's rate-item condition
  // resolves against the FIN-09 row just inserted -- see the file for why that
  // lookup is by code rather than a fixed id.
  await seedScheduleTemplates();

  let projectSeq = 1;
  for (const customer of DEMO_CUSTOMERS) {
    const { projects: customerProjects, ...customerFields } = customer;
    const [customerRow] = await db.insert(customers).values(customerFields).returning();

    for (const project of customerProjects) {
      const { template, scope, ...projectFields } = project;
      const [projectRow] = await db
        .insert(projects)
        .values({
          ...projectFields,
          customerId: customerRow!.id,
          projectNumber: `P-${String(projectSeq++).padStart(4, '0')}`,
        })
        .returning();

      const { quoteId, quoteNumber } = await createQuoteFromTemplate({
        projectId: projectRow!.id,
        scopeTemplateId: templateIds.get(template)!,
        scope,
      });
      console.log(`  ${projectRow!.projectNumber}  ${project.name}  ${quoteNumber}`);

      // A quote sitting at "sent" is what makes the Today screen show
      // something on a fresh install.
      if (project.stage === 'quote_sent') {
        await db.update(quotes).set({ status: 'sent', sentAt: new Date() }).where(eq(quotes.id, quoteId));
      }
      if (project.stage === 'won') {
        await db
          .update(quotes)
          .set({ status: 'sent', sentAt: new Date() })
          .where(eq(quotes.id, quoteId));
        await db
          .update(quotes)
          .set({ status: 'accepted', acceptedAt: new Date(), acceptedByName: customer.name })
          .where(eq(quotes.id, quoteId));
      }
    }
  }

  console.log('done');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
