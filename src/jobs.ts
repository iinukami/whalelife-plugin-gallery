/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { errorResult, type Job, type JobItem } from "./types.ts";

export function jobSummary(j: Job, store?: Store) {
  const failures = j.items
    .filter((x) => x.status === "failed")
    .map((x) => {
      const asset =
        x.assetId && store?.has(x.assetId) ? store.get(x.assetId) : undefined;
      return {
        key: x.key,
        error: x.error,
        ...(x.assetId ? { assetId: x.assetId } : {}),
        ...(asset
          ? {
              description: asset.description.slice(0, 120),
              indexState: asset.indexState,
            }
          : {}),
        resolved: !!asset && asset.indexState === "ready",
      };
    });
  return {
    id: j.id,
    kind: j.kind,
    state: j.state,
    total: j.items.length,
    done: j.items.filter((x) => x.status === "done").length,
    failed: j.items.filter((x) => x.status === "failed").length,
    resolvedFailed: failures.filter((x) => x.resolved).length,
    unresolvedFailed: failures.filter((x) => !x.resolved).length,
    errors: failures.slice(0, 30),
    createdAt: j.createdAt,
  };
}
export class Jobs {
  store: Store;
  signal: AbortSignal;
  execute: (
    job: Job,
    item: JobItem,
    signal: AbortSignal,
  ) => Promise<string | void>;
  finalize: (job: Job) => Promise<void>;
  private pending = new Set<string>();
  private controller?: AbortController;
  private current?: string;
  private running?: Promise<void>;
  constructor(
    store: Store,
    signal: AbortSignal,
    execute: Jobs["execute"],
    finalize: Jobs["finalize"] = async () => {},
  ) {
    this.store = store;
    this.signal = signal;
    this.execute = execute;
    this.finalize = finalize;
  }
  create(kind: Job["kind"], items: JobItem[], options: Job["options"] = {}) {
    this.signal.throwIfAborted();
    const now = new Date().toISOString();
    const j: Job = {
      id: randomUUID(),
      kind,
      state: "paused",
      items,
      options,
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveJob(j);
    return j;
  }
  resume(id: string, retry = false) {
    this.signal.throwIfAborted();
    const j = this.store.job(id);
    if (retry)
      for (const item of j.items)
        if (item.status === "failed") {
          item.status = "pending";
          delete item.error;
        }
    if (!j.items.some((x) => x.status === "pending"))
      return jobSummary(j, this.store);
    j.state = "running";
    this.store.saveJob(j);
    this.pending.add(id);
    if (!this.running)
      this.running = this.drain().finally(() => {
        this.running = undefined;
      });
    return jobSummary(j, this.store);
  }
  pause(id: string) {
    const j = this.store.job(id);
    if (j.state === "running") {
      j.state = "paused";
      this.store.saveJob(j);
    }
    this.pending.delete(id);
    if (this.current === id) this.controller?.abort();
    return jobSummary(j, this.store);
  }
  private async drain() {
    while (this.pending.size && !this.signal.aborted) {
      const id = this.pending.values().next().value!;
      this.pending.delete(id);
      this.current = id;
      this.controller = new AbortController();
      const signal = AbortSignal.any([this.signal, this.controller.signal]);
      while (!signal.aborted) {
        let j = this.store.job(id);
        if (j.state !== "running") break;
        const index = j.items.findIndex((x) => x.status === "pending");
        if (index < 0) {
          j.state = j.items.some((x) => x.status === "failed")
            ? "errors"
            : "completed";
          this.store.saveJob(j);
          if (j.state === "completed") await this.finalize(j).catch(() => {});
          break;
        }
        const item = j.items[index];
        try {
          const assetId = await this.execute(j, item, signal);
          j = this.store.job(id);
          j.items[index] = {
            ...item,
            status: "done",
            ...(assetId ? { assetId } : {}),
          };
          this.store.saveJob(j);
        } catch (e) {
          j = this.store.job(id);
          if (signal.aborted) {
            if (this.signal.aborted || !this.pending.has(id)) {
              j.state = "paused";
              this.store.saveJob(j);
            }
            break;
          }
          j.items[index] = {
            ...item,
            status: "failed",
            error: errorResult(e).error,
          };
          this.store.saveJob(j);
        }
      }
      this.current = undefined;
      this.controller = undefined;
    }
  }
  async stop() {
    for (const j of this.store.jobs())
      if (j.state === "running") this.pause(j.id);
    this.pending.clear();
    this.controller?.abort();
    await this.running;
  }
}
