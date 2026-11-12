import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, png, FakeModels, until } from "./helpers.ts";
import { jobSummary } from "../src/jobs.ts";

const source = { kind: "local" as const, key: "fixture" };
for (const actor of ["user", "model"] as const) {
  test(`ordinary preparation preserves ${actor} classification; explicit recaption can replace it`, async (t) => {
    const models = new FakeModels();
    const { app, store } = await fixture(t, models);
    const asset = await app.ingest(await png(), {}, source, app.signal);
    const tags = actor === "user" ? ["人工标签"] : [];
    store.edit(asset.id, asset.revision, { tags, purposes: ["image"] }, actor);
    const ordinary = app.prepare([asset.id]);
    app.jobs.resume(ordinary.id);
    await until(() => store.job(ordinary.id).state === "completed");
    assert.deepEqual(store.get(asset.id).tags, tags);
    assert.deepEqual(store.get(asset.id).purposes, ["image"]);
    assert.equal(store.get(asset.id).description, "猫在打招呼");
    assert.equal(store.get(asset.id).indexState, "ready");
    assert.equal(
      (await app.search("猫", "image", 5, app.signal)).candidates[0].id,
      asset.id,
    );

    const explicit = app.prepare([asset.id], true);
    app.jobs.resume(explicit.id);
    await until(() => store.job(explicit.id).state === "completed");
    assert.deepEqual(store.get(asset.id).tags, ["猫"]);
    assert.deepEqual(store.get(asset.id).purposes, ["meme"]);
    assert.equal(models.captions, 2);
  });
}

test("an edit while captioning cannot be overwritten by the late caption", async (t) => {
  let release!: () => void;
  let started = false;
  class SlowCaption extends FakeModels {
    override async caption(bytes: Buffer, signal: AbortSignal) {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return super.caption(bytes, signal);
    }
  }
  const { app, store } = await fixture(t, new SlowCaption());
  const asset = await app.ingest(await png(), {}, source, app.signal);
  const job = app.prepare([asset.id]);
  app.jobs.resume(job.id);
  await until(() => started);
  store.edit(asset.id, asset.revision, {
    description: "用户刚写的描述",
    tags: ["保留"],
  });
  release();
  await until(() => store.job(job.id).state === "errors");
  assert.equal(store.get(asset.id).description, "用户刚写的描述");
  assert.deepEqual(store.get(asset.id).tags, ["保留"]);
  assert.equal(store.get(asset.id).error, "");
  assert.equal(store.vector(asset.id), undefined);
});

test("historical job failures identify the image and distinguish recovery from a later invalidated vector", async (t) => {
  const { app, store } = await fixture(t);
  const asset = await app.ingest(
    await png(),
    { description: "猫" },
    source,
    app.signal,
  );
  const failed = app.prepare([asset.id]);
  failed.state = "errors";
  failed.items[0].status = "failed";
  failed.items[0].error = "向量生成失败：模拟模型暂不可用";
  store.saveJob(failed);
  store.markFailed(asset.id, failed.items[0].error);
  let summary = jobSummary(store.job(failed.id), store);
  assert.equal(summary.unresolvedFailed, 1);
  assert.equal(summary.errors[0].indexState, "failed");
  const retry = app.prepare([asset.id]);
  app.jobs.resume(retry.id);
  await until(() => store.job(retry.id).state === "completed");
  summary = jobSummary(store.job(failed.id), store);
  assert.equal(summary.state, "errors");
  assert.equal(summary.failed, 1);
  assert.equal(summary.unresolvedFailed, 0);
  assert.equal(summary.resolvedFailed, 1);
  assert.equal(summary.errors[0].assetId, asset.id);
  assert.equal(summary.errors[0].resolved, true);
  assert.equal(summary.errors[0].indexState, "ready");
  store.edit(asset.id, store.get(asset.id).revision, {
    description: "重新整理",
  });
  summary = jobSummary(store.job(failed.id), store);
  assert.equal(summary.unresolvedFailed, 1);
  assert.equal(summary.errors[0].resolved, false);
  assert.equal(summary.errors[0].indexState, "pending");
});
