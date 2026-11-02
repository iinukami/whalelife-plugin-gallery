import type { Context, PluginHandler, ToolSession } from "whalelife";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { readFile, mkdir, rm } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Store, hash } from "./store.ts";
import { Models } from "./models.ts";
import { Gallery } from "./runtime.ts";
import { jobSummary } from "./jobs.ts";
import {
  planFolder,
  planGitHub,
  extractZip,
  backupStream,
  sizeLimiter,
} from "./imports.ts";
import {
  configOf,
  defaults,
  errorResult,
  object,
  text,
  fail,
  MAX_IMAGE,
  MAX_ARCHIVE,
  candidate,
  type Config,
  type Purpose,
  type ItemInput,
} from "./types.ts";
import { inspectImage } from "./media.ts";

const base = "/plugins/gallery";
export async function apply(ctx: Context) {
  let gallery: Gallery | undefined;
  let store: Store | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let config: Config = { ...defaults },
    configError = "";
  let configChanges = Promise.resolve();
  ctx.effect(() => async () => {
    if (timer) clearInterval(timer);
    await configChanges.catch(() => {});
    if (gallery) await gallery.stop();
    else store?.close();
  });
  try {
    config = configOf(await ctx.config.read());
  } catch (e) {
    configError = errorResult(e).error;
  }
  ctx.signal.throwIfAborted();
  const root = fileURLToPath(new URL("../data/", import.meta.url));
  store = new Store(root);
  const models = new Models(
    ctx.models,
    () => config,
    (...args) => store!.usage(...args),
  );
  const app = (gallery = new Gallery(store, models, () => config, ctx.signal));
  timer = setInterval(() => {
    try {
      if (!ctx.signal.aborted) store!.expireOffers();
    } catch {
      ctx.logger.warn("图库临时媒体清理未完成。");
    }
  }, 60_000);
  timer.unref();
  const wrap =
    (handler: PluginHandler): PluginHandler =>
    async (req, res, { signal }) => {
      try {
        await app.operation(async (combined) => {
          await handler(req, res, { signal: combined });
        }, signal);
      } catch (e) {
        if (!res.headersSent) {
          res.statusCode = (e as any)?.code === "conflict" ? 409 : 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(errorResult(e)));
        } else res.destroy();
      }
    };
  const json = (res: any, value: any) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(value));
  };
  async function body(req: NodeJS.ReadableStream, signal: AbortSignal) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as any) {
      signal.throwIfAborted();
      const b = Buffer.from(chunk);
      size += b.length;
      if (size > 1024 * 1024) fail("too_large", "请求过大。");
      chunks.push(b);
    }
    try {
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      fail("invalid", "请求 JSON 无效。");
    }
  }
  for (const [path, file, type] of [
    ["settings", "page.html", "text/html"],
    ["app.js", "page.js", "text/javascript"],
    ["style.css", "page.css", "text/css"],
  ])
    ctx.web.page(
      base + "/" + path,
      wrap(async (_req, res) => {
        res.setHeader("Content-Type", type + "; charset=utf-8");
        res.end(await readFile(new URL(file, import.meta.url)));
      }),
      path === "settings"
        ? { title: "图库", settings: true, navigation: true }
        : undefined,
    );
  ctx.web.page(
    base + "/state",
    wrap(async (req, res) => {
      const u = new URL(req.url!, "http://local");
      const purpose = u.searchParams.get("purpose");
      const list = store!.list({
        purpose:
          purpose === "meme" || purpose === "image" ? purpose : undefined,
        archived: u.searchParams.get("archived") === "true",
        offset: Number(u.searchParams.get("offset")) || 0,
        query: (u.searchParams.get("query") ?? "").slice(0, 200),
      });
      json(res, {
        config,
        revision: hash(JSON.stringify(config)),
        configError,
        models: ctx.models.list(),
        ...list,
        stats: store!.stats(),
        jobs: store!
          .jobs()
          .slice(0, 100)
          .map((j) => jobSummary(j, store!)),
        capabilities: { candidateImages: false, platformDelivery: false },
        limits: { maxImageMiB: 25, maxZipMiB: 1024 },
      });
    }),
  );
  ctx.web.page(
    base + "/image",
    wrap(async (req, res, { signal }) => {
      const u = new URL(req.url!, "http://local"),
        id = u.searchParams.get("id") ?? "";
      const a = store!.get(id);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=3600");
      if (u.searchParams.get("preview") === "1") {
        const bytes = await app.preview(id, signal);
        res.setHeader("Content-Type", "image/webp");
        res.end(bytes);
      } else {
        res.setHeader("Content-Type", a.mime);
        await pipeline(createReadStream(store!.path(id)), res, { signal });
      }
    }),
  );
  ctx.web.api(
    base + "/upload",
    wrap(async (req, res, { signal }) => {
      if (req.method !== "POST") fail("method", "请使用 POST 上传。");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        signal.throwIfAborted();
        length += chunk.length;
        if (length > MAX_IMAGE) fail("too_large", "图片超过 25 MiB。");
        chunks.push(Buffer.from(chunk));
      }
      const name = (
        new URL(req.url!, "http://local").searchParams.get("name") ?? "上传图片"
      ).slice(0, 300);
      const a = await app.ingest(
        Buffer.concat(chunks),
        {},
        { kind: "local", key: "upload", path: name },
        signal,
      );
      json(res, { ok: true, asset: a });
    }),
  );
  ctx.web.api(
    base + "/zip",
    wrap(async (req, res, { signal }) => {
      if (req.method !== "POST") fail("method", "请使用 POST 上传。");
      const id = randomUUID(),
        owned = join(root, "incoming", id),
        file = join(owned, "upload.zip"),
        folder = join(owned, "contents");
      let keep = false;
      try {
        await mkdir(owned, { recursive: true });
        await pipeline(
          req,
          sizeLimiter(MAX_ARCHIVE),
          createWriteStream(file, { flags: "wx" }),
          { signal },
        );
        await extractZip(file, folder, signal);
        await rm(file);
        const plan = await planFolder(folder, signal);
        plan.options.staging = id;
        const result = app.startImport(plan);
        keep = true;
        json(res, result);
      } finally {
        if (!keep && dirname(resolve(owned)) === resolve(root, "incoming"))
          await rm(owned, { recursive: true, force: true });
      }
    }),
  );
  ctx.web.page(
    base + "/backup",
    wrap(async (req, res, { signal }) => {
      if (req.method !== "GET") fail("method", "请使用 GET。");
      const zip = backupStream(store!);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="whalelife-gallery.zip"',
      );
      await pipeline(zip.outputStream, res, { signal });
    }),
  );
  ctx.web.api(
    base + "/action",
    wrap(async (req, res, { signal }) => {
      if (req.method !== "POST") fail("method", "请使用 POST。");
      const x = await body(req, signal);
      let result: any;
      switch (x.action) {
        case "config": {
          const next = configOf(x.config);
          for (const [kind, id] of [
            ["vision", next.visionModelId],
            ["embedding", next.embeddingModelId],
          ])
            if (id) {
              const c = ctx.models.connection(id);
              if (kind === "embedding" && c.type !== "embedding")
                fail("model_type", "请选择向量模型配置。");
            }
          const work = configChanges.then(async () => {
            signal.throwIfAborted();
            if (x.revision !== hash(JSON.stringify(config)))
              fail("conflict", "设置已变化，请刷新。");
            await ctx.config.save("config.json", next);
            config = next;
            configError = "";
          });
          configChanges = work.catch(() => {});
          await work;
          result = { ok: true };
          break;
        }
        case "read":
          result = { asset: store!.get(text(x.id, 64, false)) };
          break;
        case "edit":
          result = app.edit(
            text(x.id, 64, false),
            Number(x.revision),
            object(x.patch),
            "user",
          );
          break;
        case "prepare": {
          const ids = x.ids === undefined ? store!.ids() : x.ids;
          if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string"))
            fail("invalid", "图片列表无效。");
          const j = app.prepare(ids, x.forceCaption === true);
          result = app.jobs.resume(j.id);
          break;
        }
        case "pause":
          result = app.jobs.pause(text(x.id, 80, false));
          break;
        case "resume":
          result = app.jobs.resume(text(x.id, 80, false), x.retry === true);
          break;
        case "folder":
          result = app.startImport(
            await planFolder(
              text(x.path, 1000, false),
              signal,
              x.kind === "astr" ? "astr" : "local",
            ),
          );
          break;
        case "github":
          result = app.startImport(
            await planGitHub(
              text(x.repository, 500, false),
              text(x.ref ?? "", 200),
              text(x.subpath ?? "", 500),
              signal,
            ),
          );
          break;
        case "search":
          result = await app.search(x.query, x.purpose, config.topK, signal);
          break;
        default:
          fail("action", "未知操作。");
      }
      json(res, result);
    }),
  );
  const safe =
    (fn: (x: any, s: ToolSession, signal: AbortSignal) => Promise<any> | any) =>
    (x: any, s: ToolSession) =>
      app.operation(async (signal) => {
        try {
          return await fn(object(x), s, signal);
        } catch (e) {
          return errorResult(e);
        }
      }, s.signal);
  const register = (
    name: string,
    description: string,
    properties: Record<string, any>,
    required: string[],
    run: ReturnType<typeof safe>,
    danger: "safe" | "ask" = "safe",
  ) =>
    ctx.tools.register({
      name,
      description,
      schema: {
        type: "object",
        additionalProperties: false,
        properties,
        required,
      },
      danger,
      run,
    });
  register(
    "gallery_search",
    "在共享图库中按用途进行向量检索。meme 用于情绪、玩梗、接话；image 用于展示具体图片。返回少量描述和标签候选，由你决定选哪张以及是否发送；结果不代表已发送。",
    {
      query: { type: "string" },
      purpose: { type: "string", enum: ["meme", "image"] },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    ["query", "purpose"],
    safe((x, _s, signal) =>
      app.search(x.query, x.purpose, x.limit ?? config.topK, signal),
    ),
  );
  register(
    "gallery_list",
    "浏览共享图库中的描述与标签以便整理；可查看归档并按 ID 恢复。分页返回，不传原图或向量数值。",
    {
      purpose: { type: "string", enum: ["meme", "image"] },
      archived: { type: "boolean" },
      offset: { type: "integer", minimum: 0 },
    },
    [],
    safe((x) => {
      const r = store!.list({
        purpose: x.purpose,
        archived: x.archived === true,
        offset: Number.isInteger(x.offset) ? x.offset : 0,
        limit: 20,
      });
      return {
        ok: true,
        total: r.total,
        items: r.items.map((a) => ({
          ...candidate(a),
          revision: a.revision,
          archived: a.archived,
        })),
      };
    }),
  );
  register(
    "gallery_collect",
    "收藏当前聊天/浏览中你决定保留的一张图片。使用平台提供且属于本会话的 mediaRef，或公开图片 URL；不可传本地文件路径。保存后自动进行必要的图片理解及向量化，返回任务 ID。整包导入由用户在页面发起。",
    {
      mediaRef: { type: "string" },
      url: { type: "string" },
      description: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      purposes: {
        type: "array",
        items: { type: "string", enum: ["meme", "image"] },
      },
    },
    [],
    safe((x, s, signal) => app.collect(x, text(s.id, 200, false), signal)),
    "ask",
  );
  register(
    "gallery_manage",
    "读取或整理一张图库图片。可修改任何描述、标签、用途，包括用户改过的内容；修改用 revision 检查并发。archive 可恢复归档，restore 恢复。绝不永久删除。",
    {
      action: { type: "string", enum: ["read", "edit", "archive", "restore"] },
      id: { type: "string" },
      revision: { type: "integer" },
      description: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      purposes: {
        type: "array",
        items: { type: "string", enum: ["meme", "image"] },
      },
    },
    ["action", "id"],
    safe((x) => {
      const a = store!.get(text(x.id, 64, false));
      if (x.action === "read")
        return {
          ok: true,
          ...candidate(a),
          revision: a.revision,
          archived: a.archived,
          indexState: a.indexState,
        };
      if (!["edit", "archive", "restore"].includes(x.action))
        fail("action", "未知操作。");
      const patch: ItemInput =
        x.action === "edit"
          ? {
              ...(x.description !== undefined
                ? { description: x.description }
                : {}),
              ...(x.tags !== undefined ? { tags: x.tags } : {}),
              ...(x.purposes !== undefined ? { purposes: x.purposes } : {}),
            }
          : { archived: x.action === "archive" };
      const r = app.edit(a.id, x.revision, patch, "model");
      return {
        ok: true,
        ...candidate(r.asset),
        revision: r.asset.revision,
        archived: r.asset.archived,
        job: r.job,
      };
    }),
    "ask",
  );
  register(
    "gallery_job",
    "查询收藏任务的真实进度；完成前不能声称向量已准备好。",
    { id: { type: "string" } },
    ["id"],
    safe((x) => {
      const result = jobSummary(store!.job(text(x.id, 80, false)));
      return {
        ok: true,
        ...result,
        errors: result.errors.map((e) => ({ error: e.error })),
      };
    }),
  );
  register(
    "gallery_view",
    "按需查看候选原图。受原图开关和宿主多模态工具结果能力限制；当前宿主不支持时明确返回不可用，不把描述伪装成看过图片。",
    { id: { type: "string" } },
    ["id"],
    safe((x) => app.view(text(x.id, 64, false))),
  );
  ctx.provide("gallery", {
    apiVersion: "1.0.0",
    status: () => ({
      version: "0.1.1",
      ...store!.stats(),
      originalsAllowed: config.allowOriginals,
      candidateImages: false,
    }),
    search: (
      input: { query: string; purpose: Purpose; limit?: number },
      options?: { signal?: AbortSignal },
    ) =>
      app.operation(
        (s) =>
          app.search(input.query, input.purpose, input.limit ?? config.topK, s),
        options?.signal,
      ),
    describe: (id: string) => {
      ctx.signal.throwIfAborted();
      const a = store!.get(id);
      return { ...candidate(a), revision: a.revision, archived: a.archived };
    },
    // Trusted declared consumers only. Never registered as a model tool.
    readMedia: (id: string, options?: { signal?: AbortSignal }) =>
      app.operation(async (s) => {
        const a = store!.get(id);
        if (a.archived) fail("archived", "归档图片不能发送，请先恢复。");
        const bytes = await readFile(store!.path(id));
        s.throwIfAborted();
        return { id, mime: a.mime, base64: bytes.toString("base64") };
      }, options?.signal),
    offerMedia: (
      input: { sessionId: string; base64: string; source?: string },
      options?: { signal?: AbortSignal },
    ) =>
      app.operation(async (s) => {
        const sessionId = text(input.sessionId, 200, false);
        if (
          typeof input.base64 !== "string" ||
          input.base64.length > MAX_IMAGE * 1.4
        )
          fail("image_size", "媒体过大。");
        const bytes = Buffer.from(input.base64, "base64");
        await inspectImage(bytes);
        s.throwIfAborted();
        const mediaRef = store!.offer(bytes, sessionId, {
          kind: "chat",
          key: text(input.source ?? "platform", 200),
        });
        return { mediaRef, expiresInSeconds: 86400 };
      }, options?.signal),
  });
  ctx.logger.info(
    "图库已加载，导入预处理由用户启动；原图模型查看与平台发送等待对应公开接口。",
  );
}
