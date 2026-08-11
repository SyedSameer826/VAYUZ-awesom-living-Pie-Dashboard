import mqtt from "mqtt";
import { getIO } from "../socket/socket.js";
import fs from "fs";
import yaml from "js-yaml";

import { pendingDeletes } from "../utils/deleteState.js";
import { deleteDevice, upsertDevice } from "../services/deviceStore.js";
const CONFIG_PATH = "/home/pi/zigbee2mqtt/data/configuration.yaml";
const client = mqtt.connect("mqtt://localhost");

client.on("connect", () => {
  console.log("MQTT Connected");

  client.subscribe("zigbee2mqtt/#");
});
client.on("message", (topic, message) => {
  const data = message.toString();

  // ── When Z2M publishes its device list (on startup, and every time a
  //    device joins or leaves), upsert each real device into devices.json
  //    so it appears in the Devices page as "unmapped" and ready to map.
  if (topic === "zigbee2mqtt/bridge/devices") {
    try {
      const deviceList = JSON.parse(data);
      for (const dev of deviceList) {
        // Skip the coordinator itself and any non-end/router devices.
        if (dev.type === "Coordinator") continue;

        // Determine a sensor type from the Z2M device definition.
        const defModel = dev.definition?.model || "";
        const defDesc = (dev.definition?.description || "").toLowerCase();
        let sensorType = "unknown";
        if (defDesc.includes("motion")) sensorType = "motion";
        else if (defDesc.includes("contact") || defDesc.includes("door") || defDesc.includes("window")) sensorType = "contact";
        else if (defDesc.includes("button") || defDesc.includes("switch") || defDesc.includes("remote")) sensorType = "switch";
        else if (defDesc.includes("presence") || defDesc.includes("occupancy")) sensorType = "presence";
        else if (defDesc.includes("temperature") || defDesc.includes("humidity")) sensorType = "temperature";
        else if (defDesc.includes("leak") || defDesc.includes("water")) sensorType = "leak";

        upsertDevice({
          ieee_address: dev.ieee_address,
          friendly_name: dev.friendly_name || dev.ieee_address,
          type: sensorType,
          model: defModel,
          description: dev.definition?.description || "",
          manufacturer: dev.definition?.vendor || "",
          power_source: dev.power_source || "",
        });
      }
      console.log(`✅ Devices synced from Z2M: ${deviceList.filter(d => d.type !== "Coordinator").length} device(s)`);
    } catch (err) {
      console.log("⚠️ Failed to sync Z2M device list:", err.message);
    }
  }

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
