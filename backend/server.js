import express from "express";
import cors from "cors";
import fs from "fs";
import yaml from "js-yaml";
import axios from "axios";
import http from "http";
import https from "https";
import crypto from "crypto";
import os from "os";
import { exec } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

import { Server } from "socket.io";

import { initSocket } from "./socket/socket.js";
import zigbeeRoutes from "./routes/zigbee.routes.js";
import {
  getDevices,
  upsertDevice,
  deleteDevice,
} from "./services/deviceStore.js";
import mqttClient from "./mqtt/mqttClient.js";
import { pendingDeletes } from "./utils/deleteState.js";
import { discoverCameras } from "./services/cameraDiscovery.js";
import {
  createProxyMiddleware,
  responseInterceptor,
} from "http-proxy-middleware";

const app = express();

/* =========================
   PATH CONFIG
========================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   MIDDLEWARE
========================= */

app.use(cors());

app.use(express.json());

/* =========================
   ROUTES
========================= */

app.use("/api/zigbee", zigbeeRoutes);

/* =========================
   ZIGBEE CONFIG
========================= */

const CONFIG_PATH = "/home/pi/zigbee2mqtt/data/configuration.yaml";

/* =========================
   REMOTE BACKEND + GO2RTC
========================= */

// Main backend this Pi maps devices to. Overridable via env; defaults to the EC2.
const REMOTE_BACKEND =
  process.env.REMOTE_BACKEND_URL || "http://51.20.102.125";

// Local go2rtc instance on the Pi (used to register camera streams).
const GO2RTC_URL = process.env.GO2RTC_URL || "http://localhost:1984";

/* =========================
   CP PLUS CAMERA CONFIG API (HTTP Digest)
   CP Plus cameras (Dahua OEM) expose an HTTP config API but require HTTP Digest
   auth over their self-signed HTTPS cert. axios has no built-in digest, so we do
   the standard two-step handshake by hand: fire an unauthenticated request to
   read the WWW-Authenticate challenge, compute the digest response, then retry.
========================= */

// Accept the camera's self-signed certificate.
const cameraTlsAgent = new https.Agent({ rejectUnauthorized: false });

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// Perform a single GET against a camera's config API using HTTP Digest auth.
// `pathWithQuery` must start with "/" (e.g. "/cgi-bin/configManager.cgi?...").
const cameraDigestGet = async (ip, pathWithQuery, user, pass) => {
  const url = `https://${ip}${pathWithQuery}`;

  // Step 1: unauthenticated request to obtain the digest challenge.
  let challenge = null;
  try {
    await axios.get(url, { httpsAgent: cameraTlsAgent, timeout: 8000 });
  } catch (err) {
    if (err.response?.status === 401) {
      challenge = err.response.headers["www-authenticate"];
    } else {
      throw err; // network error / unreachable — surface it
    }
  }
  if (!challenge) {
    throw new Error("Camera did not return a digest auth challenge");
  }

  // Step 2: parse the challenge and compute the digest response.
  const field = (k) =>
    (challenge.match(new RegExp(`${k}="?([^",]+)"?`)) || [])[1];
  const realm = field("realm");
  const nonce = field("nonce");
  const qop = field("qop");
  const opaque = field("opaque");
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`GET:${pathWithQuery}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let auth =
    `Digest username="${user}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${pathWithQuery}", response="${response}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;

  // Step 3: retry with the Authorization header.
  const res = await axios.get(url, {
    httpsAgent: cameraTlsAgent,
    headers: { Authorization: auth },
    timeout: 8000,
  });
  return res.data;
};

/* =========================
   PER-CAMERA REVERSE PROXY
   A camera on the default subnet (192.168.1.x) can't be opened from the user's
   laptop, but the Pi can reach it. So we stand up a small reverse proxy on the
   Pi — one dedicated port per camera — that forwards EVERYTHING at its root to
   the camera over HTTPS. The user opens http://<pi-ip>:<port>/ (which the laptop
   CAN reach) and gets the camera's real page, relayed by the Pi. Because we
   proxy at the root (not under a sub-path), the camera's relative asset/API URLs
   resolve correctly — that's what made the old /camera-proxy/<ip> approach flaky.
========================= */

const cameraProxies = new Map(); // ip -> { port, server }
const CAMERA_PROXY_BASE_PORT = 9100;

// Start (or reuse) a reverse proxy for a camera IP; returns its port.
const startCameraProxy = (ip) => {
  const existing = cameraProxies.get(ip);
  if (existing) return existing.port;

  // Stable, unique-ish port derived from the last IP octet.
  const lastOctet = parseInt(ip.split(".").pop(), 10) || 0;
  const port = CAMERA_PROXY_BASE_PORT + (lastOctet % 300);

  const proxyApp = express();
  proxyApp.use(
    "/",
    createProxyMiddleware({
      target: `https://${ip}`,
      changeOrigin: true, // send Host: <camera-ip> so its host check passes
      secure: false, // accept the camera's self-signed cert
      ws: true, // relay websockets (live view, etc.)
      followRedirects: true,
      onProxyReq: (proxyReq) => {
        // The camera 400s any request whose Referer/Origin isn't itself (its
        // anti-framing check). The browser sends our proxy origin, so rewrite
        // both to the camera's own URL — this is why the JS/CSS were 400ing.
        proxyReq.setHeader("Referer", `https://${ip}/`);
        proxyReq.setHeader("Origin", `https://${ip}`);
      },
      onProxyRes: (proxyRes) => {
        // Let the browser keep the session over plain HTTP: drop the cookie
        // Secure flag and the camera's HSTS header (which would otherwise force
        // the browser back to https on this proxy origin).
        const setCookie = proxyRes.headers["set-cookie"];
        if (setCookie) {
          proxyRes.headers["set-cookie"] = setCookie.map((c) =>
            c.replace(/;\s*Secure/gi, "").replace(/;\s*SameSite=None/gi, ""),
          );
        }
        delete proxyRes.headers["strict-transport-security"];
      },
      onError: (err, req, res) => {
        if (res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
        }
        if (res) res.end(`Camera proxy error: ${err.message}`);
      },
    }),
  );

  const proxyServer = http.createServer(proxyApp);
  proxyServer.on("error", (e) =>
    console.log("⚠️ camera proxy server error", ip, e.message),
  );
  proxyServer.listen(port, () =>
    console.log(`🎥 camera setup proxy for ${ip} on :${port}`),
  );

  cameraProxies.set(ip, { port, server: proxyServer });
  return port;
};

/* =========================
   GET DEVICES
========================= */

app.get("/api/devices", (req, res) => {
  try {
    const devices = getDevices();

    res.json(devices);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

/* =========================
   ASSIGN DEVICE NAME
========================= */

app.post("/api/assign-name", async (req, res) => {
  try {
    const { zigbee_ieee, zigbee_name, resident, zigbee_type, room } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authorization token missing" });
    }
    const token = authHeader.split(" ")[1];

    const detectedType =
      zigbee_type === "door & window" ? "contact" : zigbee_type;

    // Step 1: Update devices.json
    upsertDevice({
      ieee_address: zigbee_ieee,
      name: zigbee_name,
      type: detectedType,
      resident,
      status: "mapped",
      is_unassigned: false,
    });

    // Step 2: Check device exists in Z2M and get its current friendly name
    const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (!config.devices[zigbee_ieee]) {
      return res.status(404).json({ error: "Device not found in Z2M" });
    }
    const currentFriendlyName =
      config.devices[zigbee_ieee].friendly_name || zigbee_ieee;

    // Step 3: Rename via Z2M MQTT API — updates Z2M in-memory + YAML instantly, no restart needed
    mqttClient.publish(
      "zigbee2mqtt/bridge/request/device/rename",
      JSON.stringify({ from: currentFriendlyName, to: zigbee_name }),
    );

    // Step 4: Send to remote backend
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    const response = await axios.post(
      `${REMOTE_BACKEND}/api/user/devices`,
      {
        type: "Zigbee",
        resident,
        name: zigbee_name,
        id: zigbee_name,
        ieee: zigbee_ieee,
        sensor_type: zigbee_type,
        room: room || "bathroom",
      },
    );

    res.json({ success: true, backend_response: response.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   ASSIGN CAMERA (CP Plus)
   Mirrors /api/assign-name, but for a CP Plus camera:
   registers the RTSP stream in go2rtc, records it locally, then
   maps it to a resident on the remote backend as a CpPlus device.
========================= */

app.post("/api/assign-camera", async (req, res) => {
  try {
    const { stream_name, local_ip, rtsp_url, resident, room } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authorization token missing" });
    }
    const token = authHeader.split(" ")[1];

    if (!stream_name || !resident) {
      return res
        .status(400)
        .json({ error: "stream_name and resident are required" });
    }

    // Step 1: (Re)register the stream in go2rtc. Delete any existing stream with
    // this name first so go2rtc drops a stale/failed connection and reconnects
    // cleanly — this removes the need to run `pm2 restart go2rtc` by hand, and
    // only affects this one camera (other streams keep running). Then add fresh.
    if (rtsp_url) {
      try {
        await axios.delete(`${GO2RTC_URL}/api/streams`, {
          params: { src: stream_name },
        });
      } catch (delErr) {
        // Stream may not exist yet — that's fine, we're about to create it.
      }
      try {
        await axios.put(`${GO2RTC_URL}/api/streams`, null, {
          params: { name: stream_name, src: rtsp_url },
        });
      } catch (streamErr) {
        console.log(
          "⚠️ go2rtc stream register failed:",
          streamErr.response?.status,
          streamErr.message,
        );
      }
    }

    // Step 2: Record locally so the camera shows as mapped in the device list.
    // Cameras have no IEEE address — use the (unique) stream_name as the key.
    upsertDevice({
      ieee_address: stream_name,
      name: stream_name,
      type: "camera",
      resident,
      status: "mapped",
      is_unassigned: false,
      local_ip,
      stream_name,
    });

    // Step 3: Map to the remote backend as a CpPlus device.
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    const response = await axios.post(
      `${REMOTE_BACKEND}/api/user/devices`,
      {
        type: "CpPlus",
        resident,
        stream_name,
        local_ip,
        room: room || "living_room",
      },
    );

    res.json({ success: true, backend_response: response.data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

/* =========================
   CAMERA PAIRING (discovery)
   Sweeps the network for cameras (RTSP port open) — the same approach used to
   find the first camera by hand. Any newly found camera is recorded locally as
   an UNMAPPED camera so it shows up in the device listing, ready to be mapped.
========================= */

app.post("/api/camera/pair/scan", async (req, res) => {
  try {
    const found = await discoverCameras(); // [{ ip }]
    const existing = getDevices();

    const cameras = found.map((cam) => {
      const known = existing.find(
        (d) => d.type === "camera" && d.local_ip === cam.ip,
      );

      if (known) {
        return {
          ip: cam.ip,
          stream_name: known.stream_name,
          status: known.status,
          already_known: true,
        };
      }

      // Suggest a unique, stable stream name derived from the IP. The camera is
      // only added to the device list when the user actually Maps it (we can't
      // reliably tell from the network whether it's configured yet).
      const parts = cam.ip.split(".");
      const suggested = `cam_${parts[2]}_${parts[3]}`;

      return {
        ip: cam.ip,
        stream_name: suggested,
        status: "unmapped",
        already_known: false,
      };
    });

    res.json({ success: true, cameras });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   ENABLE DHCP ON A CAMERA
   For a camera that shipped / was set with a STATIC IP on the camera-default
   subnet (192.168.1.x, DHCP off), the user's laptop can't reach it — but the Pi
   can (it has an address on that subnet too). This turns the camera's DHCP on
   via its config API and reboots it, so it comes back on the main network with a
   normal address, ready for the usual Set Up + Map flow.
========================= */

app.post("/api/camera/enable-dhcp", async (req, res) => {
  try {
    const { ip, password } = req.body;
    if (!ip || !password) {
      return res
        .status(400)
        .json({ error: "Camera IP and admin password are required" });
    }

    // 1) Turn DHCP on for the wired interface. Dahua/CP Plus uses the config key
    //    Network.eth0.DhcpEnable; setting it true persists to the camera's flash.
    await cameraDigestGet(
      ip,
      "/cgi-bin/configManager.cgi?action=setConfig&Network.eth0.DhcpEnable=true",
      "admin",
      password,
    );

    // 2) Reboot so it drops the static IP and pulls a fresh DHCP lease cleanly.
    //    The reboot usually kills the connection before it can answer — that's
    //    expected, so we ignore an error here.
    try {
      await cameraDigestGet(
        ip,
        "/cgi-bin/magicBox.cgi?action=reboot",
        "admin",
        password,
      );
    } catch (rebootErr) {
      // Connection dropped as the camera rebooted — normal.
    }

    res.json({
      success: true,
      message:
        "DHCP enabled. The camera is rebooting — wait ~1 minute, then Rescan.",
    });
  } catch (err) {
    // A 401 here means the password was wrong or the camera isn't set up yet.
    const status = err.response?.status;
    const msg =
      status === 401
        ? "Login failed — check the admin password (the camera must already be set up)."
        : err.response?.data ||
          err.message ||
          "Could not reach the camera to enable DHCP";
    res.status(500).json({ error: msg });
  }
});

/* =========================
   OPEN CAMERA SETUP (via Pi reverse proxy)
   Opens the camera's own web page through the Pi so a laptop that can't reach
   the camera's subnet can still configure it (e.g. turn DHCP on). Returns a URL
   on the Pi that the browser CAN reach; the Pi relays it to the camera.
========================= */

app.post("/api/camera/open-setup", (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ error: "Camera IP is required" });
    }
    const port = startCameraProxy(ip);
    // Build the URL on the same host the user is already hitting the Pi at
    // (e.g. 192.168.50.50), just on the camera's dedicated proxy port.
    const host = req.hostname || "192.168.50.50";
    const url = `http://${host}:${port}/`;
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/devices/:ieee", async (req, res) => {
  try {
    const { ieee } = req.params;

    // The remote backend delete is authenticated — pull the caller's Bearer
    // token off this request and pass it down so deviceStore can forward it.
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : undefined;

    // Cameras are handled differently from Zigbee devices: drop their go2rtc
    // stream (so it stops), then delete locally + on the remote backend. No
    // Zigbee "remove" is sent (a camera isn't a Zigbee device).
    const device = getDevices().find((d) => d.ieee_address === ieee);
    if (device?.type === "camera") {
      const streamName = device.stream_name || ieee;
      try {
        await axios.delete(`${GO2RTC_URL}/api/streams`, {
          params: { src: streamName },
        });
      } catch (streamErr) {
        console.log(
          "⚠️ go2rtc stream delete failed:",
          streamErr.response?.status,
          streamErr.message,
        );
      }
      await deleteDevice(ieee, token); // removes from devices.json + remote backend
      console.log("✅ Camera delete complete for:", ieee);
      return res.json({ success: true, message: "Camera deleted" });
    }

    // ---- Zigbee device delete ----
    // Mark this as a current-session (intentional) delete BEFORE publishing
    // the Z2M remove. mqttClient.js only acts on remove confirmations whose
    // ieee is in pendingDeletes, so stale retained confirmations that re-fire
    // on restart are ignored and can never wipe a mapped device.
    pendingDeletes.add(ieee);

    // Remove from devices.json AND from the remote backend (incl. its logs).
    await deleteDevice(ieee, token);

    // Ask Z2M to remove the device. NOTE: no `force: true` — force adds the
    // device to the Z2M blocklist and permanently prevents re-pairing it.
    mqttClient.publish(
      "zigbee2mqtt/bridge/request/device/remove",
      JSON.stringify({ id: ieee }),
    );

    console.log("✅ Delete complete for:", ieee);
    return res.json({ success: true, message: "Device deleted" });
  } catch (err) {
    // Don't leave a stale marker behind if the delete failed.
    pendingDeletes.delete(req.params.ieee);
    console.log("❌ Delete failed:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});
/* =========================
   SOCKET SERVER
========================= */

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

initSocket(io);

/* =========================
   CAMERA PAGE PROXY
   Serves a camera's own web UI under our origin (/camera-proxy/<ip>/...) so it
   can be embedded inside the Pie platform. We fetch it over HTTPS (cameras use
   self-signed certs) and spoof the Referer so the camera's anti-framing check
   passes. HTML asset paths are rewritten to keep loading through the proxy.
   NOTE: best-effort — some CP Plus UI requests are built dynamically in JS and
   can't be rewritten, so parts of the page may still not work.
========================= */

app.use(
  "/camera-proxy/:ip",
  createProxyMiddleware({
    changeOrigin: true,
    secure: false, // accept the camera's self-signed certificate
    ws: true,
    followRedirects: true, // chase the camera's login redirects server-side
    logLevel: "debug", // logs the forwarded target + status -> `pm2 logs`
    router: (req) => `https://${req.params.ip}`,
    pathRewrite: (path, req) => {
      // Defensively strip our mount prefix if it's still on the path.
      const prefix = `/camera-proxy/${req.params.ip}`;
      const stripped = path.startsWith(prefix)
        ? path.slice(prefix.length)
        : path;
      return stripped || "/";
    },
    onProxyReq: (proxyReq, req) => {
      // Spoof only the Referer to pass the camera's anti-framing check.
      // (We intentionally do NOT set Origin — it can trip CSRF checks.)
      proxyReq.setHeader("Referer", `https://${req.params.ip}/`);
    },
    onProxyRes: responseInterceptor(async (buffer, proxyRes, req) => {
      const type = proxyRes.headers["content-type"] || "";
      if (!type.includes("text/html")) return buffer;

      const ip = req.params.ip;
      let html = buffer.toString("utf8");
      // Make relative + root-absolute URLs resolve back through the proxy.
      html = html.replace(
        /<head([^>]*)>/i,
        `<head$1><base href="/camera-proxy/${ip}/">`,
      );
      html = html.replace(
        /(src|href|action)=("|')\//g,
        `$1=$2/camera-proxy/${ip}/`,
      );
      return html;
    }),
    selfHandleResponse: true,
  }),
);

/* =========================
   SERVE REACT BUILD
========================= */

const frontendPath = path.join(__dirname, "../frontend/dist");
app.use("/hls", express.static("/home/pi/hls"));
app.use(express.static(frontendPath));

app.use((req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

/* =========================
   HUB HEARTBEAT (Pi -> backend, every 30s)
   Tells the cloud backend the Pi is alive and how good its internet is. The
   backend infers "offline / no power" when these stop arriving for > 30 min
   (a dead Pi can't phone home). We also report a graded internet level so the
   family app can show connection quality live.
========================= */

const HUB_HEARTBEAT_INTERVAL_MS = 30 * 1000;

// Stable per-Pi id from the CPU serial (falls back to hostname).
let cachedHubId = null;
const getHubId = () => {
  if (cachedHubId) return cachedHubId;
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const m = cpuinfo.match(/Serial\s*:\s*([0-9a-fA-F]+)/);
    if (m) cachedHubId = `pi-${m[1]}`;
  } catch {
    /* not a Pi / no cpuinfo — fall through */
  }
  if (!cachedHubId) cachedHubId = `pi-${os.hostname()}`;
  return cachedHubId;
};

// A resident this Pi manages, so the backend can bind the hub to the right
// home/family. Uses the first mapped device's resident from devices.json.
const getManagedResident = () => {
  try {
    const device = getDevices().find((d) => d.resident && d.status === "mapped");
    return device ? device.resident : null;
  } catch {
    return null;
  }
};

// Grade internet quality by pinging a nearby anycast host (8.8.8.8). Returns a
// level + avg latency, or { level: null } if ping is unavailable/blocked (the
// caller then relies on the heartbeat POST itself to prove connectivity).
const measureInternet = () =>
  new Promise((resolve) => {
    exec("ping -c 3 -w 5 8.8.8.8", (err, stdout = "") => {
      const lossMatch = stdout.match(/(\d+)% packet loss/);
      const avgMatch = stdout.match(/=\s*[\d.]+\/([\d.]+)\//);
      const loss = lossMatch ? parseInt(lossMatch[1], 10) : 100;
      const avg = avgMatch ? parseFloat(avgMatch[1]) : null;

      if (!err && avg != null && loss < 100) {
        let level;
        if (loss > 20 || avg > 150) level = "online-poor";
        else if (avg > 60) level = "online-good";
        else level = "online-excellent";
        return resolve({ level, ms: Math.round(avg) });
      }
      resolve({ level: null, ms: null }); // unknown via ping
    });
  });

const sendHeartbeat = async () => {
  try {
    const { level, ms } = await measureInternet();
    const payload = {
      hub_id: getHubId(),
      resident: getManagedResident(),
      // If ping couldn't grade it but the POST below succeeds, we're at least
      // online — report a safe middle tier rather than nothing.
      internet_level: level || "online-good",
      latency_ms: ms,
    };
    const headers = {};
    if (process.env.HUB_SECRET_KEY) {
      headers["x-hub-secret"] = process.env.HUB_SECRET_KEY;
    }
    await axios.post(`${REMOTE_BACKEND}/api/hub/heartbeat`, payload, {
      timeout: 8000,
      headers,
    });
  } catch (err) {
    // No connectivity to the backend — the backend's 30-min timeout will flip
    // this hub offline. Nothing to do here but log.
    console.log("⚠️ hub heartbeat failed:", err.message);
  }
};

/* =========================
   START SERVER
========================= */

server.listen(4000, () => {
  console.log("Server running on port 4000");
  // Kick off the heartbeat once the server is up, then every 30s.
  sendHeartbeat();
  setInterval(sendHeartbeat, HUB_HEARTBEAT_INTERVAL_MS);
});
