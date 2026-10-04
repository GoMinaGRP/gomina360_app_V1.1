/**
 * rail-util.mjs — shared helpers for suites that drive the LEFT RAIL.
 *
 * Why this exists: the navigation cleanup (N5, commit 2356d81) replaced the
 * rail's nested scroll box with a bounded preview — 5 units inline plus a
 * "Show all N units" disclosure (docs/SIDEBAR-NAV-REASSESSMENT.md §5). Any
 * suite that locates a business chip by test-id/text must therefore reveal the
 * full list first, exactly like a user would; otherwise the unit it wants is
 * simply not in the DOM yet and a fuzzy "some button mentions Transport" click
 * silently hits an unrelated element.
 *
 * Usage (puppeteer page):
 *
 *   import { revealAllUnits } from "./rail-util.mjs";
 *   await revealAllUnits(page);          // after login / after a reload
 *
 * Safe to call at any time: it is a no-op when the list is short, when the
 * disclosure has already been used, or when the sidebar is not rendered yet.
 */

/**
 * Expand the rail's unit list so every business chip is clickable.
 * @returns {Promise<number>} how many unit chips are in the rail afterwards.
 */
export async function revealAllUnits(page, { settleMs = 700 } = {}) {
  const count = () =>
    page
      .evaluate(() => document.querySelectorAll('[data-testid="nav-sidebar"] [data-biz-code]').length)
      .catch(() => 0);

  await page
    .evaluate(() => {
      const btn = document.querySelector('[data-testid="nav-biz-show-all"]');
      if (btn && (btn.textContent || "").includes("Show all")) btn.click();
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, settleMs));
  return count();
}

/**
 * Click a unit chip by code once the list is revealed.
 * @returns {Promise<boolean>} whether the chip was found and clicked.
 */
export async function clickUnit(page, code) {
  const click = () =>
    page
      .evaluate((c) => {
        const el = document.querySelector(
          `[data-testid="nav-sidebar"] [data-biz-code="${c}"]`,
        );
        if (!el) return false;
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      }, code)
      .catch(() => false);

  if (await click()) return true;
  await revealAllUnits(page);
  return click();
}
