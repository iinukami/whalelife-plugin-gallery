import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture, png, until, FakeModels } from "./helpers.ts";
const source = { kind: "local" as const, key: "synthetic-bulk" };

test("batch archive and restore preserve bytes, vectors, metadata and failed processing state", async (t) => {
  const models = new FakeModels();
  const { app, store } = await fixture(t, models);
  const assets = [];
  for (const color of ["#113355", "#446688", "#7799aa"])
    assets.push(
      await app.ingest(
        await png(color),
        { description: "猫", purposes: ["meme", "image"] },
        source,
        app.signal,
      ),
    );
  const job = app.prepare([assets[0].id]);
  app.jobs.resume(job.id);
  await until(() => store.job(job.id).state === "completed");
  store.markFailed(assets[1].id, "向量生成失败：模拟故障");
  const before = assets.map((a) => store.get(a.id));
  const bytes = await Promise.all(
    before.map((a) => readFile(store.path(a.id))),
  );
  const vector = store.vector(assets[0].id);
  const calls = models.calls.length;
  const archived = store.archiveMany(before.slice(0, 2), true);
  assert.equal(archived.changed, 2);
  assert.deepEqual(store.ids(), [assets[2].id]);
  assert.equal(store.get(assets[1].id).error, before[1].error);
  const restored = store.archiveMany(archived.assets, false);
  assert.equal(restored.changed, 2);
  for (const [i, a] of before.entries()) {
    assert.deepEqual(await readFile(store.path(a.id)), bytes[i]);
    assert.deepEqual(store.get(a.id).tags, a.tags);
    assert.deepEqual(store.get(a.id).purposes, a.purposes);
    assert.equal(store.get(a.id).indexState, a.indexState);
  }
  assert.deepEqual(store.vector(assets[0].id), vector);
  assert.equal(models.calls.length, calls);
  assert.equal(
    (await app.search("猫", "meme", 5, app.signal)).candidates[0].id,
    assets[0].id,
  );
  const revision = store.get(assets[0].id).revision;
  assert.equal(
    store.archiveMany([{ id: assets[0].id, revision }], false).changed,
    0,
  );
  assert.equal(store.get(assets[0].id).revision, revision);
});

test("a stale revision, missing ID, invalid or duplicate selection cannot partly archive a batch", async (t) => {
  const { app, store } = await fixture(t);
  const first = await app.ingest(await png(), {}, source, app.signal);
  const second = await app.ingest(await png("#123456"), {}, source, app.signal);
  store.edit(second.id, second.revision, { tags: ["刚修改"] });
  const originals = [store.get(first.id), store.get(second.id)];
  const history = () =>
    (store.db.prepare("SELECT count(*) n FROM history").get() as any).n;
  const count = history();
  const invalid = [
    [first, second],
    [first, { id: "f".repeat(64), revision: 1 }],
    [first, first],
    [],
    null,
    [first, { id: second.id, revision: "2" }],
    Array(201).fill(first),
  ];
  for (const input of invalid) {
    assert.throws(() => store.archiveMany(input, true));
    assert.deepEqual(
      originals.map((a) => store.get(a.id)),
      originals,
    );
    assert.equal(history(), count);
  }
  assert.throws(() => store.archiveMany([first], "true"));
  // An actual storage failure after the first update must roll the whole batch back.
  store.db.exec(
    `CREATE TRIGGER fail_second BEFORE UPDATE ON assets WHEN NEW.id='${second.id}' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`,
  );
  // save uses INSERT OR REPLACE, so cover that statement as well.
  store.db.exec(
    `CREATE TRIGGER fail_insert BEFORE INSERT ON assets WHEN NEW.id='${second.id}' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`,
  );
  assert.throws(
    () => store.archiveMany(originals, true),
    /synthetic write failure/,
  );
  assert.deepEqual(
    originals.map((a) => store.get(a.id)),
    originals,
  );
  assert.equal(history(), count);
});
