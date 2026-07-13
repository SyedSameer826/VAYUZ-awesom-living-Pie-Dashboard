import { exec } from "child_process";

// Subnets to sweep for cameras. The Pi sits on 192.168.50.x, but CP Plus cameras
// can ship on 192.168.1.x, so we scan both (the Pi has an address on each).
const SCAN_SUBNETS =
  process.env.CAMERA_SCAN_SUBNETS || "192.168.1.0/24 192.168.50.0/24";
const SCAN_IFACE = process.env.CAMERA_SCAN_IFACE || "eth0";

// MAC vendor prefixes (OUI) that identify our cameras. `f8:20:97` is the CP Plus
// vendor seen on these units. Add other makes via env (comma-separated) if needed.
const CAMERA_OUIS = (process.env.CAMERA_OUIS || "f8:20:97")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ARP-scan a range -> [{ ip, mac }] for everything that answers. This finds a
// camera by its hardware address even when it's brand-new / unactivated — which
// a port scan can't do. (We deliberately do NOT try to guess "activated vs not"
// from the network: a camera's RTSP port can be open in either state, so that
// guess is unreliable. The UI offers both Set Up and Map and lets the user pick.)
const arpScan = (range) =>
  new Promise((resolve) => {
    exec(
      `sudo arp-scan --interface=${SCAN_IFACE} ${range}`,
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

// Find cameras by MAC vendor across the scanned subnets.
export const discoverCameras = async () => {
  const seen = new Map(); // ip -> mac
  for (const range of SCAN_SUBNETS.split(/\s+/).filter(Boolean)) {
    const rows = await arpScan(range);
    for (const r of rows) seen.set(r.ip, r.mac);
  }

  const cameras = [];
  for (const [ip, mac] of seen) {
    const oui = mac.slice(0, 8); // e.g. "f8:20:97"
    if (CAMERA_OUIS.includes(oui)) cameras.push({ ip });
  }
  return cameras;
};
