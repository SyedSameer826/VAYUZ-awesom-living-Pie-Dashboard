import mqtt from "mqtt";
import { getIO } from "../socket/socket.js";
const client = mqtt.connect("mqtt://localhost");

client.on("connect", () => {
  console.log("MQTT Connected");

  client.subscribe("zigbee2mqtt/bridge/log");
  client.subscribe("zigbee2mqtt/bridge/event");
  client.subscribe("zigbee2mqtt/bridge/devices");
});
client.on("message", (topic, message) => {
  const data = message.toString();

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
