import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import yaml from "js-yaml";
import axios from "axios";
import http from "http";
import https from "https";
import crypto from "crypto";
import os from "os";
import { exec, execFile } from "child_process";
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

// Main backend this Pi maps devices to. Overridable via env; defaults to production.
const REMOTE_BACKEND =
  process.env.REMOTE_BACKEND_URL || "https://qa.awesomliving.com";

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
    const { zigbee_ieee, zigbee_name, home_id, zigbee_type, room, resident } = req.body;
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
      home_id,
      status: "mapped",
      is_unassigned: false,
    });

    // Step 2: Read Z2M config and rename if device is known there.
    // The device may exist in devices.json (discovered via MQTT bridge) but NOT
    // yet in Z2M's configuration.yaml (e.g. devices section missing on fresh
    // installs). Handle gracefully — skip the rename, still forward to backend.
    let currentFriendlyName = zigbee_ieee;
    try {
      const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (config.devices && config.devices[zigbee_ieee]) {
        currentFriendlyName =
          config.devices[zigbee_ieee].friendly_name || zigbee_ieee;

        // Step 3: Rename via Z2M MQTT API — updates Z2M in-memory + YAML instantly, no restart needed
        mqttClient.publish(
          "zigbee2mqtt/bridge/request/device/rename",
          JSON.stringify({ from: currentFriendlyName, to: zigbee_name }),
        );
      } else {
        console.log("⚠️ Device not in Z2M config — skipping rename, will still map to backend:", zigbee_ieee);
      }
    } catch (configErr) {
      console.log("⚠️ Could not read Z2M config — skipping rename:", configErr.message);
    }

    // Step 4: Send to remote backend
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    const response = await axios.post(
      `${REMOTE_BACKEND}/api/user/devices`,
      {
        type: "Zigbee",
        name: zigbee_name,
        id: zigbee_name,
        ieee: zigbee_ieee,
        sensor_type: detectedType,
        room: room || "bathroom",
        home: home_id || readHubConfig().home_id || undefined,
        resident: resident || undefined,
      },
    );

    res.json({ success: true, backend_response: response.data });
  } catch (err) {
    const remoteMsg = err.response?.data?.error_message || err.response?.data?.message || err.message;
    console.error("assign-name remote error:", remoteMsg, err.response?.data);
    res.status(err.response?.status || 500).json({ error: remoteMsg });
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
    const { stream_name, local_ip, rtsp_url, home_id, room, resident } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authorization token missing" });
    }
    const token = authHeader.split(" ")[1];

    if (!stream_name) {
      return res
        .status(400)
        .json({ error: "stream_name is required" });
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

    // Persist the RTSP URL in go2rtc.yaml so the stream survives restarts.
    if (rtsp_url) persistStreamConfig(stream_name, rtsp_url);

    // Step 2: Record locally so the camera shows as mapped in the device list.
    // Cameras have no IEEE address — use the (unique) stream_name as the key.
    upsertDevice({
      ieee_address: stream_name,
      name: stream_name,
      type: "camera",
      home_id,
      status: "mapped",
      is_unassigned: false,
      local_ip,
      stream_name,
      rtsp_url: rtsp_url || null,
    });

    // Step 3: Map to the remote backend as a CpPlus device. Include this Pi's
    // hub_id so the backend can resolve the correct go2rtc tunnel URL, and
    // the full RTSP URL so the stream can be re-provisioned on restart.
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    const response = await axios.post(
      `${REMOTE_BACKEND}/api/user/devices`,
      {
        type: "CpPlus",
        stream_name,
        local_ip,
        room: room || "living_room",
        hub_id: getHubId(),
        rtsp_url: rtsp_url || null,
        home: home_id || readHubConfig().home_id || undefined,
        resident: resident || undefined,
      },
    );

    res.json({ success: true, backend_response: response.data });
  } catch (err) {
    const remoteMsg = err.response?.data?.error_message || err.response?.data?.message || err.message;
    console.error("assign-camera remote error:", remoteMsg, err.response?.data);
    res.status(err.response?.status || 500).json({ error: remoteMsg });
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
   GLK SLEEP MONITOR PAIRING (BLE provisioning + mapping)
   The GLK monitor is set up over BLE ONCE: we write the home WiFi creds (0x1F)
   and this Pi's server address (0x23 = Pi IP + port 8766). After that it joins
   WiFi and streams sleep data over TCP to the Pi's glk_bridge on :8766. This
   backend shells out to a Python provisioner (which reuses the verified
   glk_protocol.py) for the BLE work, then maps the device to a resident on the
   remote backend as an Emfit-type device (sr_num = the 12-digit serial).
========================= */

// Python provisioner command. Override GLK_PROVISION_CMD to point at the GLK
// team's own glk_ble_config.py if you prefer, as long as it accepts the same
// `scan` / `provision` subcommands and prints the same JSON.
const GLK_PYTHON = process.env.GLK_PYTHON || "python3";
const GLK_SCRIPT =
  process.env.GLK_PROVISION_CMD || path.join(__dirname, "glk", "glk_provision.py");

// The Pi's LAN IP that the GLK device should connect back to (the 0x23 config).
// Prefer the main-subnet (192.168.50.x) address; fall back to any non-internal
// IPv4. Must match the Pi's reserved DHCP IP so the device can always find it.
const getPiLanIp = () => {
  const ifaces = os.networkInterfaces();
  let fallback = null;
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === "IPv4" && !info.internal) {
        if (info.address.startsWith("192.168.50.")) return info.address;
        fallback = fallback || info.address;
      }
    }
  }
  return fallback || "192.168.50.50";
};

// Scan for GLK devices in provisioning mode (advertising "LZ-OTA <serial>").
app.post("/api/glk/scan", (req, res) => {
  execFile(
    GLK_PYTHON,
    [GLK_SCRIPT, "scan", "--timeout", "8"],
    { timeout: 25000, cwd: path.join(__dirname, "glk") },
    (err, stdout, stderr) => {
      if (err && !stdout) {
        return res
          .status(500)
          .json({ error: stderr || err.message || "GLK scan failed" });
      }
      try {
        return res.json(JSON.parse(stdout));
      } catch {
        return res
          .status(500)
          .json({ error: "Unexpected scan output", raw: stdout, stderr });
      }
    },
  );
});

// Provision a chosen GLK device onto WiFi + this Pi, then map it to a resident.
app.post("/api/glk/pair", async (req, res) => {
  try {
    const { address, serial, ssid, password, resident, room } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authorization token missing" });
    }
    const token = authHeader.split(" ")[1];

    if (!address || !ssid || !password || !resident) {
      return res.status(400).json({
        error: "address, ssid, password and resident are required",
      });
    }

    const piIp = getPiLanIp();

    // 1) BLE provision (write WiFi + server config, wait for the fff2 acks).
    let provisionStderr = "";
    const provision = await new Promise((resolve, reject) => {
      execFile(
        GLK_PYTHON,
        [
          GLK_SCRIPT,
          "provision",
          "--address",
          address,
          "--ssid",
          ssid,
          "--password",
          password,
          "--pi-ip",
          piIp,
          "--port",
          "8766",
        ],
        { timeout: 90000, cwd: path.join(__dirname, "glk") },
        (err, stdout, stderr) => {
          provisionStderr = stderr || "";
          if (provisionStderr) console.error("[GLK pair] stderr:\n" + provisionStderr);
          if (err && !stdout) {
            return reject(new Error(stderr || err.message));
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error(`Unexpected provision output: ${stdout}`));
          }
        },
      );
    });

    if (!provision.success) {
      return res
        .status(422)
        .json({ error: "GLK provisioning failed", detail: provision, stderr: provisionStderr });
    }

    // 2) Record locally so the device shows in the Pie device list.
    upsertDevice({
      ieee_address: serial || address,
      name: serial || address,
      type: "glk",
      resident,
      status: "mapped",
      is_unassigned: false,
      sr_num: serial,
    });

    // 3) Map to the remote backend as an Emfit-type device (GLK vitals path).
    // Non-fatal — BLE provisioning already succeeded + device saved locally, so
    // don't discard that work if the remote backend is temporarily unreachable.
    let backend_response = null;
    let remote_error = null;
    try {
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
      const backend = await axios.post(`${REMOTE_BACKEND}/api/user/devices`, {
        type: "Emfit",
        resident,
        sr_num: serial,
        room: room || "bedroom",
        home: readHubConfig().home_id || undefined,
      });
      backend_response = backend.data;
    } catch (remoteErr) {
      remote_error =
        remoteErr.response?.data || remoteErr.message || "Remote registration failed";
      console.error("[GLK pair] remote registration failed (device saved locally):", remote_error);
    }

    res.json({
      success: true,
      device_saved: true,
      pi_ip: piIp,
      provision,
      backend_response,
      remote_error,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
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

    // Non-Zigbee devices (camera, GLK) are handled separately — no Z2M remove.
    const device = getDevices().find((d) => d.ieee_address === ieee);

    // ---- GLK device delete ----
    // GLK is mapped to the cloud backend as type "Emfit" with sr_num.
    // Delete locally + from the remote backend by sr_num.
    if (device?.type === "glk") {
      // Delete from remote backend (find by sr_num, then delete by _id)
      if (token && device.sr_num) {
        try {
          const headers = { Authorization: `Bearer ${token}` };
          // Find the device on the remote backend by sr_num
          const remoteDevices = await axios.get(
            `${REMOTE_BACKEND}/api/user/devices`,
            { headers, timeout: 8000 },
          );
          const remoteDevice = remoteDevices.data?.data?.find(
            (d) => d.sr_num === device.sr_num,
          );
          if (remoteDevice?._id) {
            await axios.delete(
              `${REMOTE_BACKEND}/api/user/devices/${remoteDevice._id}`,
              { headers, timeout: 8000 },
            );
            console.log("✅ GLK device deleted from cloud backend:", device.sr_num);
          }
        } catch (remoteErr) {
          console.log(
            "⚠️ GLK cloud delete failed (local delete continues):",
            remoteErr.response?.data || remoteErr.message,
          );
        }
      }
      await deleteDevice(ieee, token);
      console.log("✅ GLK delete complete for:", ieee);
      return res.json({ success: true, message: "Device deleted" });
    }

    // ---- Camera delete ----
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
   HUB SETUP (first-time home selection)
   Persists the home_id this Pi hub is linked to in a local JSON file.
   The frontend calls GET /api/hub/setup to check, POST to save.
========================= */

const HUB_CONFIG_DIR =
  process.env.DEVICES_DIR || path.join(os.homedir(), "awesomliving-data");
const HUB_CONFIG_PATH = path.join(HUB_CONFIG_DIR, "hub-config.json");

// Ensure data directory exists.
fs.mkdirSync(HUB_CONFIG_DIR, { recursive: true });

const readHubConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(HUB_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
};

const writeHubConfig = (config) => {
  fs.writeFileSync(HUB_CONFIG_PATH, JSON.stringify(config, null, 2));
};

app.get("/api/hub/setup", (req, res) => {
  const config = readHubConfig();
  res.json({
    configured: !!config.home_id,
    home_id: config.home_id || null,
    hub_id: config.hub_id || getHubId(),
    tunnel_url: config.tunnel_url || null,
  });
});

app.post("/api/hub/setup", (req, res) => {
  const { home_id, tunnel_url } = req.body;
  if (!home_id) {
    return res.status(400).json({ error: "home_id is required" });
  }

  const config = readHubConfig();
  config.home_id = home_id;
  config.hub_id = getHubId();
  config.configured_at = new Date().toISOString();
  if (tunnel_url) config.tunnel_url = tunnel_url.replace(/\/+$/, "");
  writeHubConfig(config);

  res.json({ success: true, configured: true, home_id, hub_id: config.hub_id });
});

// Separate endpoint to update tunnel URL (called by the setup script after
// starting the Cloudflare tunnel, or manually from the dashboard).
app.post("/api/hub/tunnel", (req, res) => {
  const { tunnel_url } = req.body;
  if (!tunnel_url) {
    return res.status(400).json({ error: "tunnel_url is required" });
  }

  const config = readHubConfig();
  config.tunnel_url = tunnel_url.replace(/\/+$/, "");
  writeHubConfig(config);

  res.json({ success: true, tunnel_url: config.tunnel_url });
});

/* =========================
   GLK STATUS STORE
   Tracks GLK device online/offline state, firmware, last vitals, and session
   stats locally on the Pi — mirrors the hub-config.json pattern. Written by
   the /api/glk/vitals handler below; read by GET /api/glk/status.
========================= */

const GLK_STATUS_PATH = path.join(HUB_CONFIG_DIR, "glk-status.json");

const readGlkStatus = () => {
  try {
    return JSON.parse(fs.readFileSync(GLK_STATUS_PATH, "utf8"));
  } catch {
    return {};
  }
};

const writeGlkStatus = (status) => {
  fs.writeFileSync(GLK_STATUS_PATH, JSON.stringify(status, null, 2));
};

/* =========================
   GLK VITALS PROXY
   glk_bridge.py on the Pi forwards sleep/vitals data to localhost:4000/api/glk/vitals.
   This endpoint:
     1. Stores device_status events locally in glk-status.json
     2. Caches latest vitals/sleep_stage locally for quick reads
     3. Relays ALL data to the cloud backend's /api/health endpoint
========================= */

app.post("/api/glk/vitals", async (req, res) => {
  const { serial_number, data, timestamp } = req.body;
  const data_type = data?.type || "realtime";

  // ── Local state updates (non-blocking) ──
  try {
    const glk = readGlkStatus();
    const device_key = serial_number || "unknown";

    if (!glk[device_key]) {
      glk[device_key] = {};
    }
    const dev = glk[device_key];

    if (data_type === "device_status" && data.event === "connected") {
      dev.online = true;
      dev.firmware = data.firmware || dev.firmware;
      dev.device_type = data.device_type || dev.device_type;
      dev.ip_address = data.ip_address || dev.ip_address;
      dev.last_connected = data.connection_time || timestamp;
      dev.last_seen = timestamp;
      console.log(
        `🟢 GLK ${device_key} connected (fw=${data.firmware}, ip=${data.ip_address})`,
      );
    } else if (data_type === "device_status" && data.event === "disconnected") {
      dev.online = false;
      dev.last_disconnected = data.disconnect_time || timestamp;
      dev.last_session = {
        duration_seconds: data.session_duration_seconds,
        time_syncs: data.time_syncs_this_session,
        sleep_stages: data.sleep_stages_this_session,
        realtime_frames: data.realtime_frames_this_session,
        disconnect_reason: data.disconnect_reason,
      };
      dev.last_seen = timestamp;
      console.log(
        `🔴 GLK ${device_key} disconnected (reason=${data.disconnect_reason}, ` +
          `duration=${data.session_duration_seconds}s, ` +
          `sleep_stages=${data.sleep_stages_this_session})`,
      );
    } else if (data_type === "emergency") {
      dev.last_emergency = { ...data, timestamp };
      dev.last_seen = timestamp;
      console.log(`🚨 GLK ${device_key} EMERGENCY — life_abnormality detected`);
    } else if (data_type === "sleep_stage") {
      dev.last_sleep_stage = {
        stage: data.sleep_stage,
        heart_rate: data.heart_rate,
        respiration_rate: data.respiration_rate,
        battery_level: data.battery_level,
        timestamp,
      };
      dev.last_seen = timestamp;
    } else {
      // Realtime vitals (no type field)
      dev.last_vitals = {
        heart_rate: data.heart_rate,
        respiration_rate: data.respiration_rate,
        status: data.status,
        in_bed: data.in_bed,
        snoring: data.snoring,
        apnea_suspected: data.apnea_suspected,
        life_abnormality: data.life_abnormality,
        body_movement: data.body_movement,
        battery_level: data.battery_level,
        signal_quality: data.signal_quality,
        timestamp,
      };
      dev.online = true;
      dev.last_seen = timestamp;
    }

    writeGlkStatus(glk);
  } catch (err) {
    // Never let local state writes block the cloud relay
    console.log("⚠️ GLK local status write failed:", err.message);
  }

  // ── Relay to cloud backend ──
  try {
    const response = await axios.post(
      `${REMOTE_BACKEND}/api/health`,
      req.body,
      { timeout: 8000 },
    );
    res.json(response.data);
  } catch (err) {
    console.log(
      `⚠️ GLK vitals relay failed (type=${data_type}):`,
      err.response?.status,
      err.message,
    );
    res.status(502).json({ error: "Failed to relay vitals to cloud backend" });
  }
});

/* =========================
   GLK STATUS READ ENDPOINTS
   Local-only reads — no cloud call. Lets the Pi dashboard show GLK device
   state without waiting for a round-trip to the remote backend.
========================= */

// GET /api/glk/status — full status of all GLK devices on this Pi
app.get("/api/glk/status", (req, res) => {
  const glk = readGlkStatus();
  res.json({ success: true, devices: glk });
});

// GET /api/glk/status/:serial — status of one GLK device
app.get("/api/glk/status/:serial", (req, res) => {
  const glk = readGlkStatus();
  const dev = glk[req.params.serial];
  if (!dev) {
    return res.status(404).json({ error: "GLK device not found" });
  }
  res.json({ success: true, serial_number: req.params.serial, ...dev });
});

/* =========================
   GO2RTC STREAM RE-REGISTRATION
   On Pi startup, re-register all mapped camera RTSP streams in go2rtc so they
   survive a go2rtc restart (go2rtc doesn't persist runtime-added streams, only
   those in its YAML config). Called once at server start.
========================= */

const reRegisterStreams = async () => {
  try {
    const devices = getDevices();
    const cameras = devices.filter(
      (d) => d.type === "camera" && d.status === "mapped" && d.stream_name,
    );
    if (!cameras.length) return;

    for (const cam of cameras) {
      // We need an RTSP URL to register. Check the device record first
      // (set during assign-camera), then try the go2rtc YAML as fallback.
      let rtspUrl = cam.rtsp_url;
      if (!rtspUrl) {
        // Try to read from go2rtc config YAML
        try {
          const go2rtcConfig = yaml.load(
            fs.readFileSync("/home/pi/go2rtc/go2rtc.yaml", "utf8"),
          );
          const streams = go2rtcConfig?.streams || {};
          const entry = streams[cam.stream_name];
          if (Array.isArray(entry)) rtspUrl = entry[0];
          else if (typeof entry === "string") rtspUrl = entry;
        } catch {
          /* YAML not readable — skip */
        }
      }

      if (!rtspUrl) {
        console.log(`⚠️ No RTSP URL for ${cam.stream_name} — skipping re-register`);
        continue;
      }

      try {
        // Delete stale then re-add (same pattern as assign-camera).
        await axios.delete(`${GO2RTC_URL}/api/streams`, {
          params: { src: cam.stream_name },
        });
      } catch {
        /* stream may not exist yet */
      }
      try {
        await axios.put(`${GO2RTC_URL}/api/streams`, null, {
          params: { name: cam.stream_name, src: rtspUrl },
        });
        console.log(`🎥 Re-registered stream: ${cam.stream_name}`);
      } catch (err) {
        console.log(
          `⚠️ Failed to re-register ${cam.stream_name}:`,
          err.message,
        );
      }
    }
  } catch (err) {
    console.log("⚠️ Stream re-registration error:", err.message);
  }
};

// Also persist the RTSP URL in devices.json when assigning a camera,
// and update go2rtc.yaml so streams survive even a go2rtc config reload.
const persistStreamConfig = (streamName, rtspUrl) => {
  if (!rtspUrl) return;
  try {
    const configPath = "/home/pi/go2rtc/go2rtc.yaml";
    let config = {};
    try {
      config = yaml.load(fs.readFileSync(configPath, "utf8")) || {};
    } catch {
      /* file may not exist yet */
    }
    if (!config.streams) config.streams = {};
    config.streams[streamName] = [rtspUrl];
    fs.writeFileSync(configPath, yaml.dump(config));
  } catch (err) {
    console.log("⚠️ Could not persist go2rtc config:", err.message);
  }
};

/* =========================
   CLOUD BACKEND PROXY  (curl-based)
   The React frontend calls cloud backend endpoints (auth, residents, etc.)
   but browsers block cross-origin requests (CORS). We proxy /api/user/*
   through this Express server so all frontend requests stay same-origin.

   Why curl instead of http-proxy-middleware?
   Cloudflare sits in front of awesomliving.com and blocks Node.js's TLS
   fingerprint (JA3) with ECONNRESET. curl uses a different TLS stack whose
   fingerprint Cloudflare accepts, so we shell out to curl via execFile
   (async, no shell injection risk) to forward requests.
========================= */

app.use("/api/user", (req, res) => {
  // app.use strips the mount prefix from req.url, so rebuild the full path
  // from req.originalUrl (which keeps /api/user/auth/sign-in intact).
  const target_url = `${REMOTE_BACKEND}${req.originalUrl}`;

  const curl_args = [
    "-s",                          // silent (no progress bar)
    "-X", req.method,              // HTTP method
    "-w", "\n__HTTP_STATUS__%{http_code}",  // append status code
    "--max-time", "25",            // timeout (seconds)
  ];

  // forward content-type
  const content_type = req.headers["content-type"] || "application/json";
  curl_args.push("-H", `Content-Type: ${content_type}`);

  // forward authorization header when present
  if (req.headers.authorization) {
    curl_args.push("-H", `Authorization: ${req.headers.authorization}`);
  }

  // forward request body for POST / PUT / PATCH
  if (req.body && ["POST", "PUT", "PATCH"].includes(req.method)) {
    curl_args.push("-d", JSON.stringify(req.body));
  }

  curl_args.push(target_url);

  execFile("curl", curl_args, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error("[curl proxy] error:", err.message);
      return res.status(502).json({
        error: "proxy_error",
        message: "cloud backend unreachable",
      });
    }

    // split body from status code marker
    const marker = "__HTTP_STATUS__";
    const marker_idx = stdout.lastIndexOf(marker);
    let status_code = 502;
    let body = stdout;

    if (marker_idx !== -1) {
      status_code = parseInt(stdout.slice(marker_idx + marker.length).trim(), 10) || 502;
      body = stdout.slice(0, marker_idx).trim();
    }

    // try to return JSON; fall back to plain text
    res.status(status_code);
    try {
      res.json(JSON.parse(body));
    } catch {
      res.send(body);
    }
  });
});

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

// Ping every 15s. The backend flags the hub offline after >30s of silence
// (2 missed pings), so a power-off shows offline within ~30s without flapping.
const HUB_HEARTBEAT_INTERVAL_MS = 15 * 1000;

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
    exec("ping -c 2 -w 3 8.8.8.8", (err, stdout = "") => {
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

// Read the Cloudflare tunnel URL from the hub config (set by the setup script
// or manually). The backend uses this to build per-camera stream URLs for the
// mobile app. Falls back to env for backward compatibility.
const getTunnelUrl = () => {
  try {
    const config = readHubConfig();
    if (config.tunnel_url) return config.tunnel_url;
  } catch {
    /* no config file yet */
  }
  return process.env.TUNNEL_URL || null;
};

// Count mapped cameras on this hub (for the backend's camera_count field).
const getMappedCameraCount = () => {
  try {
    return getDevices().filter(
      (d) => d.type === "camera" && d.status === "mapped",
    ).length;
  } catch {
    return 0;
  }
};

const sendHeartbeat = async () => {
  try {
    const { level, ms } = await measureInternet();
    const payload = {
      hub_id: getHubId(),
      // Send home directly from hub config so the backend can bind the hub even
      // when no device has a resident mapped yet (belt-and-suspenders alongside
      // the resident lookup the backend already does).
      home: readHubConfig().home_id || undefined,
      resident: getManagedResident(),
      // If ping couldn't grade it but the POST below succeeds, we're at least
      // online — report a safe middle tier rather than nothing.
      internet_level: level || "online-good",
      latency_ms: ms,
      // Multi-camera: tell the backend how to reach this Pi's go2rtc.
      tunnel_url: getTunnelUrl(),
      camera_count: getMappedCameraCount(),
    };
    const headers = {};
    if (process.env.HUB_SECRET_KEY) {
      headers["x-hub-secret"] = process.env.HUB_SECRET_KEY;
    }
    const res = await axios.post(
      `${REMOTE_BACKEND}/api/hub/heartbeat`,
      payload,
      { timeout: 8000, headers },
    );
    console.log(
      `✅ hub heartbeat OK (hub=${payload.hub_id}, level=${payload.internet_level})`,
    );

    // ── Remote command delivery ───────────────────────────────────────
    // The cloud backend piggybacks shutdown/reboot commands on the
    // heartbeat response so the user can safely power off the Pi from
    // the app before physically moving it.
    const pending_cmd = res.data?.data?.pending_command;
    if (pending_cmd === "shutdown") {
      console.log("🛑 SHUTDOWN command received from cloud — powering off in 5s…");
      setTimeout(() => {
        exec("sudo shutdown -h now", (err) => {
          if (err) console.error("shutdown exec error:", err.message);
        });
      }, 5000);
    } else if (pending_cmd === "reboot") {
      console.log("🔄 REBOOT command received from cloud — rebooting in 5s…");
      setTimeout(() => {
        exec("sudo reboot", (err) => {
          if (err) console.error("reboot exec error:", err.message);
        });
      }, 5000);
    }
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.log(
      `⚠️ hub heartbeat failed: ${err.message}`,
      status ? `[HTTP ${status}]` : "",
      body ? JSON.stringify(body) : "",
    );
  }
};

/* =========================
   PER-CAMERA HEARTBEAT (Pi -> backend, every 30s)
   Tells the backend each camera's go2rtc stream is alive. The backend's camera
   health checker fires CAMERA_OFFLINE notifications when camera_last_seen goes
   stale (>2 min). We use the bulk endpoint to avoid N individual POSTs.
========================= */

const CAMERA_HEARTBEAT_INTERVAL_MS = 30 * 1000;

const sendCameraHeartbeats = async () => {
  try {
    const devices = getDevices();
    const cameras = devices.filter(
      (d) => d.type === "camera" && d.status === "mapped" && d.stream_name,
    );
    if (!cameras.length) return;

    // Optionally verify each stream is actually alive in go2rtc before reporting.
    let liveStreams = null;
    try {
      const streamsRes = await axios.get(`${GO2RTC_URL}/api/streams`, {
        timeout: 3000,
      });
      if (streamsRes.data) {
        liveStreams = new Set(Object.keys(streamsRes.data));
      }
    } catch {
      // go2rtc may be briefly unreachable — report all mapped cameras anyway
      // so the backend doesn't immediately flag them offline.
    }

    const aliveCameras = cameras
      .filter((c) => !liveStreams || liveStreams.has(c.stream_name))
      .map((c) => ({ stream_name: c.stream_name }));

    if (!aliveCameras.length) return;

    const headers = {};
    if (process.env.HUB_SECRET_KEY) {
      headers["x-hub-secret"] = process.env.HUB_SECRET_KEY;
    }

    const streamNames = aliveCameras.map((c) => c.stream_name);
    const res = await axios.post(
      `${REMOTE_BACKEND}/api/camera/heartbeat/bulk`,
      { hub_id: getHubId(), cameras: aliveCameras },
      { timeout: 8000, headers },
    );
    const backendUpdated = res.data?.data?.updated ?? "?";
    console.log(
      `✅ camera heartbeat OK — sent ${aliveCameras.length} stream(s) [${streamNames.join(", ")}], backend updated: ${backendUpdated}`,
    );
    if (backendUpdated === 0) {
      console.log(
        `⚠️ backend matched 0 CpPlus devices! Possible stream_name mismatch — Pi sent: [${streamNames.join(", ")}]`,
      );
    }
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.log(
      `⚠️ camera heartbeat failed: ${err.message}`,
      status ? `[HTTP ${status}]` : "",
      body ? JSON.stringify(body) : "",
    );
  }
};

/* =========================
   START SERVER
========================= */

server.listen(4000, () => {
  console.log("Server running on port 4000");

  // Re-register all mapped camera streams in go2rtc (survives go2rtc restart).
  reRegisterStreams();

  // Kick off the hub heartbeat once the server is up, then every 15s.
  sendHeartbeat();
  setInterval(sendHeartbeat, HUB_HEARTBEAT_INTERVAL_MS);

  // Kick off per-camera heartbeat (bulk) every 30s so the backend's camera
  // health checker knows each stream is alive.
  setTimeout(() => {
    sendCameraHeartbeats();
    setInterval(sendCameraHeartbeats, CAMERA_HEARTBEAT_INTERVAL_MS);
  }, 5000); // small delay so streams have time to register first
});
