/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { BlockList, isIP } from "node:net";
import { Agent, ProxyAgent, fetch, type Dispatcher } from "undici";
import { fail } from "./types.ts";

const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
] as const)
  blocked.addSubnet(ip, bits, "ipv6");
export function publicIP(address: string) {
  const family = isIP(address);
  return (
    !!family &&
    !blocked.check(address, family === 4 ? "ipv4" : "ipv6") &&
    !address.toLowerCase().startsWith("::ffff:")
  );
}
export async function publicURL(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("url", "图片地址无效。");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    fail("url", "只支持公开 HTTP(S) 图片地址。");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicIP(a.address)))
    fail("url", "不能从图片链接读取本机或内网地址。");
  return { url, addresses };
}
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  if (!addresses.length) fail("network", "图片地址没有可用的网络地址。");
  const pinned = addresses.map((a) => ({ ...a }));
  return (_hostname, options, callback) => {
    // Node's automatic address-family selection requests the DNS all:true shape.
    // Reuse only the previously validated addresses for both callback forms.
    if (options.all) callback(null, pinned);
    else callback(null, pinned[0].address, pinned[0].family);
  };
}
export async function requestBytes(
  url: string,
  options: {
    signal: AbortSignal;
    limit: number;
    proxy?: string;
    timeout?: number;
    publicOnly?: boolean;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<Buffer> {
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeout ?? 60000),
  ]);
  let target = url;
  for (let redirect = 0; redirect <= 4; redirect++) {
    signal.throwIfAborted();
    let dispatcher: Dispatcher;
    if (options.publicOnly) {
      const verified = await publicURL(target);
      signal.throwIfAborted();
      dispatcher = options.proxy
        ? new ProxyAgent(options.proxy)
        : new Agent({
            connect: {
              lookup: pinnedLookup(verified.addresses),
            },
          });
    } else
      dispatcher = options.proxy ? new ProxyAgent(options.proxy) : new Agent();
    try {
      const response = await fetch(target, {
        method: options.body === undefined ? "GET" : "POST",
        redirect: "manual",
        dispatcher,
        signal,
        headers: { "User-Agent": "WhaleLife-Gallery/0.1", ...options.headers },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        options.body === undefined
      ) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) fail("network", "下载重定向缺少目标。");
        target = new URL(location, target).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail("network", `请求失败（HTTP ${response.status}）。`);
      }
      if (Number(response.headers.get("content-length")) > options.limit) {
        await response.body?.cancel();
        fail("too_large", "文件或模型响应超过大小限制。");
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body!) {
        signal.throwIfAborted();
        length += chunk.length;
        if (length > options.limit) {
          fail("too_large", "文件或模型响应超过大小限制。");
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      await dispatcher.destroy();
    }
  }
  fail("network", "重定向次数过多。");
}
