import mqtt from "mqtt";
import { getIO } from "../socket/socket.js";
import fs from "fs";
import yaml from "js-yaml";

import { pendingDeletes } from "../utils/deleteState.js";
import { deleteDevice, upsertDevice, getDevices } from "../services/deviceStore.js";
import { detect_all_types, detect_zigbee_type } from "../utils/zigbeeTypeDetector.js";

const CONFIG_PATH = "/home/pi/zigbee2mqtt/data/configuration.yaml";
const client = mqtt.connect("mqtt://localhost");

client.on("connect", () => {
  console.log("MQTT Connected");

  client.subscribe("zigbee2mqtt/#");
});

// ─── Zigbee device type auto-detection ─────────────────────────────────
// When Z2M publishes the full device list (bridge/devices), we detect each
// device's logical type (motion, contact, presence, switch) from its
// cluster data and definition, then upsert it into devices.json so the
// Devices page shows a meaningful type instead of "unknown".
//
// The handler only writes type + basic identity fields for UNMAPPED devices
// (or new devices not yet in devices.json). Mapped devices keep their
// existing data — upsertDevice's guard already ensures that.

const handle_bridge_devices = (payload) => {
  let devices;
  try {
    devices = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return; // not valid JSON — ignore
  }
  if (!Array.isArray(devices)) return;

  const detected = detect_all_types(devices);
  const current_devices = getDevices();

  let new_count = 0;
  let updated_count = 0;

  for (const d of detected) {
    const existing = current_devices.find(
      (e) => e.ieee_address === d.ieee_address,
    );

    if (!existing) {
      // Brand-new device — add as unmapped with detected type.
      upsertDevice({
        ieee_address: d.ieee_address,
        name: d.friendly_name,
        type: d.type,
        model: d.model,
        vendor: d.vendor,
        description: d.description,
      });
      new_count++;
    } else if (
      existing.is_unassigned !== false &&
      existing.status !== "mapped" &&
      (existing.type === "unknown" || !existing.type)
    ) {
      // Existing unmapped device whose type was unknown — update with
      // the detected type now that we have richer data from Z2M.
      upsertDevice({
        ieee_address: d.ieee_address,
        name: existing.name,
        type: d.type,
        model: d.model,
        vendor: d.vendor,
        description: d.description,
      });
      updated_count++;
    }
  }

  if (new_count || updated_count) {
    console.log(
      `📡 Zigbee type detection: ${new_count} new, ${updated_count} updated`,
    );
  }
};

// ─── Handle device_joined / device_announce events ─────────────────────
// When a device is freshly paired, Z2M fires a bridge/event with type
// "device_joined" or "device_announce". The device object in the event
// may have limited info, but we register it immediately so it appears in
// the device list. The next bridge/devices broadcast (which Z2M sends
// shortly after) will fill in the full type.

const handle_bridge_event = (payload) => {
  let event;
  try {
    event = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return;
  }

  if (
    event.type !== "device_joined" &&
    event.type !== "device_announce"
  ) {
    return;
  }

  const device_data = event.data || {};
  const ieee = device_data.ieee_address;
  if (!ieee) return;

  // Try to detect type from the event data (may be sparse).
  const detected_type = detect_zigbee_type(device_data) || "unknown";

  const existing = getDevices().find((e) => e.ieee_address === ieee);
  if (!existing) {
    upsertDevice({
      ieee_address: ieee,
      name: device_data.friendly_name || ieee,
      type: detected_type,
    });
    console.log(
      `📡 New Zigbee device joined: ${ieee} → ${detected_type}`,
    );
  }
};

client.on("message", (topic, message) => {
  const data = message.toString();

  // ── Full device list from Z2M (retained + on every change) ──
  if (topic === "zigbee2mqtt/bridge/devices") {
    handle_bridge_devices(data);
  }

  // ── Individual device events (join, announce, leave, etc.) ──
  if (topic === "zigbee2mqtt/bridge/event") {
    handle_bridge_event(data);
  }

  // ── Device removal confirmation ──
  if (topic === "zigbee2mqtt/bridge/response/device/remove") {
    const payload = JSON.parse(data);

    console.log("DEVICE REMOVE RESPONSE:", payload);

    if (payload.status === "ok") {
      const ieee = payload.data.id;

      // GUARD: Z2M RETAINS this remove confirmation and re-publishes it on
      // every broker reconnect / restart. Only act on removes THIS session
      // actually initiated (ieee present in pendingDeletes). Stale retained
      // confirmations — pendingDeletes is empty after a restart — are ignored,
      // so they can never churn the yaml or knock a mapped device offline.
      if (!pendingDeletes.has(ieee)) {
        console.log("ℹ️ Ignoring stale/retained device remove for:", ieee);
        return;
      }

      // devices.json already cleaned up in the DELETE route.
      // Clean up the zigbee2mqtt yaml config for this device.
      try {
        const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));
        if (config.devices?.[ieee]) {
          delete config.devices[ieee];
          fs.writeFileSync(CONFIG_PATH, yaml.dump(config));
          console.log("✅ Removed from Z2M yaml config:", ieee);
        }
      } catch (err) {
        console.error("⚠️ Failed to clean yaml config:", err.message);
      }

      pendingDeletes.delete(ieee);
      console.log("✅ Z2M removal confirmed for:", ieee);
    }
  }
  console.log(topic, data);

  const io = getIO();

  if (io) {
    io.emit("zigbee-log", {
      topic,
      message: data,
      timestamp: Date.now(),
    });
  }
});
export default client;
