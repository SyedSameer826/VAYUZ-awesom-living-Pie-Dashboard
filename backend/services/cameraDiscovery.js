import { exec } from "child_process";
import net from "net";

// Subnets to sweep for cameras. The Pi sits on 192.168.50.x, but CP Plus cameras
// often ship on 192.168.1.x, so we scan both (the Pi has an address on each).
const SCAN_SUBNETS =
  process.env.CAMERA_SCAN_SUBNETS || "192.168.1.0/24 192.168.50.0/24";

// Ports we probe:
//  - 554   : RTSP (video). Open only AFTER a camera is activated.
//  - 37777 : CP Plus / Dahua service port. Open even BEFORE activation, so it
//            lets us spot a brand-new camera that hasn't been set up yet.
const SCAN_PORTS = "554,37777";

// Step 1: sweep the network; for each host, note which of our ports are open.
const findCameraHosts = () =>
  new Promise((resolve, reject) => {
    exec(
      `nmap -sT -p ${SCAN_PORTS} --open -T4 -oG - ${SCAN_SUBNETS}`,
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return reject(error);

        const hosts = [];
        for (const line of stdout.split("\n")) {
          if (!line.startsWith("Host:") || !line.includes("Ports:")) continue;
          const ip = line.split(/\s+/)[1];
          const has554 = /\b554\/open\b/.test(line);
          const has37777 = /\b37777\/open\b/.test(line);
          if (ip && (has554 || has37777)) {
            hosts.push({ ip, has554, has37777 });
          }
        }
        resolve(hosts);
      },
    );
  });

// Confirm a host actually speaks RTSP (an activated, streamable camera).
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

// Find cameras and classify each:
//   "ready"       -> RTSP is up; it can be mapped now.
//   "needs_setup" -> a CP Plus camera (service port open) that isn't activated.
export const discoverCameras = async () => {
  const hosts = await findCameraHosts();

  const cameras = [];
  for (const host of hosts) {
    let state = "needs_setup";

    if (host.has554 && (await speaksRtsp(host.ip))) {
      state = "ready";
    } else if (!host.has37777) {
      // 554 was open but it didn't speak RTSP, and it's not a CP Plus service
      // port either -> not a camera, skip it.
      continue;
    }

    cameras.push({ ip: host.ip, state });
  }
  return cameras;
};
