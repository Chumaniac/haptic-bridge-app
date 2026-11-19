import type { Page, Route } from 'playwright';

export async function withDeferredSession(page: Page, origin: string, check: (requested: () => boolean) => Promise<void>): Promise<void> {
  let release: () => void = () => {};
  let requested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const matches = (url: URL) => url.origin === origin && url.pathname === '/api/session' && !url.search;
  const handler = async (route: Route) => {
    requested = true;
    await gate;
    // A failed navigation may already have cancelled this request.
    try { await route.continue(); } catch { /* The scenario's original failure is authoritative. */ }
  };
  await page.route(matches, handler, { times: 1 });
  let failure: { error: unknown } | undefined;
  try {
    await check(() => requested);
  } catch (error) {
    failure = { error };
  } finally {
    release();
    // Cleanup must never wait for a response that might not exist.
    try { await page.unroute(matches, handler); } catch (error) { failure ??= { error }; }
  }
  if (failure) throw failure.error;
}
