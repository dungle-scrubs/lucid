import { lookup } from "node:dns/promises";
import { BlockList, connect, isIP } from "node:net";
import { checkServerIdentity, connect as connectTls } from "node:tls";

export interface LinkAddress {
  readonly address: string;
  readonly family: number;
}
export interface LinkResponse {
  readonly location: string | undefined;
  readonly status: number;
}
export type WebLinkResult =
  | { readonly status: "valid" }
  | { readonly reason: string; readonly status: "broken" | "unverified" };
export type WebLinkProbe = (url: string, signal: AbortSignal) => Promise<WebLinkResult>;
export interface WebLinkTransport {
  readonly resolve: (hostname: string) => Promise<readonly LinkAddress[]>;
  readonly send: (url: URL, address: LinkAddress, signal: AbortSignal) => Promise<LinkResponse>;
}

const special = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  special.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  special.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicLinkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !special.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !special.check(address, "ipv6");
  return false;
}

/** A bounded HTTP/1 header probe over a directly addressed socket. Bun's
 * fetch and node:http both inherit environment proxies even after lookup;
 * direct sockets make the checked address the actual connection destination. */
export function requestLinkAddress(
  url: URL,
  address: LinkAddress,
  signal: AbortSignal,
): Promise<LinkResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("link check cancelled"));
      return;
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    const socket =
      url.protocol === "https:"
        ? connectTls({
            checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
            host: address.address,
            port,
            rejectUnauthorized: true,
            servername: isIP(hostname) ? undefined : hostname,
          })
        : connect({ host: address.address, port });
    let settled = false;
    let headers = Buffer.alloc(0);
    let total = 0;
    const finish = (result: LinkResponse | Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const abort = (): void => finish(new Error("link check cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("connection closed before response headers")));
    socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: Lucid-Link-Check/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      // Keep at most the header limit even if body bytes arrive in this chunk.
      const room = 16_384 - total;
      const part = chunk.subarray(0, room);
      headers = Buffer.concat([headers, part]);
      total += part.length;
      for (;;) {
        const end = headers.indexOf("\r\n\r\n");
        if (end < 0) break;
        const lines = headers.subarray(0, end).toString("latin1").split("\r\n");
        headers = headers.subarray(end + 4);
        const status = Number(/^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(lines[0] ?? "")?.[1]);
        if (!status) {
          finish(new Error("invalid HTTP status"));
          return;
        }
        if (status >= 100 && status < 200 && status !== 101) continue;
        const locations = lines.slice(1).filter((line) => /^location:/i.test(line));
        if (locations.length > 1) {
          finish(new Error("ambiguous redirect headers"));
          return;
        }
        finish({ location: locations[0]?.slice("location:".length).trim(), status });
        return;
      }
      if (total >= 16_384) finish(new Error("response headers exceed limit"));
    });
    if (signal.aborted) abort();
  });
}

/** Also bounds DNS and injected transports that do not implement cancellation. */
export function untilAborted<TValue>(
  promise: Promise<TValue>,
  signal: AbortSignal,
): Promise<TValue> {
  if (signal.aborted) return Promise.reject(new Error("link check cancelled or timed out"));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error("link check cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function checkWebLink(
  href: string,
  signal: AbortSignal,
  transport: WebLinkTransport = {
    resolve: (hostname) => lookup(hostname, { all: true }),
    send: requestLinkAddress,
  },
): Promise<WebLinkResult> {
  try {
    let url = new URL(href);
    const visited = new Set<string>();
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        return { reason: "unsupported or credential-bearing destination", status: "unverified" };
      }
      url.hash = "";
      if (visited.has(url.href)) return { reason: "redirect loop", status: "unverified" };
      visited.add(url.href);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const family = isIP(hostname);
      const addresses = family
        ? [{ address: hostname, family }]
        : await untilAborted(transport.resolve(hostname), signal);
      if (
        addresses.length === 0 ||
        addresses.some(
          (entry) => !isPublicLinkAddress(entry.address) || isIP(entry.address) !== entry.family,
        )
      ) {
        return { reason: "destination is not a public network address", status: "unverified" };
      }
      const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
      if (!address) return { reason: "DNS returned no addresses", status: "unverified" };
      const response = await untilAborted(transport.send(url, address, signal), signal);
      if (response.status >= 200 && response.status < 300) return { status: "valid" };
      if (response.status === 404 || response.status === 410)
        return { reason: `HTTP ${response.status}`, status: "broken" };
      if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
        url = new URL(response.location, url);
        continue;
      }
      return {
        reason: `HTTP ${response.status}${response.status >= 300 && response.status < 400 ? " without a usable redirect" : ""}`,
        status: "unverified",
      };
    }
    return { reason: "more than five redirects", status: "unverified" };
  } catch {
    return {
      reason: signal.aborted
        ? "check cancelled or timed out"
        : "DNS, connection, or TLS check failed",
      status: "unverified",
    };
  }
}
