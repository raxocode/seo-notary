import { isIP } from "node:net";

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "cgnat"
  | "link_local"
  | "metadata"
  | "unspecified"
  | "multicast"
  | "reserved";

const METADATA_V4 = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);

export function parseIPv4(input: string): number[] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Returns eight 16-bit groups, or null when malformed. A zone id (%eth0) is ignored. */
export function parseIPv6(input: string): number[] | null {
  const addr = input.split("%")[0] ?? "";
  if (isIP(addr) !== 6) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    const parts = s.split(":");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] ?? "";
      if (p.includes(".")) {
        if (i !== parts.length - 1) return null;
        const v4 = parseIPv4(p);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
        out.push(parseInt(p, 16));
      }
    }
    return out;
  };
  const left = toGroups(halves[0] ?? "");
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = toGroups(halves[1] ?? "");
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function classifyV4(o: number[]): AddressClass {
  const [a, b, c] = [o[0]!, o[1]!, o[2]!];
  if (METADATA_V4.has(o.join("."))) return "metadata";
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 169 && b === 254) return "link_local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved";
  if (a === 192 && b === 88 && c === 99) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function classifyV6(g: number[]): AddressClass {
  const [g0, g1, g2, , , g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

  if (zeros(0, 8)) return "unspecified";
  if (zeros(0, 7) && g7 === 1) return "loopback";
  if (zeros(0, 5) && g5 === 0xffff) return classifyV4(v4FromGroups(g6, g7)); // IPv4-mapped
  if (zeros(0, 6)) return "reserved"; // deprecated IPv4-compatible
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (zeros(2, 6)) return classifyV4(v4FromGroups(g6, g7)); // NAT64
    return "reserved";
  }
  if (g0 === 0x2002) return classifyV4(v4FromGroups(g1, g2)); // 6to4
  if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return "reserved"; // Teredo, ORCHID, docs, IETF
  if (g0 === 0x100 && zeros(1, 4)) return "reserved"; // discard-only
  if (g0 === 0xfd00 && g1 === 0x0ec2 && zeros(2, 7) && g7 === 0x254) return "metadata";
  if ((g0 & 0xffc0) === 0xfe80) return "link_local";
  if ((g0 & 0xffc0) === 0xfec0) return "private"; // deprecated site-local
  if ((g0 & 0xfe00) === 0xfc00) return "private"; // ULA
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  if ((g0 & 0xe000) === 0x2000) return "public";
  return "reserved";
}

/** Unparseable input is "reserved" so it can never be treated as public. */
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address.split("%")[0] ?? "");
  if (family === 4) {
    const o = parseIPv4(address);
    return o ? classifyV4(o) : "reserved";
  }
  if (family === 6) {
    const g = parseIPv6(address);
    return g ? classifyV6(g) : "reserved";
  }
  return "reserved";
}
