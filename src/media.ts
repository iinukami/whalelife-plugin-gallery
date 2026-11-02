/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import sharp, { type Metadata } from "sharp";
import { MAX_IMAGE, fail } from "./types.ts";

export async function inspectImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_IMAGE)
    fail("image_size", "图片须小于 25 MiB。");
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    fail("image", "图片无法解码或尺寸过大。");
  }
  const mime = (
    {
      png: "image/png",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    } as Record<string, string>
  )[meta.format ?? ""];
  if (!mime || !meta.width || !meta.height)
    fail("image", "只支持 PNG、JPEG、WebP 和 GIF。");
  const height = meta.pageHeight ?? meta.height;
  if (meta.width * height > 40_000_000 || (meta.pages ?? 1) > 10000)
    fail("image_size", "图片尺寸或动图帧数过大。");
  return { mime, width: meta.width, height, frames: meta.pages ?? 1 };
}
export async function sampledFrames(bytes: Buffer, signal: AbortSignal) {
  const meta = await inspectImage(bytes);
  const count = Math.min(5, meta.frames);
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    signal.throwIfAborted();
    const page =
      count === 1 ? 0 : Math.round((i * (meta.frames - 1)) / (count - 1));
    const image = await sharp(bytes, {
      page,
      pages: 1,
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    signal.throwIfAborted();
    result.push("data:image/png;base64," + image.toString("base64"));
  }
  return { frames: result, total: meta.frames };
}
export async function thumbnail(bytes: Buffer, signal: AbortSignal) {
  signal.throwIfAborted();
  const result = await sharp(bytes, {
    page: 0,
    pages: 1,
    limitInputPixels: 40_000_000,
  })
    .rotate()
    .resize({
      width: 400,
      height: 300,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 78 })
    .toBuffer();
  signal.throwIfAborted();
  return result;
}
