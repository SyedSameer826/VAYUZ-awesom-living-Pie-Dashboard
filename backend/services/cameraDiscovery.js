import { exec } from "child_process";
import net from "net";

// Subnets to sweep for cameras. The Pi sits on 192.168.50.x, but CP Plus cameras
// often ship on 192.168.1.x, so we scan both (the Pi has an address on each).
// Overridable via env if the network layout changes.
const SCAN_SUBNETS =
  process.env.CAMERA_SCAN_SUBNETS || "192.168.1.0/24 192.168.50.0/24";

// Step 1: sweep the network for hosts with the RTSP port (554) open — the same
// approach used to find the first camera by hand. TCP connect scan => no root.
const findRtspHosts = () =>
  new Promise((resolve, reject) => {
    exec(
      `nmap -sT -p 554 --open -T4 -oG - ${SCAN_SUBNETS}`,
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        // nmap can exit non-zero in benign cases but still print results.
        if (error && !stdout) return reject(error);

        const ips = [];
        for (const line of stdout.split("\n")) {
          if (line.startsWith("Host:") && line.includes("554/open")) {
            const ip = line.split(/\s+/)[1];
            if (ip) ips.push(ip);
          }
        }
        resolve(ips);
      },
    );
  });

// Step 2: confirm a host actually SPEAKS RTSP — i.e. it's really a camera/NVR,
// not just some device (a laptop, NAS, etc.) that happens to have 554 open.
// We send an RTSP OPTIONS request; a real camera replies with an "RTSP/..."
// status line (200 OK, or 401 if it wants auth — both prove it's a camera).
const speaksRtsp = (ip, timeout = 3000) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("data", (data) => finish(data.toString().includes("RTSP/")));
    socket.connect(554, ip, () => {
      socket.write(
        `OPTIONS rtsp://${ip}:554 RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: awesomliving-pair\r\n\r\n`,
      );
    });
  });

// Find cameras: sweep for open RTSP ports, then verify each actually speaks RTSP
// so non-camera devices are filtered out and never shown as pairable cameras.
export const discoverCameras = async () => {
  const hosts = await findRtspHosts();

  const cameras = [];
  for (const ip of hosts) {
    if (await speaksRtsp(ip)) {
      cameras.push({ ip });
    }
  }
  return cameras;
};
