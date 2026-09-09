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

// Human-readable type labels for auto-naming.
const TYPE_LABELS = {
  motion: "Motion Sensor",
  contact: "Contact Sensor",
  presence: "Presence Sensor",
  switch: "Switch",
  unknown: "Zigbee Device",
};

/**
 * Build a human-readable default name for a newly detected device.
 *
 * Priority:
 *   1. Z2M friendly_name — if the user already renamed it in Z2M (i.e. it
 *      does NOT start with "0x"), use that as-is.
 *   2. "<Type Label> <N>" — e.g. "Motion Sensor 1", "Contact Sensor 2",
 *      where N is based on how many devices of the same type already exist
 *      in devices.json (both mapped and unmapped).
 */
const build_device_name = (friendly_name, type, current_devices) => {
  // If Z2M has a custom friendly name (user-set), use it.
  if (friendly_name && !friendly_name.startsWith("0x")) {
    return friendly_name;
  }

  const label = TYPE_LABELS[type] || TYPE_LABELS.unknown;

  // Count existing devices of the same type to get the next number.
  const same_type_count = current_devices.filter(
    (d) => d.type === type,
  ).length;

  return `${label} ${same_type_count + 1}`;
};

const handle_bridge_devices = (payload) => {
  let devices;
  try {
    devices = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return; // not valid JSON — ignore
  }
  if (!Array.isArray(devices)) return;

  const detected = detect_all_types(devices);
  // Re-read current devices before each batch so sequence numbers are correct.
  let current_devices = getDevices();

  let new_count = 0;
  let updated_count = 0;

  for (const d of detected) {
    const existing = current_devices.find(
      (e) => e.ieee_address === d.ieee_address,
    );

    if (!existing) {
      // Brand-new device — add as unmapped with detected type + readable name.
      const name = build_device_name(d.friendly_name, d.type, current_devices);
      upsertDevice({
        ieee_address: d.ieee_address,
        name,
        type: d.type,
        model: d.model,
        vendor: d.vendor,
        description: d.description,
      });
      // Refresh so the next device in this batch gets the right sequence number.
      current_devices = getDevices();
      new_count++;
    } else if (
      existing.is_unassigned !== false &&
      existing.status !== "mapped"
    ) {
      // Existing unmapped device — update type if it was unknown, and fix
      // the name if it's still a raw IEEE address.
      const needs_type = existing.type === "unknown" || !existing.type;
      const needs_name =
        !existing.name || existing.name.startsWith("0x");

      if (needs_type || needs_name) {
        const name = needs_name
          ? build_device_name(d.friendly_name, d.type, current_devices)
          : existing.name;
        upsertDevice({
          ieee_address: d.ieee_address,
          name,
          type: needs_type ? d.type : existing.type,
          model: d.model,
          vendor: d.vendor,
          description: d.description,
        });
        current_devices = getDevices();
        updated_count++;
      }
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

  const current_devices = getDevices();
  const existing = current_devices.find((e) => e.ieee_address === ieee);
  if (!existing) {
    const name = build_device_name(
      device_data.friendly_name,
      detected_type,
      current_devices,
    );
    upsertDevice({
      ieee_address: ieee,
      name,
      type: detected_type,
    });
    console.log(
      `📡 New Zigbee device joined: ${ieee} → ${detected_type} (${name})`,
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
