/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { mkdir, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import sharp from "sharp";
import { boot } from "../../whalelife/core/index.ts";
import { Store, hash, indexText } from "../src/store.ts";
import { inspectImage } from "../src/media.ts";
const root = fileURLToPath(new URL("../", import.meta.url)),
  base = join(root, ".artifacts", "tests");
let dir, app, store;
try {
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "gallery-preview-"));
  await mkdir(join(dir, "config"));
  await mkdir(join(dir, "plugins"));
  await cp(join(root, "dist/gallery"), join(dir, "plugins/gallery"), {
    recursive: true,
  });
  await writeFile(
    join(dir, "config/config.json"),
    JSON.stringify({
      log: { level: "error" },
      web: { port: 0 },
      memory: { root: "memory" },
      providers: [],
      models: [],
      personas: {},
      channels: { web: { persona: "default" } },
    }),
  );
  store = new Store(join(dir, "plugins/gallery/data"));
  const samples = [
    ["#2e7067", "今天也要开心", "meme"],
    ["#e0aa4d", "先喝杯茶冷静一下", "meme"],
    ["#7182ba", "有点无语，但又想笑", "meme"],
    ["#e3bca1", "周末散步留下的照片", "image"],
    ["#5a9da0", "界面设计草图", "image"],
    ["#8da77d", "绿色植物插画", "image"],
  ];
  for (let i = 0; i < samples.length; i++) {
    const [color, description, purpose] = samples[i];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${color}"/><circle cx="200" cy="130" r="66" fill="#ffffff" fill-opacity=".85"/><circle cx="180" cy="120" r="6" fill="${color}"/><circle cx="220" cy="120" r="6" fill="${color}"/><path d="M170 145 Q200 175 230 145" fill="none" stroke="${color}" stroke-width="6"/><text x="200" y="250" text-anchor="middle" font-size="18" fill="white">GALLERY · ${i + 1}</text></svg>`;
    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
    store.add(
      bytes,
      await inspectImage(bytes),
      { description, tags: ["演示素材"], purposes: [purpose] },
      { kind: "local", key: "isolated-preview" },
    );
  }
  store.close();
  store = undefined;
  app = await boot(dir);
  const url = `http://127.0.0.1:${app.web.server.address().port}`;
  await writeFile(
    join(root, ".artifacts", "preview.json"),
    JSON.stringify({ url, dir, pid: process.pid }),
  );
  console.log(url);
  const lines = createInterface({ input: process.stdin });
  await new Promise((resolve) => {
    lines.on("line", (line) => {
      if (line === "stop") {
        lines.close();
        process.stdin.pause();
        resolve();
      }
    });
    lines.on("close", resolve);
  });
} finally {
  store?.close();
  await app?.close();
  if (dir && dirname(resolve(dir)) === resolve(base))
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  await rm(join(root, ".artifacts", "preview.json"), { force: true });
  console.log("Preview closed and owned temporary data removed.");
}
