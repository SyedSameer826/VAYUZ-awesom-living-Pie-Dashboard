import { exec } from "child_process";

// Subnets to sweep for cameras. The Pi sits on 192.168.50.x, but CP Plus cameras
// often ship on 192.168.1.x, so we scan both (the Pi has an address on each).
// Overridable via env if the network layout changes.
const SCAN_SUBNETS =
  process.env.CAMERA_SCAN_SUBNETS || "192.168.1.0/24 192.168.50.0/24";

// Find cameras the same way we found the first one by hand: sweep the network
// and pick out hosts that have the RTSP port (554) open. A TCP connect scan
// (-sT) needs no root, so it runs fine as the pm2 user.
export const discoverCameras = () =>
  new Promise((resolve, reject) => {
    exec(
      `nmap -sT -p 554 --open -T4 -oG - ${SCAN_SUBNETS}`,
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        // nmap exits non-zero in some benign cases but still prints results,
        // so only fail if we got nothing back at all.
        if (error && !stdout) return reject(error);

        const cameras = [];
        for (const line of stdout.split("\n")) {
          // Greppable line for a host with the RTSP port open looks like:
          // Host: 192.168.1.38 ()  Ports: 554/open/tcp//rtsp///
          if (line.startsWith("Host:") && line.includes("554/open")) {
            const ip = line.split(/\s+/)[1];
            if (ip) cameras.push({ ip });
          }
        }
        resolve(cameras);
      },
    );
  });
