/**
 * Page-level horizontal scroll audit.
 *
 * A page that scrolls sideways is not a cosmetic problem: on a phone it hides
 * the right edge of every row, and the element responsible is almost never the
 * one that looks wrong. So this reports the widest offender by name rather
 * than only that the document overflows.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3200';
const WIDTHS = [390, 700, 1024, 1440];
const PATHS = process.argv.slice(2);

const browser = await chromium.launch();
let bad = 0;
let failed = 0;

for (const path of PATHS) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    let result;
    try {
      const response = await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45000 });
      if (!response || response.status() >= 400) {
        failed += 1;
        console.log(`  HTTP ${response?.status()} ${path} @${width}`);
        await page.close();
        continue;
      }
      result = await page.evaluate(() => {
        const root = document.documentElement;
        const over = root.scrollWidth - root.clientWidth;
        if (over <= 0) return { over: 0, culprits: [] };
        // Name the offenders: any element whose right edge sits past the
        // viewport. Sorted widest-first, deepest matches dropped so the
        // report names the container at fault rather than every child of it.
        const limit = root.clientWidth;
        const found = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.right <= limit + 0.5) continue;
          found.push({
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
            right: Math.round(r.right),
            width: Math.round(r.width),
            el,
          });
        }
        const outermost = found.filter((c) => !found.some((o) => o !== c && o.el.contains(c.el)));
        return {
          over,
          culprits: outermost
            .sort((a, b) => b.right - a.right)
            .slice(0, 4)
            .map(({ tag, cls, right, width }) => ({ tag, cls, right, width })),
        };
      });
    } catch (error) {
      console.log(`  FAILED ${path} @${width}: ${String(error).split('\n')[0]}`);
      await page.close();
      continue;
    }
    if (result.over > 0) {
      bad += 1;
      console.log(`OVERFLOW ${path} @${width} by ${result.over}px`);
      for (const c of result.culprits) {
        console.log(`    <${c.tag} class="${c.cls}"> right=${c.right} width=${c.width}`);
      }
    }
    await page.close();
  }
}

await browser.close();
// A load that never happened is not a pass. Reporting "clean" off a run where
// every navigation failed is how an audit gets trusted for nothing.
const attempted = PATHS.length * WIDTHS.length;
console.log(`checked ${attempted - failed}/${attempted} combinations, ${failed} could not load, ${bad} overflowing`);
if (failed > 0 || bad > 0) process.exitCode = 1;
