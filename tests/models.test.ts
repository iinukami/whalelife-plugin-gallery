import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Models, embeddingSpace } from "../src/models.ts";
import { defaults } from "../src/types.ts";
import { publicIP, publicURL, pinnedLookup } from "../src/network.ts";
import { Agent, fetch } from "undici";
import { png, temporary } from "./helpers.ts";
import type { ModelConnection } from "whalelife";

test("explicit model configurations drive embedding and vision; no credentials in safe failures", async (t) => {
  const { cleanup } = await temporary(t);
  const calls: any[] = [];
  let visionPurposes: unknown = "meme";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    calls.push({
      url: req.url,
      body: JSON.parse(body),
      auth: req.headers.authorization,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.endsWith("/embeddings")
          ? { data: [{ embedding: [1, 0] }], usage: { total_tokens: 3 } }
          : {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      description: "猫",
                      tags: ["开心"],
                      purposes: visionPurposes,
                    }),
                  },
                },
              ],
              usage: { total_tokens: 20 },
            },
      ),
    );
  });
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const c: ModelConnection = {
    id: "selected",
    name: "alias",
    model: "custom-name",
    type: "embedding",
    provider_id: "p",
    provider_name: "test",
    protocol: "openai-compatible",
    base_url: endpoint,
    api_key: "fake-secret",
    proxy_url: "",
    timeout_seconds: 5,
    parameters: {},
    dimensions: 2,
    context_window: null,
  };
  const config = {
    ...defaults,
    embeddingModelId: "embedding-id",
    visionModelId: "vision-id",
  };
  const usage: any[] = [];
  const api = {
    list: () => [],
    connection: (id: string) => {
      assert.ok(["embedding-id", "vision-id"].includes(id));
      return {
        ...c,
        type: id === "vision-id" ? ("chat" as const) : ("embedding" as const),
      };
    },
  };
  const model = new Models(
    api,
    () => config,
    (...a) => usage.push(a),
  );
  const result = await model.embed("猫", new AbortController().signal);
  assert.deepEqual(result.values, [1, 0]);
  assert.equal(calls[0].body.model, "custom-name");
  assert.equal(calls[0].auth, "Bearer fake-secret");
  const caption = await model.caption(
    await png(),
    new AbortController().signal,
  );
  assert.equal(caption.description, "猫");
  assert.deepEqual(caption.purposes, ["meme"]);
  assert.ok(
    calls[1].body.messages[1].content.some((x: any) => x.type === "image_url"),
  );
  assert.equal(usage.length, 2);
  assert.equal(
    embeddingSpace(c),
    embeddingSpace({ ...c, id: "another-id", api_key: "different-key" }),
  );
  assert.notEqual(
    embeddingSpace(c),
    embeddingSpace({ ...c, model: "changed" }),
  );
  for (const [value, expected] of [
    [
      ["meme", "image"],
      ["meme", "image"],
    ],
    [["表情包"], ["meme"]],
    ["image", ["image"]],
    [[], undefined],
    [["not-a-purpose"], undefined],
    [null, undefined],
  ] as const) {
    visionPurposes = value;
    const parsed = await model.caption(
      await png(),
      new AbortController().signal,
    );
    assert.equal(parsed.description, "猫");
    assert.deepEqual(parsed.purposes, expected);
  }
});
test("public image collection rejects local addresses and selected model request honors cancellation", async (t) => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(publicIP(ip), false);
  assert.equal(publicIP("8.8.8.8"), true);
  await assert.rejects(publicURL("http://127.0.0.1/x.png"), /内网/);
  const { cleanup } = await temporary(t);
  const sockets = new Set<any>();
  let received = false;
  const server = createServer((_req, _res) => {
    received = true;
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  cleanup.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((r) => server.close(() => r()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const c: any = {
    id: "e",
    model: "fake",
    type: "embedding",
    protocol: "openai-compatible",
    base_url: `http://127.0.0.1:${(server.address() as any).port}`,
    timeout_seconds: 5,
    parameters: {},
    dimensions: 2,
  };
  const model = new Models(
    { list: () => [], connection: () => c },
    () => ({ ...defaults, embeddingModelId: "e" }),
    () => {},
  );
  const controller = new AbortController();
  const pending = model.embed("test", controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending);
  assert.ok(received);
});

test("pinned DNS downloads use Node 24 automatic-family lookup without a second DNS resolution", async (t) => {
  const { cleanup } = await temporary(t);
  const bytes = await png();
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.end(bytes);
  });
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const lookup = pinnedLookup([{ address: "127.0.0.1", family: 4 }]);
  const shapes: boolean[] = [];
  const agent = new Agent({
    connect: {
      autoSelectFamily: true,
      lookup: (host, options, callback) => {
        shapes.push(options.all === true);
        lookup(host, options, callback);
      },
    },
  });
  cleanup.push(() => agent.destroy());
  const response = await fetch(
    `http://gallery-dns-test.invalid:${(server.address() as any).port}/image`,
    { dispatcher: agent },
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.ok(shapes.includes(true));
  lookup("ignored.invalid", { all: false }, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, "127.0.0.1");
    assert.equal(family, 4);
  });
});
