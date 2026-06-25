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
      return res.status(401).json({
        error: "Authorization token missing",
      });
    }

    const token = authHeader.split(" ")[1];
    const file = fs.readFileSync(CONFIG_PATH, "utf8");
    const detectedType =
      zigbee_type === "door & window" ? "contact" : zigbee_type;

    upsertDevice({
      ieee_address: zigbee_ieee,
      name: zigbee_name,
      type: detectedType,
      resident,
      status: "mapped",
      is_unassigned: false,
    });
    const config = yaml.load(file);

    if (!config.devices[zigbee_ieee]) {
      return res.status(404).json({
        error: "Device not found",
      });
    }

    // Update friendly name locally
    config.devices[zigbee_ieee].friendly_name = zigbee_name;

    fs.writeFileSync(CONFIG_PATH, yaml.dump(config));

    // Send to main backend
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;

    const response = await axios.post(
      "https://backend-awesomliving.onrender.com/api/user/devices",
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

    res.json({
      success: true,
      backend_response: response.data,
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});
// In server.js DELETE route, after deleteDevice(ieee):

app.delete("/api/devices/:ieee", async (req, res) => {
  try {
    const { ieee } = req.params;

    // Step 1: Remove from devices.json (and remote backend if mapped)
    await deleteDevice(ieee);
    // Add to deleted devices blocklist on Pi
    try {
      const DELETED_PATH = "/home/pi/deleted_devices.json";
      const existing = JSON.parse(
        fs.readFileSync(DELETED_PATH, "utf8") || "[]",
      );
      if (!existing.includes(ieee)) {
        existing.push(ieee);
        fs.writeFileSync(DELETED_PATH, JSON.stringify(existing));
      }
    } catch (err) {
      console.log("⚠️ Could not update deleted_devices.json:", err.message);
    }
    // Step 2: Tell Z2M to remove from network
    mqttClient.publish(
      "zigbee2mqtt/bridge/request/device/remove",
      JSON.stringify({ id: ieee, force: true }),
    );

    // Step 3: Also clean yaml config as fallback
    // (mqttClient handles this too on Z2M response, but this covers
    //  cases where Z2M is down or device was already gone from network)
    try {
      const file = fs.readFileSync(CONFIG_PATH, "utf8");
      const config = yaml.load(file);
      if (config.devices?.[ieee]) {
        delete config.devices[ieee];
        fs.writeFileSync(CONFIG_PATH, yaml.dump(config));
      }
    } catch (yamlErr) {
      console.error("⚠️ yaml cleanup failed:", yamlErr.message);
    }

    console.log("✅ Delete complete for:", ieee);
    return res.json({ success: true, message: "Device deleted" });
  } catch (err) {
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
   SERVE REACT BUILD
========================= */

const frontendPath = path.join(__dirname, "../frontend/dist");

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
