import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(process.cwd(), 'src');

/**
 * Nothing offers a route this deployment has switched off.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * The first cut of the module switches filtered the rail, the phone bar and
 * the settings menu, and stopped there. The dashboard went on rendering a
 * Reminders card -- heading, empty-state sentence, and an "All reminders"
 * button straight into a screen that was no longer on the navigation. The
 * owner reported it immediately, and he was right: "off" has to mean not
 * offered ANYWHERE, not merely absent from the menu.
 *
 * Cross-links are exactly the kind of thing that gets added later by somebody
 * who does not know the switches exist, and they are invisible in a codebase
 * this size until a deployment turns something off.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CHECKS, AND WHAT IT CANNOT
 * ---------------------------------------------------------------------------
 *
 * A file outside a module's own route tree that links INTO that module has to
 * consult the module state somewhere. It is a heuristic: it proves the file
 * knows the switches exist, not that the gate wraps that exact link. A test
 * that tried to prove the second would need a renderer, and this suite has no
 * DOM by design.
 *
 * It catches the real failure, which is a link added with no thought about the
 * switches at all.
 */

/** The optional parts, and the route each one owns. */
const OPTIONAL: Record<string, string> = {
  '/reminders': 'reminders',
  '/projects': 'pipeline',
  '/calendar': 'calendar',
  '/vendors': 'vendors',
  '/expenses': 'expenses',
  '/templates': 'templates',
};

/**
 * Files that legitimately name every route and are the mechanism itself.
 * `destinations.ts` IS the filter, and the module library defines the map.
 */
const MECHANISM = ['components/ui/destinations.ts', 'lib/modules/', 'app/settings/nav.ts'];

/** Proof that a file has considered the switches at all. */
const CONSULTS = ['deploymentModules(', 'modulesOf(', 'modules.', 'ModuleState'];

async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('links into an optional part', () => {
  it('only appear in files that know the part can be switched off', async () => {
    const offences: string[] = [];
    let links = 0;

    for (const file of await walk(ROOT)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (MECHANISM.some((allowed) => rel.startsWith(allowed))) continue;

      const source = await readFile(file, 'utf8');

      for (const [route, key] of Object.entries(OPTIONAL)) {
        // A file inside the module's own tree links to itself constantly, and
        // it is already unreachable from the menu when the module is off.
        if (rel.startsWith(`app${route}/`)) continue;

        // `href="/reminders"`, `href={`/projects/${id}`}` and friends.
        const pattern = new RegExp(`href=(["'\`])${route}(?![a-z-])`, 'g');
        const hits = source.match(pattern);
        if (!hits) continue;

        links += hits.length;
        if (!CONSULTS.some((marker) => source.includes(marker))) {
          offences.push(`${rel} links to ${route} (${key}) without consulting the switches`);
        }
      }
    }

    expect(offences).toEqual([]);
    // Guards against the sweep matching nothing at all and passing on silence.
    expect(links).toBeGreaterThan(0);
  });
});
