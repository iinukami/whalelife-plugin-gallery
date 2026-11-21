/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { Store, hash, indexText } from "./store.ts";
import { Jobs, jobSummary } from "./jobs.ts";
import { inspectImage, thumbnail } from "./media.ts";
import { requestBytes } from "./network.ts";
import {
  boundedFile,
  confinedFile,
  importSource,
  validateBackupRecord,
  type ImportPlan,
} from "./imports.ts";
import {
  candidate,
  errorResult,
  fail,
  MAX_IMAGE,
  purposes,
  tags,
  text,
  type Config,
  type Source,
  type ItemInput,
  type Job,
  type JobItem,
  type Purpose,
  type Vector,
} from "./types.ts";
import type { ModelBackend } from "./models.ts";

export class Gallery {
  store: Store;
  models: ModelBackend;
  config: () => Config;
  signal: AbortSignal;
  jobs: Jobs;
  private controller = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private stopping?: Promise<void>;
  private previewQueue: Promise<unknown> = Promise.resolve();
  constructor(
    store: Store,
    models: ModelBackend,
    config: () => Config,
    signal: AbortSignal,
  ) {
    this.store = store;
    this.models = models;
    this.config = config;
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.jobs = new Jobs(
      store,
      this.signal,
      (j, i, s) => this.execute(j, i, s),
      (j) => this.cleanupImport(j),
    );
  }
  private async cleanupImport(j: Job) {
    if (j.kind !== "import" || !j.options.staging) return;
    const id = String(j.options.staging);
    if (!/^[a-f0-9-]{36}$/.test(id)) return;
    const dir = resolve(this.store.root, "incoming", id);
    if (dirname(dir) !== resolve(this.store.root, "incoming")) return;
    await rm(dir, { recursive: true, force: true });
  }
  async operation<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.signal.throwIfAborted();
    const combined = signal
      ? AbortSignal.any([this.signal, signal])
      : this.signal;
    combined.throwIfAborted();
    const p = Promise.resolve().then(() => fn(combined));
    this.pending.add(p);
    try {
      return await p;
    } finally {
      this.pending.delete(p);
    }
  }
  stop() {
    return (this.stopping ??= this.finishStop());
  }
  private async finishStop() {
    this.controller.abort();
    await this.jobs.stop();
    await Promise.allSettled([...this.pending]);
    this.store.close();
  }
  async ingest(
    bytes: Buffer,
    input: ItemInput,
    source: Source,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const media = await inspectImage(bytes);
    signal.throwIfAborted();
    return this.store.add(bytes, media, input, source);
  }
  async collect(
    input: {
      url?: string;
      mediaRef?: string;
      description?: string;
      tags?: string[];
      purposes?: Purpose[];
    },
    sessionId: string,
    signal: AbortSignal,
  ) {
    if (!!input.url === !!input.mediaRef)
      fail("source", "请选择一个可取图链接或临时图片引用。");
    let bytes: Buffer, source: Source;
    if (input.mediaRef) {
      const offer = this.store.offered(
        text(input.mediaRef, 80, false),
        sessionId,
      );
      bytes = offer.bytes;
      source = offer.source;
    } else {
      const url = text(input.url, 2048, false);
      bytes = await requestBytes(url, {
        signal,
        limit: MAX_IMAGE,
        publicOnly: true,
      });
      source = { kind: "web", key: url, url };
    }
    const a = await this.ingest(
      bytes,
      {
        ...(input.description !== undefined
          ? { description: text(input.description) }
          : {}),
        ...(input.tags ? { tags: tags(input.tags) } : {}),
        ...(input.purposes ? { purposes: purposes(input.purposes) } : {}),
      },
      source,
      signal,
    );
    const j = this.prepare([a.id], false);
    this.jobs.resume(j.id);
    return {
      ok: true,
      state: "saved",
      asset: candidate(a),
      archived: a.archived,
      job: jobSummary(this.store.job(j.id)),
      note: "原图已保存；描述和索引进度以任务结果为准。归档图片重复收藏仍保留归档，请明确恢复。",
    };
  }
  prepare(ids: string[], forceCaption = false) {
    this.signal.throwIfAborted();
    if (!ids.length) fail("empty", "还没有可处理的图片。");
    if (ids.length > 10000) fail("capacity", "单次最多处理 10000 张。");
    const items = [...new Set(ids)].map((id) => {
      const a = this.store.get(id);
      return {
        key: a.description.slice(0, 60) || `图片 ${id.slice(0, 8)}`,
        assetId: id,
        status: "pending" as const,
      };
    });
    return this.jobs.create("prepare", items, { forceCaption });
  }
  startImport(plan: ImportPlan) {
    if (!plan.items.length) fail("empty", "所选来源没有找到可导入图片。");
    const j = this.jobs.create("import", plan.items, plan.options);
    const result = this.jobs.resume(j.id);
    return { job: result, warnings: plan.warnings };
  }
  async preview(id: string, signal: AbortSignal) {
    this.store.get(id);
    const path = join(this.store.root, "previews", id + ".webp");
    try {
      return await readFile(path);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    const work = this.previewQueue.then(async () => {
      signal.throwIfAborted();
      try {
        return await readFile(path);
      } catch {}
      const bytes = await thumbnail(
        await readFile(this.store.path(id)),
        signal,
      );
      signal.throwIfAborted();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return bytes;
    });
    this.previewQueue = work.catch(() => {});
    return work;
  }
  private async execute(job: Job, item: JobItem, signal: AbortSignal) {
    if (job.kind === "prepare") {
      let a = this.store.get(item.assetId!);
      if (a.archived) return a.id;
      let stage = "图片理解";
      try {
        if (!a.description || job.options.forceCaption) {
          const revision = a.revision;
          const description = await this.models.caption(
            await readFile(this.store.path(a.id)),
            signal,
          );
          signal.throwIfAborted();
          // Filling a missing description is not permission to reclassify
          // fields already curated by the user or the main model.
          const patch = { ...description };
          if (!job.options.forceCaption)
            for (const key of ["tags", "purposes"] as const)
              if (a.edited.includes(key)) delete patch[key];
          a = this.store.edit(a.id, revision, patch, "prepare");
        }
        stage = "向量生成";
        const old = this.store.vector(a.id);
        const space = this.models.space();
        if (old?.space === space && old.textHash === hash(indexText(a))) {
          if (a.indexState !== "ready" || a.error)
            this.store.putVector(a.id, old, a.revision);
          return a.id;
        }
        const embedded = await this.models.embed(indexText(a), signal);
        signal.throwIfAborted();
        this.store.putVector(
          a.id,
          {
            ...embedded,
            dimensions: embedded.values.length,
            textHash: hash(indexText(a)),
          },
          a.revision,
        );
      } catch (e) {
        if (signal.aborted) throw e;
        const message = `${stage}失败：${errorResult(e).error}`;
        this.store.markFailed(a.id, message, a.revision);
        fail(errorResult(e).code, message);
      }
      return a.id;
    }
    const bytes =
      job.options.kind === "github"
        ? await requestBytes(item.metadata.url, {
            signal,
            limit: MAX_IMAGE,
            publicOnly: true,
          })
        : await boundedFile(
            await confinedFile(job.options.root, item.path!),
            MAX_IMAGE,
          );
    signal.throwIfAborted();
    if (
      item.metadata?.expectedHash &&
      hash(bytes) !== item.metadata.expectedHash
    )
      fail("hash", "图片与语义描述的摘要不一致，未导入。");
    if (item.metadata?.backup || item.metadata?.backupFile) {
      const record =
        item.metadata.backup ??
        JSON.parse(
          (
            await boundedFile(
              await confinedFile(job.options.root, item.metadata.backupFile),
              64 * 1024 * 1024,
            )
          ).toString("utf8"),
        );
      validateBackupRecord(record, hash(bytes));
      const media = await inspectImage(bytes);
      signal.throwIfAborted();
      const a = this.store.importBackup(
        bytes,
        media,
        { ...record, history: record.history ?? job.options.history ?? [] },
        { kind: "backup", key: job.id },
      );
      return a.id;
    }
    const a = await this.ingest(
      bytes,
      item.metadata?.input ?? {},
      importSource(job.options, item),
      signal,
    );
    return a.id;
  }
  async search(
    query: string,
    purpose: Purpose,
    count: number,
    signal: AbortSignal,
  ) {
    if (purpose !== "meme" && purpose !== "image")
      fail("purpose", "检索时请先指定表情或普通图片用途。");
    const q = text(query, 1000, false);
    if (!Number.isInteger(count) || count < 1 || count > 20)
      fail("limit", "检索数量须为 1–20。");
    const k = count;
    const embedded = await this.models.embed(q, signal, "query");
    signal.throwIfAborted();
    const rows = await this.store.search(
      embedded.values,
      embedded.space,
      purpose,
      k,
      signal,
    );
    return {
      ok: true,
      purpose,
      candidates: rows.map((r) => ({
        ...candidate(r.asset),
        revision: r.asset.revision,
        score: Number(r.score.toFixed(5)),
      })),
      originalsAllowed: this.config().allowOriginals,
      originalViewingAvailable: false,
    };
  }
  edit(
    id: string,
    revision: number,
    input: ItemInput,
    actor: "user" | "model",
  ) {
    this.signal.throwIfAborted();
    const before = this.store.get(id),
      auto = actor === "model" || !!before.indexedAt || !!this.store.vector(id);
    const a = this.store.edit(id, revision, input, actor);
    let job;
    if (auto && !a.archived && a.description && a.indexState !== "ready") {
      const j = this.prepare([a.id]);
      job = this.jobs.resume(j.id);
    }
    return { ok: true, asset: a, job };
  }
  view(id: string) {
    this.store.get(id);
    if (!this.config().allowOriginals)
      fail("originals_disabled", "候选原图查看已关闭，可根据描述和标签选择。");
    fail(
      "multimodal_required",
      "当前宿主尚不支持向主模型返回图片工具结果。图片仍可在图库管理页查看。",
    );
  }
}
