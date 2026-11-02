import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  fail,
  purposes,
  tags,
  text,
  type Asset,
  type Vector,
  type Source,
  type Job,
  type ItemInput,
  type Purpose,
} from "./types.ts";

export const hash = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
export const indexText = (a: Pick<Asset, "description" | "tags">) =>
  [a.description, ...a.tags].join("\n");
export function normalizeVector(input: unknown): number[] {
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 32768 ||
    input.some((x) => typeof x !== "number" || !Number.isFinite(x))
  )
    fail("vector", "向量格式或维度无效。");
  const norm = Math.hypot(...input);
  if (!Number.isFinite(norm) || norm === 0)
    fail("vector", "向量不能为零或非有限值。");
  return input.map((x) => x / norm);
}
export class Store {
  readonly root: string;
  readonly db: DatabaseSync;
  private closed = false;
  private inTransaction = false;
  constructor(root: string) {
    this.root = root;
    mkdirSync(join(root, "objects"), { recursive: true });
    mkdirSync(join(root, "incoming"), { recursive: true });
    this.db = new DatabaseSync(join(root, "gallery.sqlite"));
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as any).user_version,
    );
    if (version > 1) {
      this.db.close();
      fail("database_version", "图库版本较新，当前插件保留数据并停止加载。");
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, json TEXT NOT NULL, archived INTEGER NOT NULL, meme INTEGER NOT NULL, image INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vectors(id TEXT PRIMARY KEY REFERENCES assets(id), space TEXT NOT NULL, dimensions INTEGER NOT NULL, textHash TEXT NOT NULL, model TEXT NOT NULL, valuesBlob BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY,assetId TEXT,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS offers(id TEXT PRIMARY KEY,assetId TEXT NOT NULL,sessionId TEXT NOT NULL,expires INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(seq INTEGER PRIMARY KEY,kind TEXT,model TEXT,tokens INTEGER,createdAt TEXT);
      PRAGMA user_version=1;`);
    for (const job of this.jobs())
      if (job.state === "running") {
        job.state = "paused";
        this.saveJob(job);
      }
    // Only abandoned temporary writes inside this instance's own data directory.
    for (const f of readdirSync(join(root, "objects")))
      if (/^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(f))
        unlinkSync(join(root, "objects", f));
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  private transaction<T>(work: () => T): T {
    if (this.inTransaction) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  path(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) fail("id", "图片 ID 无效。");
    return join(this.root, "objects", id);
  }
  get(id: string): Asset {
    const row = this.db
      .prepare("SELECT json FROM assets WHERE id=?")
      .get(id) as any;
    if (!row) fail("missing", "图片不存在。");
    return JSON.parse(row.json);
  }
  has(id: string) {
    return !!this.db.prepare("SELECT 1 FROM assets WHERE id=?").get(id);
  }
  private save(a: Asset) {
    this.db
      .prepare(
        "INSERT INTO assets VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,archived=excluded.archived,meme=excluded.meme,image=excluded.image",
      )
      .run(
        a.id,
        JSON.stringify(a),
        +a.archived,
        +a.purposes.includes("meme"),
        +a.purposes.includes("image"),
      );
  }
  add(
    bytes: Buffer,
    media: Pick<Asset, "mime" | "width" | "height" | "frames">,
    input: ItemInput,
    source: Source,
  ): Asset {
    if (input.description !== undefined) text(input.description);
    if (input.tags !== undefined) tags(input.tags);
    if (input.purposes !== undefined) purposes(input.purposes);
    const id = hash(bytes),
      now = new Date().toISOString();
    if (!existsSync(this.path(id))) {
      const tmp = this.path(id) + "." + randomUUID() + ".tmp";
      writeFileSync(tmp, bytes, { flag: "wx" });
      renameSync(tmp, this.path(id));
    }
    if (this.has(id)) {
      const a = this.get(id);
      const priorSource = a.sources.findIndex(
        (s) =>
          s.kind === source.kind &&
          s.key === source.key &&
          s.path === source.path,
      );
      if (priorSource < 0) a.sources.push(source);
      else a.sources[priorSource] = source;
      // Re-import never restores archived items or overwrites locally/model-edited fields.
      if (!a.edited.includes("description") && input.description !== undefined)
        a.description = text(input.description);
      if (!a.edited.includes("tags") && input.tags) a.tags = tags(input.tags);
      if (!a.edited.includes("purposes") && input.purposes)
        a.purposes = purposes([...a.purposes, ...input.purposes]);
      a.captionState = a.description ? "ready" : "pending";
      a.revision++;
      a.updatedAt = now;
      const v = this.vector(id);
      if (v && v.textHash !== hash(indexText(a))) {
        this.db.prepare("DELETE FROM vectors WHERE id=?").run(id);
        a.indexState = "pending";
      }
      this.save(a);
      return a;
    }
    const a: Asset = {
      id,
      ...media,
      bytes: bytes.length,
      description: text(input.description ?? ""),
      tags: tags(input.tags ?? []),
      purposes: purposes(input.purposes ?? ["image"]),
      archived: input.archived ?? false,
      revision: 1,
      edited: [],
      createdAt: now,
      updatedAt: now,
      sources: [source],
      captionState: input.description ? "ready" : "pending",
      indexState: "pending",
      error: "",
    };
    this.save(a);
    return a;
  }
  edit(
    id: string,
    revision: number,
    patch: ItemInput,
    actor: "user" | "model" | "prepare" = "user",
  ): Asset {
    const a = this.get(id);
    if (a.revision !== revision)
      fail("conflict", "图片已变化，请刷新后再修改。");
    const before = JSON.stringify(a);
    for (const key of ["description", "tags", "purposes", "archived"] as const)
      if (patch[key] !== undefined) {
        if (key === "description") a.description = text(patch.description);
        if (key === "tags") a.tags = tags(patch.tags);
        if (key === "purposes") a.purposes = purposes(patch.purposes);
        if (key === "archived") {
          if (typeof patch.archived !== "boolean")
            fail("invalid", "归档状态无效。");
          a.archived = patch.archived;
        }
        if (!a.edited.includes(key)) a.edited.push(key);
      }
    a.revision++;
    a.updatedAt = new Date().toISOString();
    a.captionState = a.description ? "ready" : "pending";
    a.error = "";
    return this.transaction(() => {
      this.db
        .prepare("INSERT INTO history(assetId,json) VALUES(?,?)")
        .run(id, before);
      const v = this.vector(id);
      if (v && v.textHash !== hash(indexText(a))) {
        this.db.prepare("DELETE FROM vectors WHERE id=?").run(id);
        a.indexState = "pending";
      }
      this.save(a);
      return a;
    });
  }
  markFailed(id: string, message: string, expectedRevision?: number) {
    const a = this.get(id);
    if (expectedRevision !== undefined && a.revision !== expectedRevision)
      return;
    a.error = message;
    a.indexState = "failed";
    this.save(a);
  }
  putVector(id: string, v: Vector, expectedRevision: number) {
    const a = this.get(id);
    if (a.revision !== expectedRevision || hash(indexText(a)) !== v.textHash)
      fail("conflict", "描述变化，旧向量未写入。");
    const values = normalizeVector(v.values);
    if (v.dimensions !== values.length) fail("vector", "向量维度不匹配。");
    const buf = Buffer.alloc(values.length * 4);
    values.forEach((n, i) => buf.writeFloatLE(n, i * 4));
    this.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?,?)")
        .run(id, v.space, values.length, v.textHash, v.model, buf);
      a.indexState = "ready";
      a.indexedAt = new Date().toISOString();
      a.error = "";
      this.save(a);
    });
  }
  vector(id: string): Vector | undefined {
    const r = this.db
      .prepare("SELECT * FROM vectors WHERE id=?")
      .get(id) as any;
    if (!r) return;
    const b = Buffer.from(r.valuesBlob);
    return {
      space: r.space,
      dimensions: r.dimensions,
      textHash: r.textHash,
      model: r.model,
      values: Array.from({ length: r.dimensions }, (_, i) =>
        b.readFloatLE(i * 4),
      ),
    };
  }
  list(
    input: {
      purpose?: Purpose;
      archived?: boolean;
      offset?: number;
      limit?: number;
      query?: string;
    } = {},
  ) {
    const {
      purpose,
      archived = false,
      offset = 0,
      limit = 60,
      query = "",
    } = input;
    const filter =
      "archived=?" +
      (purpose === "meme"
        ? " AND meme=1"
        : purpose === "image"
          ? " AND image=1"
          : "") +
      (query ? " AND json LIKE ?" : "");
    const params: any[] = [+archived, ...(query ? ["%" + query + "%"] : [])];
    const total = Number(
      (
        this.db
          .prepare("SELECT count(*) n FROM assets WHERE " + filter)
          .get(...params) as any
      ).n,
    );
    const items = this.db
      .prepare(
        "SELECT json FROM assets WHERE " +
          filter +
          " ORDER BY rowid DESC LIMIT ? OFFSET ?",
      )
      .all(...params, Math.min(200, Math.max(1, limit)), Math.max(0, offset))
      .map((r: any) => JSON.parse(r.json) as Asset);
    return { total, items };
  }
  ids(archived = false) {
    return this.db
      .prepare("SELECT id FROM assets WHERE archived=?")
      .all(+archived)
      .map((r) => String(r.id));
  }
  async search(
    values: number[],
    space: string,
    purpose: Purpose,
    count: number,
    signal: AbortSignal,
  ) {
    const q = normalizeVector(values);
    const best: { asset: Asset; score: number }[] = [];
    let seen = 0;
    const stmt = this.db.prepare(
      `SELECT a.json,v.valuesBlob FROM assets a JOIN vectors v ON a.id=v.id WHERE a.archived=0 AND a.${purpose === "meme" ? "meme" : "image"}=1 AND v.space=? AND v.dimensions=?`,
    );
    for (const r of stmt.iterate(space, q.length) as Iterable<any>) {
      signal.throwIfAborted();
      const b = Buffer.from(r.valuesBlob);
      let score = 0;
      for (let i = 0; i < q.length; i++) score += q[i] * b.readFloatLE(i * 4);
      if (best.length < count || score > best.at(-1)!.score) {
        best.push({ asset: JSON.parse(r.json), score });
        best.sort((a, b) => b.score - a.score);
        best.length = Math.min(best.length, count);
      }
      if (++seen % 250 === 0) await setImmediate();
    }
    return best;
  }
  saveJob(job: Job) {
    job.updatedAt = new Date().toISOString();
    this.db
      .prepare("INSERT OR REPLACE INTO jobs VALUES(?,?)")
      .run(job.id, JSON.stringify(job));
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT json FROM jobs ORDER BY rowid DESC")
      .all()
      .map((r: any) => JSON.parse(r.json));
  }
  job(id: string) {
    const r = this.db
      .prepare("SELECT json FROM jobs WHERE id=?")
      .get(id) as any;
    if (!r) fail("missing", "任务不存在。");
    return JSON.parse(r.json) as Job;
  }
  usage(kind: string, model: string, tokens: number | null) {
    this.db
      .prepare("INSERT INTO usage(kind,model,tokens,createdAt) VALUES(?,?,?,?)")
      .run(kind, model, tokens, new Date().toISOString());
  }
  stats() {
    return {
      active: this.list({ limit: 1 }).total,
      archived: this.list({ archived: true, limit: 1 }).total,
      indexed: Number(
        (this.db.prepare("SELECT count(*) n FROM vectors").get() as any).n,
      ),
      activeIndexed: Number(
        (
          this.db
            .prepare(
              "SELECT count(*) n FROM vectors v JOIN assets a ON a.id=v.id WHERE a.archived=0",
            )
            .get() as any
        ).n,
      ),
      usage: this.db
        .prepare(
          "SELECT kind,model,count(*) requests,sum(tokens) tokens,sum(tokens IS NULL) unknown FROM usage GROUP BY kind,model",
        )
        .all(),
    };
  }
  offer(bytes: Buffer, sessionId: string, source: Source) {
    const assetId = hash(bytes);
    if (!existsSync(this.path(assetId)))
      writeFileSync(this.path(assetId), bytes, { flag: "wx" });
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO offers VALUES(?,?,?,?,?)")
      .run(
        id,
        assetId,
        sessionId,
        Date.now() + 86400000,
        JSON.stringify(source),
      );
    return id;
  }
  offered(id: string, sessionId: string) {
    const r = this.db
      .prepare("SELECT * FROM offers WHERE id=? AND sessionId=? AND expires>?")
      .get(id, sessionId, Date.now()) as any;
    if (!r) fail("media_ref", "这张临时图片不属于本会话或已过期。");
    return {
      bytes: readFileSync(this.path(r.assetId)),
      source: JSON.parse(r.json) as Source,
    };
  }
  expireOffers() {
    const rows = this.db
      .prepare("SELECT assetId FROM offers WHERE expires<=?")
      .all(Date.now());
    this.db.prepare("DELETE FROM offers WHERE expires<=?").run(Date.now());
    for (const r of rows) {
      const id = String(r.assetId);
      if (
        !this.has(id) &&
        !this.db.prepare("SELECT 1 FROM offers WHERE assetId=?").get(id) &&
        existsSync(this.path(id))
      )
        unlinkSync(this.path(id));
    }
  }
  restoreMetadata(a: Asset, v?: Vector) {
    const prior = this.get(a.id);
    this.save({
      ...a,
      id: prior.id,
      mime: prior.mime,
      bytes: prior.bytes,
      width: prior.width,
      height: prior.height,
      frames: prior.frames,
      indexState: v ? "ready" : "pending",
    });
    if (v) this.putVector(a.id, v, a.revision);
  }
  importBackup(
    bytes: Buffer,
    media: Pick<Asset, "mime" | "width" | "height" | "frames">,
    record: {
      asset: Asset;
      vector?: Vector;
      history?: { assetId: string; json: string }[];
    },
    source: Source,
  ) {
    const id = hash(bytes),
      existed = this.has(id),
      hadObject = existsSync(this.path(id));
    try {
      return this.transaction(() => {
        const a = this.add(
          bytes,
          media,
          {
            description: record.asset.description,
            tags: record.asset.tags,
            purposes: record.asset.purposes,
            archived: record.asset.archived,
          },
          source,
        );
        if (!existed) {
          this.restoreMetadata(
            { ...a, ...record.asset, id: a.id },
            record.vector,
          );
          for (const h of record.history ?? [])
            if (h.assetId === a.id && typeof h.json === "string")
              this.db
                .prepare("INSERT INTO history(assetId,json) VALUES(?,?)")
                .run(a.id, h.json);
        }
        return this.get(id);
      });
    } catch (e) {
      if (!hadObject && !this.has(id) && existsSync(this.path(id)))
        unlinkSync(this.path(id));
      throw e;
    }
  }
}
