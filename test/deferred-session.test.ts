import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { withDeferredSession } from '../scripts/deferred-session.ts';

test('session cleanup preserves the original navigation/assertion failure', async () => {
  const original = new Error('original synthetic navigation failure');
  let removed = false;
  const page = {
    route: async () => {},
    unroute: async () => { removed = true; },
    waitForResponse: async () => { throw new Error('secondary cleanup response timeout'); },
  } as unknown as Page;
  await assert.rejects(withDeferredSession(page, 'http://127.0.0.1:1234', async () => { throw original; }), error => error === original);
  assert.equal(removed, true);
});


test('cleanup completes without a response and intercepts only the first exact origin', async () => {
  let removed = false;
  const page = {
    route: async (matches: (url: URL) => boolean, _handler: unknown, options: { times: number }) => {
      assert.equal(matches(new URL('http://127.0.0.1:1234/api/session')), true);
      assert.equal(matches(new URL('http://127.0.0.1:9999/api/session')), false);
      assert.equal(matches(new URL('http://127.0.0.1:1234/api/session?other=1')), false);
      assert.equal(options.times, 1);
    },
    unroute: async () => { removed = true; },
    waitForResponse: async () => { throw new Error('cleanup must not wait for network'); },
  } as unknown as Page;
  await withDeferredSession(page, 'http://127.0.0.1:1234', async requested => { assert.equal(requested(), false); });
  assert.equal(removed, true);
});

test('a route removal failure cannot replace an earlier failure', async () => {
  const original = new Error('original synthetic assertion');
  const page = { route: async () => {}, unroute: async () => { throw new Error('secondary cleanup'); } } as unknown as Page;
  await assert.rejects(withDeferredSession(page, 'http://127.0.0.1:1234', async () => { throw original; }), error => error === original);
});
