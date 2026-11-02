import type { TestContext } from "node:test";
import { mkdtemp, mkdir, rm, realpath, lstat, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Store } from "../src/store.ts";
import { Gallery } from "../src/runtime.ts";
import { defaults } from "../src/types.ts";
import type { ModelBackend } from "../src/models.ts";
export const root = fileURLToPath(new URL("../", import.meta.url));
export async function temporary(t: TestContext) {
  const base = join(root, ".artifacts", "tests");
  let dir: string | undefined;
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const f of cleanup.reverse())
      try {
        await f();
      } catch (e) {
        errors.push(e);
      }
    if (dir) {
      if (
        dirname(resolve(dir)) !== resolve(base) ||
        resolve(await realpath(base)) !== resolve(base) ||
        (await lstat(dir)).isSymbolicLink()
      )
        throw Error("Unsafe cleanup");
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
    if (errors.length) throw new AggregateError(errors);
  });
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "gallery-"));
  return { dir, cleanup };
}
export async function png(color = "#18aa88") {
  return sharp({
    create: { width: 24, height: 24, channels: 4, background: color },
  })
    .png()
    .toBuffer();
}
export class FakeModels implements ModelBackend {
  calls: string[] = [];
  captions = 0;
  key = "fake-space";
  space() {
    return this.key;
  }
  async embed(value: string, signal: AbortSignal) {
    signal.throwIfAborted();
    this.calls.push(value);
    return {
      values: value.includes("猫") ? [1, 0] : [0, 1],
      space: this.key,
      model: "fake-embed",
    };
  }
  async caption(_bytes: Buffer, signal: AbortSignal) {
    signal.throwIfAborted();
    this.captions++;
    return {
      description: "猫在打招呼",
      tags: ["猫"],
      purposes: ["meme" as const],
    };
  }
}
export async function fixture(
  t: TestContext,
  models: ModelBackend = new FakeModels(),
) {
  const temp = await temporary(t);
  const store = new Store(join(temp.dir, "data"));
  const controller = new AbortController();
  const config = { ...defaults };
  const app = new Gallery(store, models, () => config, controller.signal);
  temp.cleanup.push(() => app.stop());
  return { ...temp, app, store, models, controller, config };
}
export async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw Error("Timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
