import { exec } from "child_process";
import net from "net";
import os from "os";

// Subnets to sweep for cameras. The Pi sits on 192.168.50.x, but CP Plus cameras
// can ship on 192.168.1.x, so we scan both (the Pi has an address on each).
const SCAN_SUBNETS =
  process.env.CAMERA_SCAN_SUBNETS || "192.168.1.0/24 192.168.50.0/24";

// MAC vendor prefixes (OUI) that identify our cameras. `f8:20:97` is the CP Plus
// vendor seen on these units. Add other makes via env (comma-separated) if needed.
// Common CP Plus / Dahua OUIs: f8:20:97, 3c:ef:8c, a0:bd:1d, 40:2c:76, 90:02:a9
const CAMERA_OUIS = (
  process.env.CAMERA_OUIS ||
  "f8:20:97,3c:ef:8c,a0:bd:1d,40:2c:76,90:02:a9,4c:11:bf,00:0a:eb,e0:50:8b,bc:32:5f,a8:48:fa"
)
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Ports that cameras typically expose. Used for the port-probe fallback when
// OUI-based detection finds nothing (e.g. rebranded cameras with unknown MACs).
const CAMERA_PROBE_PORTS = [554, 80];

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

/**
 * Get all local IPv4 addresses (to exclude from camera results).
 */
const getLocalIps = () => {
  const ips = new Set();
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const info of addrs || []) {
      if (info.family === "IPv4") ips.add(info.address);
    }
  }
  return ips;
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

/**
 * TCP connect probe — returns true if the port is open (accepts a connection).
 * Used as a fallback to identify cameras when OUI matching fails.
 */
const checkPort = (ip, port, timeout = 2000) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, ip);
  });

/**
 * Probe an IP for camera-like open ports (RTSP 554, HTTP 80).
 * A host with RTSP open is almost certainly a camera.
 * A host with only HTTP 80 open could be a router, so we require RTSP
 * OR both HTTP 80 + HTTPS 443 (cameras serve their web UI on both).
 */
const probeIsCamera = async (ip) => {
  const rtsp_open = await checkPort(ip, 554);
  if (rtsp_open) return true;

  // No RTSP — check if both 80 and 443 are open (camera web UI pattern).
  // Routers usually only have 80 open; cameras serve on both.
  const [http_open, https_open] = await Promise.all([
    checkPort(ip, 80),
    checkPort(ip, 443),
  ]);
  return http_open && https_open;
};

// Find cameras by MAC vendor across the scanned subnets,
// with port-probe fallback for unknown/rebranded MAC vendors.
export const discoverCameras = async () => {
  const seen = new Map(); // ip -> mac
  const useArpScan = await hasArpScan();
  const local_ips = getLocalIps();

  for (const range of SCAN_SUBNETS.split(/\s+/).filter(Boolean)) {
    let rows = [];
    if (useArpScan) {
      // Auto-detect the correct interface for this subnet
      const iface = detectInterface(range);
      if (iface) {
        console.log(`[camera_scan] arp-scan ${range} on ${iface}`);
        rows = await arpScan(range, iface);
      } else {
        // No interface matches this subnet — try all active interfaces
        const active = getActiveInterfaces();
        for (const ifName of active) {
          console.log(`[camera_scan] arp-scan ${range} on ${ifName} (fallback)`);
          const r = await arpScan(range, ifName);
          rows.push(...r);
        }
      }
    }

    // Fallback to nmap if arp-scan isn't installed or found nothing
    if (rows.length === 0) {
      console.log(`[camera_scan] nmap -sn ${range} (fallback)`);
      rows = await nmapScan(range);
    }

    for (const r of rows) seen.set(r.ip, r.mac);
  }

  console.log(
    `[camera_scan] network scan found ${seen.size} host(s):`,
    [...seen.entries()].map(([ip, mac]) => `${ip} (${mac})`).join(", ") || "none",
  );

  // --- Pass 1: OUI-based detection (fast, preferred) ---
  const cameras = [];
  const unmatched_hosts = [];

  for (const [ip, mac] of seen) {
    // Skip the Pi itself and common gateway addresses
    if (local_ips.has(ip) || ip.endsWith(".1")) continue;

    const oui = mac.slice(0, 8); // e.g. "f8:20:97"
    if (CAMERA_OUIS.includes(oui)) {
      console.log(`[camera_scan] OUI match: ${ip} (${mac})`);
      cameras.push({ ip, mac });
    } else {
      unmatched_hosts.push({ ip, mac });
    }
  }

  // --- Pass 2: port-probe fallback for hosts with unknown MACs ---
  // If OUI matching found cameras, skip the slower port probe.
  if (cameras.length === 0 && unmatched_hosts.length > 0) {
    console.log(
      `[camera_scan] no OUI match — probing ${unmatched_hosts.length} host(s) for camera ports (RTSP 554, HTTP 80/443)...`,
    );
    console.log(`[camera_scan] known OUIs: ${CAMERA_OUIS.join(", ")}`);

    const probe_results = await Promise.all(
      unmatched_hosts.map(async ({ ip, mac }) => {
        const is_camera = await probeIsCamera(ip);
        console.log(
          `[camera_scan] probe ${ip} (${mac}): ${is_camera ? "CAMERA" : "not a camera"}`,
        );
        return is_camera ? { ip, mac } : null;
      }),
    );

    for (const result of probe_results) {
      if (result) cameras.push(result);
    }
  }

  // --- Pass 3: direct probe of common static IPs as last resort ---
  // CP Plus cameras sometimes ship with static IPs outside the Pi's subnet
  // (192.168.1.108, 192.168.1.109, etc.) and won't appear in the ARP/nmap
  // scan if the Pi has no interface on that subnet. Try a few well-known
  // defaults directly via TCP connect.
  if (cameras.length === 0) {
    const direct_ips = [
      "192.168.1.108",
      "192.168.1.109",
      "192.168.1.110",
      "192.168.1.20",
    ];
    console.log(
      `[camera_scan] still nothing — direct-probing factory defaults: ${direct_ips.join(", ")}`,
    );
    for (const ip of direct_ips) {
      if (seen.has(ip) || local_ips.has(ip)) continue;
      const is_camera = await probeIsCamera(ip);
      if (is_camera) {
        console.log(`[camera_scan] direct probe HIT: ${ip}`);
        cameras.push({ ip, mac: "unknown" });
      }
    }
  }

  if (cameras.length === 0) {
    console.log("[camera_scan] no cameras found after all passes");
  } else {
    console.log(
      `[camera_scan] found ${cameras.length} camera(s): ${cameras.map((c) => c.ip).join(", ")}`,
    );
  }

  return cameras;
};
