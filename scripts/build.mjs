/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  existsSync,
  rmSync,
  readdirSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url)),
  out = join(root, "dist", "gallery");
if (existsSync(out)) {
  if (
    lstatSync(out).isSymbolicLink() ||
    existsSync(join(out, "data")) ||
    dirname(resolve(out)) !== resolve(root, "dist")
  )
    throw Error(
      "Refusing to replace a build containing user data or an unsafe path",
    );
  rmSync(out, { recursive: true });
}
mkdirSync(out, { recursive: true });
for (const file of ['LICENSE', 'LICENSE-ADDITIONAL', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md'])
  cpSync(join(root, file), join(out, file));
for (const f of [
  "src",
  "index.ts",
  "plugin.yaml",
  "package.json",
  "package-lock.json",
  "README.md",
  "CONTRACT.md",
])
  if (existsSync(join(root, f)))
    cpSync(join(root, f), join(out, f), { recursive: true });
const npm = join(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const result = spawnSync(
  process.execPath,
  [npm, "ls", "--omit=dev", "--all", "--parseable"],
  { cwd: root, encoding: "utf8", windowsHide: true },
);
if (result.status !== 0)
  throw Error(result.stderr || "Cannot resolve production dependencies");
for (const p of result.stdout.trim().split(/\r?\n/).slice(1)) {
  const rel = relative(root, p);
  if (!rel.startsWith("node_modules") || rel.includes(".."))
    throw Error("Unexpected dependency path");
  cpSync(p, join(out, rel), { recursive: true });
}
const files = {};
function visit(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) visit(p);
    else
      files[relative(out, p).replaceAll("\\", "/")] = createHash("sha256")
        .update(readFileSync(p))
        .digest("hex");
  }
}
visit(out);
writeFileSync(
  join(out, "BUILD.json"),
  JSON.stringify(
    {
      version: "0.1.2",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      files,
    },
    null,
    2,
  ),
);
console.log(`Built ${Object.keys(files).length} files in ${out}`);
