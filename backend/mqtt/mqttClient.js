import mqtt from "mqtt";
import { getIO } from "../socket/socket.js";
import fs from "fs";
import yaml from "js-yaml";

import { pendingDeletes } from "../utils/deleteState.js";
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

      // Guard: only act if WE triggered this delete in the current session.
      // Z2M retains bridge/response/device/remove, so without this check
      // every pm2 restart re-fires old confirmations and wipes devices from
      // devices.json, causing them to reappear as unmapped.
      if (!pendingDeletes.has(ieee)) {
        console.log("⚠️ Ignoring stale remove confirmation for:", ieee);
      } else {
        // devices.json already cleaned in the DELETE route.
        // Just clean up the Z2M yaml config here.
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
