/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import {
  readdir,
  readFile,
  realpath,
  lstat,
  mkdir,
  stat,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import {
  join,
  relative,
  resolve,
  dirname,
  basename,
  isAbsolute,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import yauzl from "yauzl";
import yazl from "yazl";
import { requestBytes } from "./network.ts";
import {
  fail,
  object,
  MAX_IMAGE,
  MAX_ARCHIVE,
  type JobItem,
  type Source,
  type ItemInput,
  type Vector,
} from "./types.ts";
import { Store, hash } from "./store.ts";

const imagePattern = /\.(png|jpe?g|gif|webp)$/i;
export function safeRelative(p: string) {
  if (
    !p ||
    p.length > 700 ||
    p.includes("\\") ||
    p.includes(":") ||
    p.startsWith("/") ||
    p.split("/").some((s) => s === ".." || s === "." || /[\x00-\x1f]/.test(s))
  )
    fail("path", "图包路径不安全。");
  return p;
}
export async function confinedFile(root: string, path: string) {
  safeRelative(path);
  const base = await realpath(root);
  const target = await realpath(join(base, path));
  const rel = relative(base, target);
  if (
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    (await lstat(join(base, path))).isSymbolicLink()
  )
    fail("path", "导入路径越过所选目录。");
  return target;
}
export async function boundedFile(path: string, limit: number) {
  if ((await stat(path)).size > limit)
    fail("too_large", "导入文件超过大小限制。");
  const b = await readFile(path);
  if (b.length > limit) fail("too_large", "导入文件超过大小限制。");
  return b;
}
function json(bytes: Buffer) {
  try {
    return object(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")));
  } catch {
    fail("metadata", "图包元数据不是有效 JSON。");
  }
}
export interface ImportPlan {
  items: JobItem[];
  options: Record<string, any>;
  warnings: string[];
}
function metadataFor(
  paths: string[],
  metadata: Record<string, any>,
  manifests: Record<string, any>,
): JobItem[] {
  const entries = new Map<string, any>();
  for (const [file, doc] of Object.entries(metadata)) {
    const prefix = file.includes("/")
      ? file.slice(0, file.lastIndexOf("/") + 1)
      : "";
    for (const record of Object.values(doc.images ?? {}) as any[]) {
      if (!record || typeof record.relative_path !== "string") continue;
      const p = record.relative_path.replaceAll("\\", "/");
      if (paths.includes(prefix + p)) entries.set(prefix + p, record);
      else if (paths.includes(p)) entries.set(p, record);
    }
  }
  return paths
    .filter((p) => imagePattern.test(p))
    .map((p) => {
      const meta = entries.get(p);
      const manifest = Object.entries(manifests)
        .sort((a, b) => b[0].length - a[0].length)
        .find(([prefix]) => p.startsWith(prefix))?.[1];
      const category =
        meta?.category ?? p.match(/(?:^|\/)memes\/([^/]+)\//)?.[1];
      const input: ItemInput = {
        description:
          typeof meta?.caption === "string" ? meta.caption : undefined,
        tags: [
          ...new Set([
            ...(Array.isArray(meta?.tags) ? meta.tags : []),
            ...(category ? [category] : []),
          ]),
        ],
        purposes: category ? ["meme"] : ["image"],
      };
      return {
        key: p,
        path: p,
        status: "pending" as const,
        metadata: {
          input,
          expectedHash: meta?.content_sha256,
          author: manifest?.author,
          license: manifest?.license,
          packVersion: manifest?.version,
        },
      };
    });
}
export async function planFolder(
  root: string,
  signal: AbortSignal,
  kind: "local" | "astr" = "local",
): Promise<ImportPlan> {
  const base = await realpath(root);
  const paths: string[] = [];
  let files = 0;
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (entry.isSymbolicLink()) continue;
      if (++files > 30000)
        fail("capacity", "单次目录导入最多检查 30000 项，请分批选择。");
      if (entry.isDirectory()) {
        if (![".git", "node_modules", ".venv", "config"].includes(entry.name))
          await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const p = relative(base, join(dir, entry.name)).replaceAll("\\", "/");
        if (
          imagePattern.test(p) ||
          [
            "semantic_metadata.json",
            "metadata.json",
            "manifest.json",
            "gallery-backup.json",
            "index_manifest.json",
          ].includes(entry.name)
        )
          paths.push(safeRelative(p));
      }
    }
  }
  await walk(base);
  const backups = paths.filter((p) => basename(p) === "gallery-backup.json");
  if (backups.length === 1) {
    const doc = json(
      await boundedFile(await confinedFile(base, backups[0]), 64 * 1024 * 1024),
    );
    if (
      doc.format !== "whalelife-gallery" ||
      doc.version !== 1 ||
      !Array.isArray(doc.assets)
    )
      fail("backup_version", "备份格式或版本不支持。");
    const prefix = backups[0].slice(0, -"gallery-backup.json".length);
    const items: JobItem[] = doc.assets.map((r: any) =>
      typeof r === "string"
        ? {
            key: r,
            path: prefix + "objects/" + r,
            status: "pending",
            metadata: { backupFile: prefix + "metadata/" + r + ".json" },
          }
        : {
            key: r.asset.id,
            path: prefix + "objects/" + r.asset.id,
            status: "pending",
            metadata: { backup: r },
          },
    );
    if (items.length > 10000) fail("capacity", "备份单次导入上限为 10000 张。");
    // Validate every byte before applying any backup metadata.
    for (const item of items) {
      signal.throwIfAborted();
      if (
        !/^[a-f0-9]{64}$/.test(item.key) ||
        hash(
          await boundedFile(await confinedFile(base, item.path!), MAX_IMAGE),
        ) !== item.key
      )
        fail("backup_hash", "备份原图缺失或校验失败。");
      const record =
        item.metadata.backup ??
        json(
          await boundedFile(
            await confinedFile(base, item.metadata.backupFile),
            64 * 1024 * 1024,
          ),
        );
      validateBackupRecord(record, item.key);
    }
    return {
      items,
      options: { root: base, kind: "backup", history: doc.history ?? [] },
      warnings: [],
    };
  }
  const metadata: Record<string, any> = {},
    manifests: Record<string, any> = {};
  let faiss = false;
  for (const p of paths) {
    if (basename(p) === "index_manifest.json") faiss = true;
    else if (["semantic_metadata.json", "metadata.json"].includes(basename(p)))
      metadata[p] = json(
        await boundedFile(await confinedFile(base, p), 32 * 1024 * 1024),
      );
    else if (basename(p) === "manifest.json")
      manifests[p.slice(0, -"manifest.json".length)] = json(
        await boundedFile(await confinedFile(base, p), 1024 * 1024),
      );
  }
  const items = metadataFor(paths, metadata, manifests);
  if (items.length > 10000) fail("capacity", "单次导入最多 10000 张，请分批。");
  return {
    items,
    options: { root: base, kind, sourceKey: base },
    warnings: faiss
      ? [
          "发现 Astr FAISS 索引；当前索引格式不同，描述与分类保留，向量请在导入后手动预处理重建。",
        ]
      : [],
  };
}
export async function planGitHub(
  repository: string,
  ref: string,
  subpath: string,
  signal: AbortSignal,
  download: typeof requestBytes = requestBytes,
): Promise<ImportPlan> {
  const match = repository.match(
    /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
  );
  if (!match)
    fail("repository", "请输入 GitHub 仓库根地址，分支或提交填入 ref。");
  const repo = match[1] + "/" + match[2];
  const api = "https://api.github.com/repos/" + repo;
  const get = async (url: string, limit = 16 * 1024 * 1024) =>
    json(await download(url, { signal, limit, publicOnly: true }));
  const info = await get(api);
  const commit = await get(
    api + "/commits/" + encodeURIComponent(ref || info.default_branch),
  );
  const sha = String(commit.sha);
  if (!/^[a-f0-9]{40}$/.test(sha)) fail("repository", "无法解析仓库提交。");
  const tree = await get(api + "/git/trees/" + sha + "?recursive=1");
  if (tree.truncated)
    fail("capacity", "仓库目录过大，请导出所需子目录后本地导入。");
  const prefix =
    subpath && subpath !== "."
      ? safeRelative(subpath.replace(/\/$/, "")) + "/"
      : "";
  const entries = (tree.tree ?? []).filter(
    (e: any) =>
      e.type === "blob" && e.mode !== "120000" && e.path.startsWith(prefix),
  );
  const paths = entries.map((e: any) =>
    safeRelative(e.path.slice(prefix.length)),
  );
  const raw = (p: string) =>
    "https://raw.githubusercontent.com/" +
    repo +
    "/" +
    sha +
    "/" +
    (prefix + p).split("/").map(encodeURIComponent).join("/");
  const metadata: Record<string, any> = {},
    manifests: Record<string, any> = {};
  for (const p of paths) {
    if (["semantic_metadata.json"].includes(basename(p)))
      metadata[p] = await get(raw(p));
    else if (basename(p) === "manifest.json")
      manifests[p.slice(0, -"manifest.json".length)] = await get(
        raw(p),
        1024 * 1024,
      );
  }
  const items = metadataFor(paths, metadata, manifests);
  if (items.length > 10000) fail("capacity", "单次 GitHub 导入最多 10000 张。");
  for (const item of items) {
    item.metadata.url = raw(item.path!);
    if (
      entries.find((e: any) => e.path === prefix + item.path)?.size > MAX_IMAGE
    ) {
      item.status = "failed";
      item.error = "图片超过 25 MiB。";
    }
  }
  return {
    items,
    options: {
      kind: "github",
      repository: "https://github.com/" + repo,
      ref: sha,
      requestedRef: ref || info.default_branch,
      sourceKey: repo + ":" + prefix,
      author: String(info.owner?.login ?? ""),
      license: String(info.license?.spdx_id ?? ""),
    },
    warnings: [],
  };
}
export function importSource(
  options: Record<string, any>,
  item: JobItem,
): Source {
  return {
    kind: options.kind,
    key: options.sourceKey ?? options.root,
    path: item.path,
    ...(options.repository
      ? { repository: options.repository, ref: options.ref }
      : {}),
    author: item.metadata?.author ?? options.author,
    license: item.metadata?.license ?? options.license,
  };
}
export function sizeLimiter(limit: number) {
  let size = 0;
  return new Transform({
    transform(chunk, _enc, callback) {
      size += chunk.length;
      callback(size > limit ? new Error("上传超过大小限制") : null, chunk);
    },
  });
}
export async function extractZip(
  file: string,
  destination: string,
  signal: AbortSignal,
) {
  await mkdir(destination, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(file, { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z!))),
  );
  let count = 0,
    total = 0;
  const seen = new Set<string>();
  try {
    await new Promise<void>((res, rej) => {
      let settled = false;
      const done = (e?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        zip.close();
        e ? rej(e) : res();
      };
      const abort = () => done(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      zip.on("error", done);
      zip.on("end", () => done());
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          signal.throwIfAborted();
          const name = entry.fileName;
          if (name.endsWith("/")) {
            safeRelative(name.slice(0, -1));
            zip.readEntry();
            return;
          }
          safeRelative(name);
          if (++count > 30000) fail("capacity", "ZIP 条目过多。");
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000) fail("path", "ZIP 不允许符号链接。");
          // Image data, supported metadata and content-addressed backup objects only.
          if (
            !imagePattern.test(name) &&
            !/(^|\/)(semantic_metadata|metadata|manifest|gallery-backup|index_manifest)\.json$/.test(
              name,
            ) &&
            !/(^|\/)objects\/[a-f0-9]{64}$/.test(name) &&
            !/(^|\/)metadata\/[a-f0-9]{64}\.json$/.test(name)
          ) {
            zip.readEntry();
            return;
          }
          if (seen.has(name.toLowerCase())) fail("path", "ZIP 包含重复路径。");
          seen.add(name.toLowerCase());
          const limit = name.endsWith(".json") ? 64 * 1024 * 1024 : MAX_IMAGE;
          total += entry.uncompressedSize;
          if (entry.uncompressedSize > limit || total > MAX_ARCHIVE)
            fail("capacity", "ZIP 解压后超过大小限制。");
          const target = join(destination, name);
          await mkdir(dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((yes, no) =>
            zip.openReadStream(entry, (e, s) => (e ? no(e) : yes(s!))),
          );
          await pipeline(
            stream,
            sizeLimiter(limit),
            createWriteStream(target, { flags: "wx" }),
            { signal },
          );
          zip.readEntry();
        })().catch(done);
      });
      if (signal.aborted) abort();
      else zip.readEntry();
    });
  } finally {
    zip.close();
  }
}
export function backupStream(store: Store) {
  // yazl 3 supports lazy streams; the upstream @types package still describes 2.x.
  const zip = new yazl.ZipFile() as yazl.ZipFile & {
    outputStream: Readable;
    on(event: "error", handler: (error: Error) => void): void;
    addReadStreamLazy(
      path: string,
      options: Record<string, unknown>,
      get: (cb: (e: Error | null, stream?: Readable) => void) => void,
    ): void;
  };
  const assets = store.db
    .prepare("SELECT json FROM assets")
    .all()
    .map((r: any) => JSON.parse(r.json));
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        format: "whalelife-gallery",
        version: 1,
        assets: assets.map((a) => a.id),
      }),
    ),
    "gallery-backup.json",
  );
  zip.on("error", (e) => zip.outputStream.destroy(e));
  for (const asset of assets) {
    zip.addFile(store.path(asset.id), "objects/" + asset.id, {
      compress: false,
    });
    zip.addReadStreamLazy("metadata/" + asset.id + ".json", {}, (cb) => {
      try {
        const v = store.vector(asset.id);
        const vector =
          v?.textHash === hash([asset.description, ...asset.tags].join("\n"))
            ? v
            : undefined;
        const history = store.db
          .prepare("SELECT assetId,json FROM history WHERE assetId=?")
          .all(asset.id);
        cb(
          null,
          Readable.from([
            Buffer.from(JSON.stringify({ asset, vector, history })),
          ]),
        );
      } catch (e) {
        cb(e as Error);
      }
    });
  }
  zip.end();
  return zip;
}
export function validateBackupRecord(record: any, id: string) {
  object(record);
  const a = object(record.asset);
  if (
    a.id !== id ||
    !Number.isInteger(a.revision) ||
    a.revision < 1 ||
    typeof a.description !== "string" ||
    a.description.length > 2000 ||
    !Array.isArray(a.tags) ||
    a.tags.length > 40 ||
    a.tags.some((t: any) => typeof t !== "string" || t.length > 80) ||
    !Array.isArray(a.purposes) ||
    !a.purposes.length ||
    a.purposes.some((p: any) => p !== "image" && p !== "meme") ||
    typeof a.archived !== "boolean" ||
    !Array.isArray(a.sources) ||
    a.sources.some(
      (s: any) =>
        !s ||
        typeof s !== "object" ||
        !["local", "github", "astr", "chat", "web", "backup"].includes(
          s.kind,
        ) ||
        typeof s.key !== "string" ||
        ["path", "repository", "ref", "author", "license", "url"].some(
          (k) => s[k] !== undefined && typeof s[k] !== "string",
        ),
    ) ||
    !Array.isArray(a.edited) ||
    a.edited.some(
      (k: any) => !["description", "tags", "purposes", "archived"].includes(k),
    ) ||
    typeof a.createdAt !== "string" ||
    typeof a.updatedAt !== "string" ||
    (a.indexedAt !== undefined && typeof a.indexedAt !== "string") ||
    !["pending", "ready"].includes(a.captionState) ||
    !["pending", "ready", "failed"].includes(a.indexState) ||
    typeof a.error !== "string"
  )
    fail("backup", "备份元信息无效。");
  if (
    record.history !== undefined &&
    (!Array.isArray(record.history) ||
      record.history.some(
        (h: any) => !h || h.assetId !== id || typeof h.json !== "string",
      ))
  )
    fail("backup", "备份编辑记录无效。");
  if (record.vector) {
    const v = record.vector;
    if (
      typeof v.space !== "string" ||
      typeof v.model !== "string" ||
      v.textHash !== hash([a.description, ...a.tags].join("\n")) ||
      !Array.isArray(v.values) ||
      v.values.length !== v.dimensions ||
      v.values.length > 32768 ||
      v.values.some((x: any) => typeof x !== "number" || !Number.isFinite(x)) ||
      !Math.hypot(...v.values)
    )
      fail("backup", "备份向量无效。");
  }
}
