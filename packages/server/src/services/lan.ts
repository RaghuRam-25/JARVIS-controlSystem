import os from "os";

export interface LanInterface {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  isWireless: boolean;
}

/**
 * Discovers available local network IPv4 addresses, prioritizing Wi-Fi interfaces.
 */
export function getLocalIpAddresses(): LanInterface[] {
  const interfaces = os.networkInterfaces();
  const results: LanInterface[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        const isWireless = /wi-?fi|wlan|wireless|802\.11/i.test(name);
        results.push({
          name,
          address: addr.address,
          family: "IPv4",
          isWireless,
        });
      }
    }
  }

  // Sort wireless interfaces first, followed by ethernet
  results.sort((a, b) => (b.isWireless ? 1 : 0) - (a.isWireless ? 1 : 0));

  if (results.length === 0) {
    results.push({
      name: "loopback",
      address: "127.0.0.1",
      family: "IPv4",
      isWireless: false,
    });
  }

  return results;
}

export function getPrimaryLocalIp(): string {
  const list = getLocalIpAddresses();
  return list[0]?.address || "127.0.0.1";
}
