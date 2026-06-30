import mqtt from "mqtt";
import { getIO } from "../socket/socket.js";
import fs from "fs";
import yaml from "js-yaml";

import { pendingDeletes } from "../utils/deleteState.js";
import { deleteDevice } from "../services/deviceStore.js";
const CONFIG_PATH = "/home/pi/zigbee2mqtt/data/configuration.yaml";
const client = mqtt.connect("mqtt://localhost");

client.on("connect", () => {
  console.log("MQTT Connected");

  client.subscribe("zigbee2mqtt/#");
});
client.on("message", (topic, message) => {
  const data = message.toString();
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
