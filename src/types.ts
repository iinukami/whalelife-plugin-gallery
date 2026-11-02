/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export type Purpose = "meme" | "image";
export interface Config {
  schemaVersion: 1;
  visionModelId: string;
  embeddingModelId: string;
  allowOriginals: boolean;
  topK: number;
}
export const defaults: Config = {
  schemaVersion: 1,
  visionModelId: "",
  embeddingModelId: "",
  allowOriginals: false,
  topK: 5,
};
export const MAX_IMAGE = 25 * 1024 * 1024;
export const MAX_ARCHIVE = 1024 * 1024 * 1024;
export class GalleryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export function fail(code: string, message: string): never {
  throw new GalleryError(code, message);
}
export function errorResult(e: unknown) {
  return {
    ok: false as const,
    code:
      e instanceof GalleryError
        ? e.code
        : (e as Error)?.name === "AbortError"
          ? "cancelled"
          : "failed",
    error:
      e instanceof GalleryError
        ? e.message
        : "操作未完成，请查看任务状态后重试。",
  };
}
export function object(v: unknown): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail("invalid", "需要一个对象。");
  return v as Record<string, any>;
}
export function text(v: unknown, max = 2000, empty = true): string {
  if (typeof v !== "string" || v.length > max || (!empty && !v.trim()))
    fail("invalid", `文字不能为空且不得超过 ${max} 字符。`);
  return v.trim();
}
export function tags(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 40)
    fail("invalid", "标签须为最多 40 项的数组。");
  return [...new Set(v.map((x) => text(x, 80, false)))];
}
export function purposes(v: unknown): Purpose[] {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.some((x) => x !== "meme" && x !== "image")
  )
    fail("invalid", "用途须包含表情或普通图片。");
  return [...new Set(v)] as Purpose[];
}
export function configOf(v: unknown): Config {
  const x = object(v);
  if (x.schemaVersion !== undefined && x.schemaVersion !== 1)
    fail("config_version", "配置版本尚不支持，原文件已保留。");
  if (x.allowOriginals !== undefined && typeof x.allowOriginals !== "boolean")
    fail("invalid", "原图开关必须为布尔值。");
  const topK = x.topK ?? 5;
  if (!Number.isInteger(topK) || topK < 1 || topK > 20)
    fail("invalid", "候选数量须为 1–20。");
  return {
    schemaVersion: 1,
    visionModelId: text(x.visionModelId ?? "", 200),
    embeddingModelId: text(x.embeddingModelId ?? "", 200),
    allowOriginals: x.allowOriginals ?? false,
    topK,
  };
}
export interface Source {
  kind: "local" | "github" | "astr" | "chat" | "web" | "backup";
  key: string;
  path?: string;
  repository?: string;
  ref?: string;
  author?: string;
  license?: string;
  url?: string;
}
export interface Asset {
  id: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  frames: number;
  description: string;
  tags: string[];
  purposes: Purpose[];
  archived: boolean;
  revision: number;
  edited: string[];
  createdAt: string;
  updatedAt: string;
  sources: Source[];
  captionState: "pending" | "ready";
  indexState: "pending" | "ready" | "failed";
  error: string;
  indexedAt?: string;
}
export interface Vector {
  space: string;
  model: string;
  dimensions: number;
  textHash: string;
  values: number[];
}
export interface ItemInput {
  description?: string;
  tags?: string[];
  purposes?: Purpose[];
  archived?: boolean;
}
export interface JobItem {
  key: string;
  assetId?: string;
  path?: string;
  metadata?: any;
  status: "pending" | "done" | "failed";
  error?: string;
}
export interface Job {
  id: string;
  kind: "prepare" | "import";
  state: "paused" | "running" | "completed" | "errors";
  items: JobItem[];
  options: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}
export interface Candidate {
  id: string;
  description: string;
  tags: string[];
  purposes: Purpose[];
  animated: boolean;
  score?: number;
}
export function candidate(a: Asset): Candidate {
  return {
    id: a.id,
    description: a.description,
    tags: a.tags,
    purposes: a.purposes,
    animated: a.frames > 1,
  };
}
