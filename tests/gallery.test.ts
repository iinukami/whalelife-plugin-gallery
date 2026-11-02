import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture, png, FakeModels, until, temporary } from "./helpers.ts";
import { Store, hash, indexText } from "../src/store.ts";
import { inspectImage, sampledFrames } from "../src/media.ts";
import sharp from "sharp";
import { fail } from "../src/types.ts";
import { jobSummary } from "../src/jobs.ts";
const source = { kind: "local" as const, key: "fixture" };

test("shared content ID, dual purposes, filter before ranking, archive and restore preserve objects", async (t) => {
  const { app, store } = await fixture(t);
  const bytes = await png();
  const a = await app.ingest(
    bytes,
    { description: "猫", purposes: ["image", "meme"] },
    source,
    app.signal,
  );
  const again = await app.ingest(bytes, {}, source, app.signal);
  assert.equal(again.id, a.id);
  assert.equal(store.stats().active, 1);
  assert.equal((await readdir(join(store.root, "objects"))).length, 1);
  const other = await app.ingest(
    await png("#11bb44"),
    { description: "猫照片", purposes: ["image"] },
    source,
    app.signal,
  );
  const j = app.prepare([a.id, other.id]);
  app.jobs.resume(j.id);
  await until(() => store.job(j.id).state === "completed");
  assert.deepEqual(
    (await app.search("猫", "meme", 5, app.signal)).candidates.map((x) => x.id),
    [a.id],
  );
  const archived = store.edit(a.id, store.get(a.id).revision, {
    archived: true,
  });
  assert.equal(store.stats().activeIndexed, 1);
  assert.equal(store.stats().indexed, 2);
  assert.equal(
    (await app.search("猫", "meme", 5, app.signal)).candidates.length,
    0,
  );
  assert.deepEqual(await readFile(store.path(a.id)), bytes);
  store.edit(a.id, archived.revision, { archived: false });
  assert.equal(
    (await app.search("猫", "meme", 5, app.signal)).candidates.length,
    1,
  );
  assert.equal(store.stats().active, 2);
});
test("user and model edits both win over reimports; model can replace user edits", async (t) => {
  const { app, store } = await fixture(t);
  const b = await png();
  let a = await app.ingest(
    b,
    { description: "upstream", tags: ["old"], purposes: ["meme"] },
    source,
    app.signal,
  );
  a = store.edit(
    a.id,
    a.revision,
    {
      description: "user",
      tags: ["local"],
      purposes: ["image"],
      archived: true,
    },
    "user",
  );
  a = store.edit(a.id, a.revision, { description: "her own words" }, "model");
  a = await app.ingest(
    b,
    { description: "update", tags: ["new"], purposes: ["meme"] },
    { ...source, ref: "new" },
    app.signal,
  );
  assert.equal(a.description, "her own words");
  assert.deepEqual(a.tags, ["local"]);
  assert.deepEqual(a.purposes, ["image"]);
  assert.equal(a.archived, true);
});
test("incremental processing reuses current vectors and invalidates edited text or model space", async (t) => {
  const models = new FakeModels(),
    { app, store } = await fixture(t, models);
  let a = await app.ingest(await png(), {}, source, app.signal);
  for (let i = 0; i < 2; i++) {
    const j = app.prepare([a.id]);
    app.jobs.resume(j.id);
    await until(() => store.job(j.id).state === "completed");
  }
  assert.equal(models.captions, 1);
  assert.equal(models.calls.length, 1);
  a = store.get(a.id);
  const old = store.vector(a.id)!;
  store.edit(a.id, a.revision, { description: "新描述" });
  assert.equal(store.vector(a.id), undefined);
  assert.throws(() => store.putVector(a.id, old, a.revision), /描述变化/);
  const j = app.prepare([a.id]);
  app.jobs.resume(j.id);
  await until(() => store.job(j.id).state === "completed");
  assert.equal(models.calls.length, 2);
  models.key = "new-model";
  assert.equal(
    (await app.search("猫", "meme", 5, app.signal)).candidates.length,
    0,
  );
  const rebuild = app.prepare([a.id]);
  app.jobs.resume(rebuild.id);
  await until(() => store.job(rebuild.id).state === "completed");
  assert.equal(store.vector(a.id)?.space, "new-model");
});
test("imports do not invoke models, single collection does, default closed originals never leak bytes", async (t) => {
  const models = new FakeModels(),
    { app, store, config } = await fixture(t, models);
  const bytes = await png();
  const offer = store.offer(bytes, "session-a", { kind: "chat", key: "fake" });
  await assert.rejects(
    app.collect({ mediaRef: offer }, "session-b", app.signal),
    /不属于本会话/,
  );
  const saved = await app.collect({ mediaRef: offer }, "session-a", app.signal);
  await until(() => store.job(saved.job.id).state === "completed");
  assert.equal(models.captions, 1);
  const result = await app.search("猫", "meme", 5, app.signal);
  assert.ok(!JSON.stringify(result).includes("base64"));
  assert.ok(!JSON.stringify(result).includes("values"));
  assert.ok(!JSON.stringify(result).includes(store.root));
  assert.throws(() => app.view(saved.asset.id), /已关闭/);
  config.allowOriginals = true;
  assert.throws(() => app.view(saved.asset.id), /尚不支持/);
  await app.ingest(await png("#113344"), {}, source, app.signal);
  assert.equal(models.captions, 1);
});
test("pause aborts request, resume processes unfinished item once, completed items are not replayed", async (t) => {
  class Slow extends FakeModels {
    block = true;
    started = false;
    override async embed(v: string, s: AbortSignal) {
      if (this.block) {
        this.started = true;
        await new Promise<void>((r, j) => {
          s.addEventListener(
            "abort",
            () => j(new DOMException("abort", "AbortError")),
            { once: true },
          );
        });
      }
      return super.embed(v, s);
    }
  }
  const model = new Slow(),
    { app, store } = await fixture(t, model);
  const a = await app.ingest(
    await png(),
    { description: "猫" },
    source,
    app.signal,
  );
  const j = app.prepare([a.id]);
  app.jobs.resume(j.id);
  await until(() => model.started);
  app.jobs.pause(j.id);
  await until(() => store.job(j.id).state === "paused");
  model.block = false;
  app.jobs.resume(j.id);
  await until(() => store.job(j.id).state === "completed");
  assert.equal(model.calls.length, 1);
  app.jobs.resume(j.id);
  assert.equal(model.calls.length, 1);
});
test("shutdown cancels background request; reload preserves data and leaves pending jobs paused", async (t) => {
  class Hanging extends FakeModels {
    started = false;
    aborted = false;
    override async embed(_v: string, s: AbortSignal): Promise<any> {
      this.started = true;
      return new Promise((_r, j) =>
        s.addEventListener(
          "abort",
          () => {
            this.aborted = true;
            j(new DOMException("abort", "AbortError"));
          },
          { once: true },
        ),
      );
    }
  }
  const m = new Hanging(),
    { app, store, dir } = await fixture(t, m);
  const a = await app.ingest(
    await png(),
    { description: "猫" },
    source,
    app.signal,
  );
  const j = app.prepare([a.id]);
  app.jobs.resume(j.id);
  await until(() => m.started);
  await app.stop();
  assert.equal(m.aborted, true);
  const reopened = new Store(join(dir, "data"));
  try {
    assert.equal(reopened.get(a.id).description, "猫");
    assert.equal(reopened.job(j.id).state, "paused");
  } finally {
    reopened.close();
  }
});
test("concurrent metadata edit rejects in-flight old caption/vector instead of overwriting", async (t) => {
  let release: () => void = () => {};
  let started = false;
  class Slow extends FakeModels {
    override async embed(v: string, s: AbortSignal) {
      started = true;
      await new Promise<void>((r) => (release = r));
      return super.embed(v, s);
    }
  }
  const { app, store } = await fixture(t, new Slow());
  let a = await app.ingest(
    await png(),
    { description: "猫" },
    source,
    app.signal,
  );
  const j = app.prepare([a.id]);
  app.jobs.resume(j.id);
  await until(() => started);
  a = store.edit(a.id, a.revision, { description: "新的内容" });
  release();
  await until(() => store.job(j.id).state === "errors");
  assert.equal(store.get(a.id).description, "新的内容");
  assert.equal(store.vector(a.id), undefined);
  assert.equal(store.get(a.id).error, "");
});

test("caption and embedding failures identify the asset and stage; retry recovers without recaptioning or erasing history", async (t) => {
  class Broken extends FakeModels {
    phase = "caption";
    override async caption(bytes: Buffer, signal: AbortSignal) {
      if (this.phase === "caption") {
        this.captions++;
        fail("model_response", "图片理解返回格式无效");
      }
      return super.caption(bytes, signal);
    }
    override async embed(value: string, signal: AbortSignal) {
      if (this.phase === "embedding") fail("network", "请求失败（HTTP 503）。");
      return super.embed(value, signal);
    }
  }
  const model = new Broken(),
    { app, store } = await fixture(t, model);
  const asset = await app.ingest(await png(), {}, source, app.signal);
  const first = app.prepare([asset.id]);
  app.jobs.resume(first.id);
  await until(() => store.job(first.id).state === "errors");
  assert.equal(store.get(asset.id).indexState, "failed");
  assert.match(store.get(asset.id).error, /图片理解失败/);
  assert.equal(model.calls.length, 0);
  assert.equal(
    jobSummary(store.job(first.id), store).errors[0].assetId,
    asset.id,
  );
  assert.equal(jobSummary(store.job(first.id), store).resolvedFailed, 0);

  model.phase = "embedding";
  const second = app.prepare([asset.id]);
  app.jobs.resume(second.id);
  await until(() => store.job(second.id).state === "errors");
  assert.match(store.get(asset.id).error, /向量生成失败.*HTTP 503/);
  assert.equal(store.get(asset.id).captionState, "ready");
  assert.equal(model.captions, 2);

  model.phase = "ready";
  app.jobs.resume(second.id, true);
  await until(() => store.job(second.id).state === "completed");
  assert.equal(model.captions, 2);
  assert.equal(model.calls.length, 1);
  assert.equal(store.get(asset.id).error, "");
  assert.equal(store.get(asset.id).indexState, "ready");
  assert.equal(store.job(first.id).state, "errors");
  assert.equal(jobSummary(store.job(first.id), store).resolvedFailed, 1);
  assert.equal(jobSummary(store.job(first.id), store).errors[0].resolved, true);
});
test("malformed images/vectors rejected and animated images sample multiple different frames", async (t) => {
  const { app, store } = await fixture(t);
  await assert.rejects(
    app.ingest(Buffer.from("<svg/>"), {}, source, app.signal),
    /解码|支持/,
  );
  const raw = Buffer.alloc(2 * 4 * 3);
  raw.fill(255, 0, 12);
  raw.fill(0, 12);
  const gif = await sharp(raw, {
    raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
  })
    .gif({ delay: [100, 100] })
    .toBuffer();
  assert.equal((await inspectImage(gif)).frames, 2);
  const frames = await sampledFrames(gif, app.signal);
  assert.equal(frames.frames.length, 2);
  assert.notEqual(frames.frames[0], frames.frames[1]);
  const a = await app.ingest(
    await png(),
    { description: "猫" },
    source,
    app.signal,
  );
  for (const values of [
    [0, 0],
    [NaN, 1],
    [Infinity, 1],
  ])
    assert.throws(
      () =>
        store.putVector(
          a.id,
          {
            space: "s",
            model: "m",
            dimensions: 2,
            textHash: hash(indexText(a)),
            values,
          },
          a.revision,
        ),
      /向量/,
    );
});
test("editing imported but not preprocessed metadata stays manual; indexed content updates incrementally", async (t) => {
  const models = new FakeModels(),
    { app, store } = await fixture(t, models);
  let a = await app.ingest(
    await png(),
    { description: "导入的猫" },
    source,
    app.signal,
  );
  assert.equal(
    app.edit(a.id, a.revision, { description: "手动整理的猫" }, "user").job,
    undefined,
  );
  assert.equal(models.calls.length, 0);
  const job = app.prepare([a.id]);
  app.jobs.resume(job.id);
  await until(() => store.job(job.id).state === "completed");
  a = store.get(a.id);
  const updated = app.edit(
    a.id,
    a.revision,
    { description: "后来改过的猫" },
    "user",
  );
  assert.ok(updated.job);
  await until(() => store.job(updated.job!.id).state === "completed");
  assert.equal(models.calls.length, 2);
});
test("invalid edits leave metadata, vector and history unchanged", async (t) => {
  const { app, store } = await fixture(t);
  const a = await app.ingest(
    await png(),
    { description: "猫" },
    source,
    app.signal,
  );
  const j = app.prepare([a.id]);
  app.jobs.resume(j.id);
  await until(() => store.job(j.id).state === "completed");
  const before = store.get(a.id),
    vector = store.vector(a.id);
  assert.throws(
    () => store.edit(a.id, a.revision, { description: "new", purposes: [] }),
    /用途/,
  );
  assert.deepEqual(store.get(a.id), before);
  assert.deepEqual(store.vector(a.id), vector);
  assert.equal(
    (store.db.prepare("SELECT count(*) n FROM history").get() as any).n,
    0,
  );
});
