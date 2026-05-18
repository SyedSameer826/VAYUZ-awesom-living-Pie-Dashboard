import mqtt from "mqtt";

const devices = {};
const samples = {};

const client = mqtt.connect("mqtt://localhost:1883");

client.on("connect", () => {
  console.log("✅ MQTT Connected");

  client.subscribe("zigbee2mqtt/bridge/devices");

  client.subscribe("zigbee2mqtt/+");
});

client.on("message", (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    // DEVICE LIST
    if (topic === "zigbee2mqtt/bridge/devices") {
      payload.forEach((device) => {
        devices[device.friendly_name] = device;
      });

      console.log("✅ Devices Updated");
    }

    // LIVE PAYLOADS
    if (!topic.includes("bridge")) {
      const deviceName = topic.replace("zigbee2mqtt/", "");

      samples[deviceName] = payload;
    }
  } catch (err) {
    console.log("MQTT Parse Error:", err.message);
  }
});

export { devices, samples, client };
