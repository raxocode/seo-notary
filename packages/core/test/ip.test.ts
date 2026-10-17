import { describe, expect, it } from "vitest";
import { classifyAddress, type AddressClass } from "../src/index.js";
import { parseIPv6 } from "../src/ip.js";

const cases: [string, AddressClass][] = [
  ["8.8.8.8", "public"],
  ["1.1.1.1", "public"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "loopback"],
  ["10.1.2.3", "private"],
  ["172.16.0.1", "private"],
  ["172.31.255.255", "private"],
  ["172.32.0.1", "public"],
  ["192.168.0.1", "private"],
  ["100.64.0.1", "cgnat"],
  ["100.127.255.255", "cgnat"],
  ["100.128.0.1", "public"],
  ["169.254.0.1", "link_local"],
  ["169.254.169.254", "metadata"],
  ["100.100.100.200", "metadata"],
  ["0.0.0.0", "unspecified"],
  ["224.0.0.1", "multicast"],
  ["255.255.255.255", "reserved"],
  ["240.0.0.1", "reserved"],
  ["192.0.2.1", "reserved"],
  ["198.51.100.7", "reserved"],
  ["203.0.113.9", "reserved"],
  ["198.18.0.1", "reserved"],
  ["::", "unspecified"],
  ["::1", "loopback"],
  ["fe80::1", "link_local"],
  ["fe80::1%eth0", "link_local"],
  ["fd00::1", "private"],
  ["fc00::1", "private"],
  ["fd00:ec2::254", "metadata"],
  ["ff02::1", "multicast"],
  ["2001:db8::1", "reserved"],
  ["2606:4700:4700::1111", "public"],
  ["2001:4860:4860::8888", "public"],
  ["::ffff:127.0.0.1", "loopback"],
  ["::ffff:7f00:1", "loopback"],
  ["::ffff:10.0.0.1", "private"],
  ["::ffff:a00:1", "private"],
  ["::ffff:169.254.169.254", "metadata"],
  ["::ffff:8.8.8.8", "public"],
  ["64:ff9b::7f00:1", "loopback"],
  ["64:ff9b::808:808", "public"],
  ["2002:7f00:1::", "loopback"],
  ["2002:808:808::", "public"],
  ["::7f00:1", "reserved"],
  ["not-an-ip", "reserved"],
  ["", "reserved"],
];

describe("classifyAddress", () => {
  it.each(cases)("%s -> %s", (addr, expected) => {
    expect(classifyAddress(addr)).toBe(expected);
  });
});

describe("parseIPv6", () => {
  it("expands :: and embedded IPv4", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("rejects malformed input", () => {
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("hello")).toBeNull();
  });
});
