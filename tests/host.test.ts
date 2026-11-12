import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, cp, symlink, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { temporary, root, png } from "./helpers.ts";

const host = resolve(root, "../whalelife");
for (const baseline of ["current", "213b52b"])
  test(`installed build on ${baseline}: isolation, UI, tools, providers, pause, reload and no automatic sessions`, async (t) => {
    const { dir, cleanup } = await temporary(t);
    let source = host;
    if (baseline !== "current") {
      source = join(dir, "host");
      await mkdir(source);
      const archive = join(dir, "host.tar");
      const git = spawnSync(
        "git",
        [
          "-C",
          host,
          "archive",
          "--format=tar",
          "--output=" + archive,
          baseline,
          "core",
          "package.json",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      assert.equal(git.status, 0, git.stderr);
      const tar = spawnSync("tar", ["-xf", archive, "-C", source], {
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(tar.status, 0, tar.stderr);
      await symlink(
        join(host, "node_modules"),
        join(source, "node_modules"),
        "junction",
      );
    }
    const modelCalls: any[] = [];
    let failEmbedding = false;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const b of req) raw += b;
      const body = JSON.parse(raw);
      modelCalls.push(body);
      if (failEmbedding && req.url?.endsWith("/embeddings")) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "synthetic unavailable" }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url?.endsWith("/embeddings")
            ? { data: [{ embedding: [1, 0] }], usage: { total_tokens: 4 } }
            : {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        description: "猫在打招呼",
                        tags: ["猫"],
                        purposes: ["meme"],
                      }),
                    },
                  },
                ],
                usage: { total_tokens: 8 },
              },
        ),
      );
    });
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const run = join(dir, "runtime");
    await mkdir(join(run, "config"), { recursive: true });
    await mkdir(join(run, "plugins"), { recursive: true });
    await cp(join(root, "dist/gallery"), join(run, "plugins/gallery"), {
      recursive: true,
    });
    for (const consumer of ["platform-a", "platform-b"]) {
      const p = join(run, "plugins", consumer);
      await mkdir(p);
      await writeFile(
        join(p, "plugin.yaml"),
        `id: ${consumer}\nname: Mock consumer\nversion: 1.0.0\ndescription: Test only\napiVersion: "1.0.0"\ndepends: [gallery]\n`,
      );
      await writeFile(
        join(p, "index.ts"),
        `export function apply(ctx){const gallery=ctx.get('gallery');ctx.provide('${consumer}',{read:async(id)=>{const media=await gallery.readMedia(id);return {id:media.id,mime:media.mime,bytes:Buffer.from(media.base64,'base64').length};}});}`,
      );
    }
    await writeFile(
      join(run, "config/config.json"),
      JSON.stringify({
        log: { level: "error" },
        web: { port: 0 },
        providers: [
          {
            id: "mock",
            name: "Mock",
            protocol: "openai-compatible",
            base_url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
            api_key: "synthetic-test-secret",
          },
        ],
        models: [
          {
            id: "vision",
            provider: "mock",
            name: "Vision",
            model: "alias",
            type: "chat",
            enabled: true,
          },
          {
            id: "embedding",
            provider: "mock",
            name: "Embedding",
            model: "fake-embed",
            type: "embedding",
            enabled: true,
            dimensions: 2,
          },
        ],
        model_bindings: { chat: "vision" },
        personas: {
          a: { name: "A", file: "a.md", model: "vision", permission: "full" },
        },
        channels: { web: { persona: "a", permission: "full" } },
        memory: { root: "memory" },
      }),
    );
    const { boot } = await import(
      pathToFileURL(join(source, "core/index.ts")).href
    );
    const app = await boot(run);
    cleanup.push(() => app.close());
    assert.equal(app.runtime.records.get("gallery")?.status, "active");
    const url = `http://127.0.0.1:${app.web.server.address().port}`;
    const login = await fetch(url + "/api/login", {
      method: "POST",
      body: "{}",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const request = (path: string, body?: any) =>
      fetch(url + "/plugins/gallery/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    assert.equal((await fetch(url + "/plugins/gallery/state")).status, 401);
    let state = (await (await request("state")).json()) as any;
    assert.ok(state.config, JSON.stringify(state));
    assert.equal(state.config.allowOriginals, false);
    assert.ok(!JSON.stringify(state).includes("synthetic-test-secret"));
    assert.equal(Object.keys(await app.memory.listSessionMeta()).length, 0);
    assert.match(await (await request("settings")).text(), /留住想用的那张图/);
    const saved = await request("action", {
      action: "config",
      revision: state.revision,
      config: {
        schemaVersion: 1,
        visionModelId: "vision",
        embeddingModelId: "embedding",
        topK: 5,
        allowOriginals: false,
      },
    });
    assert.equal(saved.status, 200, await saved.text());
    const service = app.runtime.services.get("gallery").value;
    const sessionId = await app.sessions.create("isolated gallery test");
    const offer = await service.offerMedia({
      sessionId,
      base64: (await png()).toString("base64"),
      source: "mock-platform",
    });
    const collected = await app.tools.call(
      "gallery_collect",
      { mediaRef: offer.mediaRef },
      { id: sessionId, permission: "full" },
    );
    assert.equal(collected.ok, true, JSON.stringify(collected));
    assert.equal(collected.result.ok, true, JSON.stringify(collected));
    const id = collected.result.asset.id;
    for (let n = 0; n < 80; n++) {
      state = await (await request("state")).json();
      if (state.jobs[0]?.state === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(state.jobs[0]?.state, "completed", JSON.stringify(state.jobs));
    const found = await app.tools.call(
      "gallery_search",
      { query: "开心", purpose: "meme" },
      { permission: "full" },
    );
    assert.equal(found.result.candidates[0].id, id);
    assert.ok(!JSON.stringify(found).includes("base64"));
    const refused = await app.tools.call(
      "gallery_collect",
      { mediaRef: offer.mediaRef },
      { id: "session-fixture", permission: "off" },
    );
    assert.equal(refused.ok, false);
    const media = await service.readMedia(id);
    assert.equal(media.mime, "image/png");
    assert.deepEqual(Buffer.from(media.base64, "base64"), await png());
    for (const consumer of ["platform-a", "platform-b"])
      assert.deepEqual(
        await app.runtime.services.get(consumer).value.read(id),
        { id, mime: "image/png", bytes: (await png()).length },
      );
    assert.equal(
      (await request("image?id=" + id)).headers.get("content-type"),
      "image/png",
    );
    assert.equal((await request("action", { action: "read", id })).status, 200);
    // Exercise the other entry point too: upload remains manual, then a
    // preparation failure recovers in a new job without falsifying old history.
    const beforeUpload = modelCalls.length;
    const upload = await fetch(
      url + "/plugins/gallery/upload?name=synthetic.png",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: await png("#223344"),
      },
    );
    assert.equal(upload.status, 200);
    const uploaded = ((await upload.json()) as any).asset;
    assert.equal(uploaded.indexState, "pending");
    assert.equal(modelCalls.length, beforeUpload);
    const waitJob = async (jobId: string, expected: string) => {
      for (let n = 0; n < 80; n++) {
        const snapshot = (await (await request("state")).json()) as any;
        const job = snapshot.jobs.find((j: any) => j.id === jobId);
        if (job?.state === expected) return job;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("Job did not reach " + expected);
    };
    failEmbedding = true;
    const failedJob = (await (
      await request("action", { action: "prepare", ids: [uploaded.id] })
    ).json()) as any;
    await waitJob(failedJob.id, "errors");
    let historical = await app.tools.call(
      "gallery_job",
      { id: failedJob.id },
      { permission: "full" },
    );
    assert.equal(historical.result.unresolvedFailed, 1);
    assert.equal(historical.result.errors[0].assetId, uploaded.id);
    assert.match(historical.result.errors[0].error, /向量生成失败.*503/);
    failEmbedding = false;
    const recovered = (await (
      await request("action", { action: "prepare", ids: [uploaded.id] })
    ).json()) as any;
    await waitJob(recovered.id, "completed");
    historical = await app.tools.call(
      "gallery_job",
      { id: failedJob.id },
      { permission: "full" },
    );
    assert.equal(historical.result.state, "errors");
    assert.equal(historical.result.failed, 1);
    assert.equal(historical.result.unresolvedFailed, 0);
    assert.equal(historical.result.resolvedFailed, 1);
    assert.equal(historical.result.errors[0].resolved, true);
    assert.equal(historical.result.errors[0].indexState, "ready");
    assert.equal(historical.result.errors[0].description, "猫在打招呼");
    assert.ok(!JSON.stringify(historical).includes(run));
    await app.runtime.action("gallery", "stop");
    assert.equal((await request("settings")).status, 404);
    assert.ok(
      !app.tools.list().some((x: any) => x.function.name === "gallery_search"),
    );
    await assert.rejects(service.readMedia(id));
    const sessionsBeforeRestart = Object.keys(
      await app.memory.listSessionMeta(),
    ).length;
    await app.runtime.action("gallery", "start");
    state = await (await request("state?purpose=meme")).json();
    assert.ok(state.items.some((item: any) => item.id === id));
    assert.equal(state.config.embeddingModelId, "embedding");
    assert.equal(
      Object.keys(await app.memory.listSessionMeta()).length,
      sessionsBeforeRestart,
    );
    assert.ok(modelCalls.length >= 3);
    // The host directory was only a source; all runtime data remains inside this test's owned directory.
    assert.equal(
      JSON.parse(
        await readFile(join(run, "plugins/gallery/data/config.json"), "utf8"),
      ).visionModelId,
      "vision",
    );
  });
