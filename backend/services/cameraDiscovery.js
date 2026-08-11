import { exec } from "child_process";
import os from "os";

// Subnets to sweep for cameras. The Pi sits on 192.168.50.x, but CP Plus cameras
// can ship on 192.168.1.x, so we scan both (the Pi has an address on each).
const SCAN_SUBNETS =
  process.env.CAMERA_SCAN_SUBNETS || "192.168.1.0/24 192.168.50.0/24";

// MAC vendor prefixes (OUI) that identify our cameras. `f8:20:97` is the CP Plus
// vendor seen on these units. Add other makes via env (comma-separated) if needed.
// Common CP Plus / Dahua OUIs: f8:20:97, 3c:ef:8c, a0:bd:1d, 40:2c:76, 90:02:a9
const CAMERA_OUIS = (
  process.env.CAMERA_OUIS || "f8:20:97,3c:ef:8c,a0:bd:1d,40:2c:76,90:02:a9"
)
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Auto-detect the best network interface for scanning a given subnet.
 * Returns the interface name whose IPv4 address falls in the same /24 as the
 * target range, or null if none matches (in which case we let the tool pick).
 */
const detectInterface = (range) => {
  // Extract the first 3 octets from the range (e.g. "192.168.50" from "192.168.50.0/24")
  const prefix = range.replace(/\.\d+\/\d+$/, "");
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const info of addrs || []) {
      if (info.family === "IPv4" && !info.internal && info.address.startsWith(prefix + ".")) {
        return name;
      }
    }
  }
  return null;
};

/**
 * Get all active, non-loopback network interface names.
 */
const getActiveInterfaces = () => {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const info of addrs || []) {
      if (info.family === "IPv4" && !info.internal) {
        result.push(name);
        break;
      }
    }
  }
  return result;
};

// ARP-scan a range -> [{ ip, mac }] for everything that answers.
const arpScan = (range, iface) =>
  new Promise((resolve) => {
    const ifaceArg = iface ? `--interface=${iface} ` : "";
    exec(
      `sudo arp-scan ${ifaceArg}${range}`,
      { timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const rows = [];
        for (const line of (stdout || "").split("\n")) {
          // Lines look like:  192.168.50.100  f8:20:97:37:b5:11  (Unknown)
          const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]{17})/i);
          if (m) rows.push({ ip: m[1], mac: m[2].toLowerCase() });
        }
        resolve(rows);
      },
    );
  });

// Fallback: nmap ping-scan + MAC extraction. Works without arp-scan and does
// not need a specific interface — it scans the routing table automatically.
const nmapScan = (range) =>
  new Promise((resolve) => {
    exec(
      `sudo nmap -sn ${range}`,
      { timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        const rows = [];
        const lines = (stdout || "").split("\n");
        let currentIp = null;
        for (const line of lines) {
          const ipMatch = line.match(/Nmap scan report for (\d+\.\d+\.\d+\.\d+)/);
          if (ipMatch) {
            currentIp = ipMatch[1];
          }
          const macMatch = line.match(/MAC Address:\s+([0-9A-F:]{17})/i);
          if (macMatch && currentIp) {
            rows.push({ ip: currentIp, mac: macMatch[1].toLowerCase() });
            currentIp = null;
          }
        }
        resolve(rows);
      },
    );
  });

// Check if arp-scan is available.
const hasArpScan = () =>
  new Promise((resolve) => {
    exec("which arp-scan", (error) => resolve(!error));
  });

// Find cameras by MAC vendor across the scanned subnets.
export const discoverCameras = async () => {
  const seen = new Map(); // ip -> mac
  const useArpScan = await hasArpScan();

  for (const range of SCAN_SUBNETS.split(/\s+/).filter(Boolean)) {
    let rows = [];
    if (useArpScan) {
      // Auto-detect the correct interface for this subnet
      const iface = detectInterface(range);
      if (iface) {
        console.log(`🔍 Camera scan: arp-scan ${range} on ${iface}`);
        rows = await arpScan(range, iface);
      } else {
        // No interface matches this subnet — try all active interfaces
        const active = getActiveInterfaces();
        for (const ifName of active) {
          console.log(`🔍 Camera scan: arp-scan ${range} on ${ifName} (fallback)`);
          const r = await arpScan(range, ifName);
          rows.push(...r);
        }
      }
    }

    // Fallback to nmap if arp-scan isn't installed or found nothing
    if (rows.length === 0) {
      console.log(`🔍 Camera scan: nmap -sn ${range} (fallback)`);
      rows = await nmapScan(range);
    }

    for (const r of rows) seen.set(r.ip, r.mac);
  }

  const cameras = [];
  for (const [ip, mac] of seen) {
    const oui = mac.slice(0, 8); // e.g. "f8:20:97"
    if (CAMERA_OUIS.includes(oui)) cameras.push({ ip, mac });
  }

  // If no cameras found by OUI, log what we did find for debugging
  if (cameras.length === 0 && seen.size > 0) {
    console.log(
      "📷 Camera scan: no OUI match. Hosts found:",
      [...seen.entries()].map(([ip, mac]) => `${ip} (${mac})`).join(", "),
    );
    console.log("📷 Looking for OUIs:", CAMERA_OUIS.join(", "));
  }

  return cameras;
};
