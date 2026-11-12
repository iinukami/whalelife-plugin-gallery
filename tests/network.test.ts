import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { Agent } from "undici";
import { publicURL, requestBytes } from "../src/network.ts";

function mockLookup(t: TestContext, fn: (...args: any[]) => any) {
  const mock = t.mock.method(dns, "lookup", fn);
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return mock;
}
async function bounded<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Cancellation waited for unresolved DNS")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const mode of ["abort", "timeout"] as const) {
  for (const late of ["resolve", "reject"] as const) {
    test(`${mode} settles before DNS ${late}, with no late HTTP dispatch`, async (t) => {
      let release!: (value: any) => void;
      let reject!: (error: Error) => void;
      const lookup = mockLookup(
        t,
        () =>
          new Promise((yes, no) => {
            release = yes;
            reject = no;
          }),
      );
      let dispatches = 0;
      t.mock.method(
        Agent.prototype,
        "dispatch",
        (_options: any, handler: any) => {
          dispatches++;
          handler.onError(Error("Unexpected HTTP dispatch"));
          return false;
        },
      );
      const controller = new AbortController();
      const request = requestBytes("https://gallery-synthetic.invalid/image", {
        signal: controller.signal,
        limit: 100,
        publicOnly: true,
        timeout: mode === "timeout" ? 20 : 5000,
      });
      // Register rejection handling before cancellation; DNS remains unresolved.
      const rejected = assert.rejects(request, {
        name: mode === "abort" ? "AbortError" : "TimeoutError",
      });
      assert.equal(lookup.mock.callCount(), 1);
      if (mode === "abort") controller.abort();
      try {
        await bounded(rejected);
      } finally {
        if (late === "resolve") release([{ address: "8.8.8.8", family: 4 }]);
        else reject(Error("Synthetic late DNS failure"));
        await request.catch(() => {});
      }
      await setImmediate();
      assert.equal(dispatches, 0);
    });
  }
}

test("pre-aborted public URL does not start DNS; settled lookups release cancellation listeners", async (t) => {
  const lookup = mockLookup(t, async () => [{ address: "8.8.8.8", family: 4 }]);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    publicURL("https://gallery-synthetic.invalid", aborted.signal),
    { name: "AbortError" },
  );
  assert.equal(lookup.mock.callCount(), 0);
  const controller = new AbortController();
  const resolved = await publicURL(
    "https://gallery-synthetic.invalid",
    controller.signal,
  );
  assert.deepEqual(resolved.addresses, [{ address: "8.8.8.8", family: 4 }]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("aborting public URL releases listeners and late private DNS results remain rejected", async (t) => {
  let release!: (value: any) => void;
  mockLookup(
    t,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new AbortController();
  const pending = publicURL(
    "https://gallery-synthetic.invalid",
    controller.signal,
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  try {
    await bounded(rejected);
  } finally {
    release([{ address: "127.0.0.1", family: 4 }]);
    await pending.catch(() => {});
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
