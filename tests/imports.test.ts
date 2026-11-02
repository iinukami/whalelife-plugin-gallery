import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { DatabaseSync } from "node:sqlite";
import { fixture, png, until, FakeModels } from "./helpers.ts";
import {
  planFolder,
  planGitHub,
  extractZip,
  backupStream,
  safeRelative,
} from "../src/imports.ts";
import { Store, hash } from "../src/store.ts";

test("Astr import inherits captions, categories and BOM metadata without changing source or calling models", async (t) => {
  const model = new FakeModels(),
    { dir, app, store } = await fixture(t, model);
  const source = join(dir, "astr", "pack");
  await mkdir(join(source, "memes", "happy"), { recursive: true });
  const image = await png();
  await writeFile(join(source, "memes", "happy", "cat.png"), image);
  const metadata =
    "\uFEFF" +
    JSON.stringify({
      images: {
        key: {
          relative_path: "memes/happy/cat.png",
          content_sha256: hash(image),
          category: "happy",
          caption: "猫打招呼",
          tags: ["开心"],
        },
      },
    });
  await writeFile(join(source, "semantic_metadata.json"), metadata);
  await writeFile(
    join(source, "index_manifest.json"),
    JSON.stringify({
      embedding_model: "old",
      embedding_dimension: 1024,
      index_file: "index-test.faiss",
    }),
  );
  const plan = await planFolder(source, app.signal, "astr");
  assert.equal(plan.warnings.length, 1);
  const result = app.startImport(plan);
  await until(() => store.job(result.job.id).state === "completed");
  const a = store.get(hash(image));
  assert.equal(a.description, "猫打招呼");
  assert.deepEqual(a.purposes, ["meme"]);
  assert.deepEqual(a.tags, ["开心", "happy"]);
  assert.equal(model.calls.length, 0);
  assert.equal(model.captions, 0);
  assert.equal(
    await readFile(join(source, "semantic_metadata.json"), "utf8"),
    metadata,
  );
});
test("backup restores vectors, original image bytes, archive and edit provenance; corrupt backup fails before merge", async (t) => {
  const { dir, app, store } = await fixture(t);
  let a = await app.ingest(
    await png(),
    { description: "猫", purposes: ["meme"] },
    { kind: "local", key: "source" },
    app.signal,
  );
  const j = app.prepare([a.id]);
  app.jobs.resume(j.id);
  await until(() => store.job(j.id).state === "completed");
  a = store.edit(a.id, a.revision, { archived: true });
  const zipfile = join(dir, "backup.zip");
  await pipeline(backupStream(store).outputStream, createWriteStream(zipfile));
  const extracted = join(dir, "unpacked");
  await extractZip(zipfile, extracted, app.signal);
  const plan = await planFolder(extracted, app.signal);
  const other = new Store(join(dir, "other"));
  // Use same import path on an independent library.
  const { Gallery } = await import("../src/runtime.ts");
  const runtime = new Gallery(
    other,
    new FakeModels(),
    () => ({
      schemaVersion: 1,
      visionModelId: "",
      embeddingModelId: "",
      topK: 5,
      allowOriginals: false,
    }),
    new AbortController().signal,
  );
  try {
    const importJob = runtime.startImport(plan);
    await until(() => other.job(importJob.job.id).state === "completed");
    assert.equal(other.get(a.id).archived, true);
    assert.deepEqual(other.vector(a.id), store.vector(a.id));
    assert.deepEqual(other.get(a.id).edited, a.edited);
    assert.deepEqual(
      await readFile(other.path(a.id)),
      await readFile(store.path(a.id)),
    );
  } finally {
    await runtime.stop();
  }
  const recordPath = join(extracted, "metadata", a.id + ".json");
  const recordText = await readFile(recordPath, "utf8");
  const malformed = JSON.parse(recordText);
  malformed.asset.sources = [null];
  await writeFile(recordPath, JSON.stringify(malformed));
  await assert.rejects(planFolder(extracted, app.signal), /元信息无效/);
  await writeFile(recordPath, recordText);
  await writeFile(join(extracted, "objects", a.id), "corrupt");
  await assert.rejects(planFolder(extracted, app.signal), /校验失败/);
  assert.equal(store.get(a.id).archived, true);
});

test("backup failure rolls back metadata, vector and object so retry restores the full record", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  const bytes = await png();
  const a = await source.app.ingest(
    bytes,
    { description: "猫", purposes: ["meme"] },
    { kind: "local", key: "test" },
    source.app.signal,
  );
  const j = source.app.prepare([a.id]);
  source.app.jobs.resume(j.id);
  await until(() => source.store.job(j.id).state === "completed");
  const record = {
    asset: source.store.get(a.id),
    vector: source.store.vector(a.id),
    history: [{ assetId: a.id, json: JSON.stringify(a) }],
  };
  target.store.db.exec(
    "CREATE TRIGGER fail_vector BEFORE INSERT ON vectors BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;",
  );
  assert.throws(
    () =>
      target.store.importBackup(bytes, a, record, {
        kind: "backup",
        key: "test",
      }),
    /simulated write failure/,
  );
  assert.equal(target.store.has(a.id), false);
  assert.equal(existsSync(target.store.path(a.id)), false);
  assert.equal(
    target.store.db.prepare("SELECT count(*) n FROM history").get()!.n,
    0,
  );
  target.store.db.exec("DROP TRIGGER fail_vector");
  target.store.importBackup(bytes, a, record, { kind: "backup", key: "test" });
  assert.deepEqual(target.store.vector(a.id), record.vector);
  assert.equal(
    target.store.db.prepare("SELECT count(*) n FROM history").get()!.n,
    1,
  );
});

test("completed staged import removes only its own staging directory and never calls models", async (t) => {
  const { app, store, models } = await fixture(t);
  const id = randomUUID(),
    owned = join(store.root, "incoming", id),
    sibling = join(store.root, "incoming", randomUUID());
  await mkdir(join(owned, "contents"), { recursive: true });
  await mkdir(sibling);
  await writeFile(join(sibling, "keep.txt"), "keep");
  await writeFile(join(owned, "contents", "sample.png"), await png());
  const plan = await planFolder(join(owned, "contents"), app.signal);
  plan.options.staging = id;
  const result = app.startImport(plan);
  await until(
    () => store.job(result.job.id).state === "completed" && !existsSync(owned),
  );
  assert.equal(await readFile(join(sibling, "keep.txt"), "utf8"), "keep");
  assert.equal(store.list().total, 1);
  assert.equal((models as FakeModels).calls.length, 0);
});
test("ZIP imports images and metadata only, skips executable content and rejects unsafe paths", async (t) => {
  const { dir, app } = await fixture(t);
  for (const name of [
    "../x.png",
    "C:/x.png",
    "a\\x.png",
    "/tmp/x.png",
    "a/./x",
  ])
    assert.throws(() => safeRelative(name), /不安全/);
  const z = new yazl.ZipFile();
  z.addBuffer(await png(), "pack/memes/happy/a.png");
  z.addBuffer(Buffer.from("never run"), "pack/install.ps1");
  z.end();
  const file = join(dir, "pack.zip");
  await pipeline(z.outputStream, createWriteStream(file));
  const out = join(dir, "out");
  await extractZip(file, out, app.signal);
  assert.ok(await readFile(join(out, "pack/memes/happy/a.png")));
  await assert.rejects(readFile(join(out, "pack/install.ps1")));
});
test("database newer schema is preserved and rejected instead of reset", async (t) => {
  const { dir } = await fixture(t);
  const path = join(dir, "future");
  await mkdir(path);
  const db = new DatabaseSync(join(path, "gallery.sqlite"));
  db.exec(
    "CREATE TABLE sentinel(v TEXT); INSERT INTO sentinel VALUES('keep'); PRAGMA user_version=99;",
  );
  db.close();
  assert.throws(() => new Store(path), /版本较新/);
  const check = new DatabaseSync(join(path, "gallery.sqlite"));
  try {
    assert.equal(
      (check.prepare("SELECT v FROM sentinel").get() as any).v,
      "keep",
    );
  } finally {
    check.close();
  }
});
test("GitHub planning pins actual commit, preserves author/license and never plans scripts or symlinks", async () => {
  const sha = "a".repeat(40),
    seen: string[] = [];
  const download: any = async (url: string) => {
    seen.push(url);
    let value: any;
    if (url.endsWith("/repos/example/pack"))
      value = {
        default_branch: "main",
        owner: { login: "author" },
        license: { spdx_id: "CC-BY-4.0" },
      };
    else if (url.includes("/commits/")) value = { sha };
    else if (url.includes("/git/trees/"))
      value = {
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644" },
          {
            path: "memes/happy/cat.png",
            type: "blob",
            mode: "100644",
            size: 100,
          },
          { path: "run.js", type: "blob", mode: "100644" },
          { path: "link.png", type: "blob", mode: "120000" },
        ],
      };
    else
      value = {
        schema_version: 1,
        author: "pack-author",
        license: "MIT",
        version: "1.2",
        categories: { happy: { description: "开心" } },
      };
    return Buffer.from(JSON.stringify(value));
  };
  const plan = await planGitHub(
    "https://github.com/example/pack",
    "main",
    "",
    new AbortController().signal,
    download,
  );
  assert.equal(plan.items.length, 1);
  assert.equal(plan.options.ref, sha);
  assert.match(plan.items[0].metadata.url, new RegExp(sha));
  assert.equal(plan.items[0].metadata.author, "pack-author");
  assert.equal(plan.items[0].metadata.license, "MIT");
  assert.ok(seen.some((x) => x.includes("/commits/main")));
});
