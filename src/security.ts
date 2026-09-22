import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";

const blockedAddresses = new net.BlockList();

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
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv6");
}

export interface ResolvedRemoteUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

const defaultLookupAll: LookupAll = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

export function isBlockedRemoteAddress(address: string, family: 4 | 6): boolean {
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) return true;
  return blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

export async function resolveSafeRemoteUrl(
  rawUrl: string,
  allowHttpForTests = false,
  lookupAll: LookupAll = defaultLookupAll,
): Promise<ResolvedRemoteUrl> {
  const url = new URL(rawUrl);
  const allowedProtocol = url.protocol === "https:" || (allowHttpForTests && url.protocol === "http:");
  if (!allowedProtocol) throw new Error(`Unsupported download protocol: ${url.protocol}`);
  if (url.username || url.password) throw new Error("Download URL credentials are not allowed");

  const hostname = normalizedHostname(url);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    if (!allowHttpForTests) throw new Error("Localhost download URLs are not allowed");
    return { url, address: "127.0.0.1", family: 4 };
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    const family = literalFamily as 4 | 6;
    if (isBlockedRemoteAddress(hostname, family) && !allowHttpForTests) {
      throw new Error("Private or reserved-network download URLs are not allowed");
    }
    return { url, address: hostname, family };
  }

  const addresses = await lookupAll(hostname);
  if (addresses.length === 0) throw new Error("Download host did not resolve");

  for (const { address, family } of addresses) {
    if ((family !== 4 && family !== 6) || net.isIP(address) !== family) {
      throw new Error("Download host resolved to an invalid address");
    }
    if (isBlockedRemoteAddress(address, family) && !allowHttpForTests) {
      throw new Error("Download host resolves to a private or reserved-network address");
    }
  }

  const selected = addresses[0]!;
  return { url, address: selected.address, family: selected.family };
}

export async function assertSafeRemoteUrl(rawUrl: string, allowHttpForTests = false): Promise<URL> {
  return (await resolveSafeRemoteUrl(rawUrl, allowHttpForTests)).url;
}

export async function resolveSafeTarget(root: string, destination: string): Promise<{ root: string; target: string }> {
  if (!destination || destination.endsWith("/") || destination.endsWith(path.sep)) {
    throw new Error("destination must be a file path");
  }

  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const target = path.resolve(canonicalRoot, destination);
  const relative = path.relative(canonicalRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("destination escapes FILE_SAVE_ROOT");
  }

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const parentRelative = path.relative(canonicalRoot, canonicalParent);
  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
    throw new Error("destination parent escapes FILE_SAVE_ROOT through a symlink");
  }

  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("refusing to write through a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return { root: canonicalRoot, target };
}
