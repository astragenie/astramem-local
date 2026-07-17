/**
 * dashboard-nav.ts — single shared nav header for every /dashboard* page.
 *
 * Before this file existed, main/consolidation/search/api each hand-rolled
 * their own <nav> markup (three near-identical copies that could drift
 * independently), and jobs/logs had NO nav at all — an operator on
 * /dashboard/jobs or /dashboard/logs had no way back to the other pages
 * short of editing the URL by hand. `renderDashboardNav()` is now the one
 * place that knows the full page list and link order; every route's
 * renderPage() calls it and reuses the same `nav`/`nav a`/`nav .active`
 * CSS class names already defined in each page's own <style> block (no new
 * class names introduced, so no page needs a CSS rewrite beyond adding the
 * (previously missing) nav rules — see jobs/logs CSS blocks).
 *
 * Zero JS, per the dashboard convention (app.ts:80) — plain <a> links only.
 */

export type DashboardPage = 'main' | 'jobs' | 'consolidation' | 'search' | 'logs' | 'api' | 'providers';

const NAV_ITEMS: ReadonlyArray<{ id: DashboardPage; href: string; label: string }> = [
  { id: 'main', href: '/dashboard', label: 'Mission Control' },
  { id: 'jobs', href: '/dashboard/jobs', label: 'Jobs' },
  { id: 'consolidation', href: '/dashboard/consolidation', label: 'Consolidation' },
  { id: 'search', href: '/dashboard/search', label: 'Search' },
  { id: 'logs', href: '/dashboard/logs', label: 'Logs' },
  { id: 'api', href: '/dashboard/api', label: 'API' },
  { id: 'providers', href: '/dashboard/providers', label: 'Providers' },
];

/** Renders the shared nav bar, highlighting `active` (omit for pages with
 *  no corresponding tab — none currently, but the param stays optional so a
 *  future page under /dashboard/* that hasn't been added to NAV_ITEMS yet
 *  still renders a nav with nothing highlighted rather than throwing). */
export function renderDashboardNav(active?: DashboardPage): string {
  const links = NAV_ITEMS.map(item =>
    item.id === active
      ? `<span class="active">${item.label}</span>`
      : `<a href="${item.href}">${item.label}</a>`,
  ).join(' ');
  return `<nav>${links}</nav>`;
}

/** Shared nav CSS — identical across every dashboard page so the nav never
 *  looks different from one page to the next. Pages with their own richer
 *  nav styling (e.g. the main dashboard's `.asof` timestamp) may extend
 *  this, but every page includes these four rules verbatim. */
export const DASHBOARD_NAV_CSS = `
nav{display:flex;align-items:center;gap:16px;margin:8px 0 16px;padding-bottom:8px;border-bottom:1px solid #333;font-size:12px}
nav a{color:#888;text-decoration:none}
nav a:hover{color:#3a7bd5}
nav .active{color:#fff;font-weight:bold}
`.trim();
