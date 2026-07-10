import express from "express";
import cors from "cors";
import fs from "fs";
import yaml from "js-yaml";
import axios from "axios";
import http from "http";
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

    // Step 1: Register the stream in go2rtc (only if an RTSP url is provided
    // and the stream isn't already configured). Safe to call repeatedly.
    if (rtsp_url) {
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

      // Suggest a unique, stable stream name derived from the IP.
      const parts = cam.ip.split(".");
      const suggested = `cam_${parts[2]}_${parts[3]}`;

      // Auto-add as unmapped so it appears in the device listing.
      upsertDevice({
        ieee_address: suggested,
        name: suggested,
        type: "camera",
        status: "unmapped",
        is_unassigned: true,
        local_ip: cam.ip,
        stream_name: suggested,
      });

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

app.delete("/api/devices/:ieee", async (req, res) => {
  try {
    const { ieee } = req.params;

    // Mark this as a current-session (intentional) delete BEFORE publishing
    // the Z2M remove. mqttClient.js only acts on remove confirmations whose
    // ieee is in pendingDeletes, so stale retained confirmations that re-fire
    // on restart are ignored and can never wipe a mapped device.
    pendingDeletes.add(ieee);

    // Remove from devices.json AND from the remote backend (incl. its logs).
    await deleteDevice(ieee);

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
   START SERVER
========================= */

server.listen(4000, () => {
  console.log("Server running on port 4000");
});
