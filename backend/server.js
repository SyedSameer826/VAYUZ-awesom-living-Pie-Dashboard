import express from "express";
import cors from "cors";
import fs from "fs";
import yaml from "js-yaml";

const app = express();

app.use(cors());

const CONFIG_PATH = "/home/pi/zigbee2mqtt/data/configuration.yaml";

app.get("/devices", async (req, res) => {
  try {
    const file = fs.readFileSync(CONFIG_PATH, "utf8");

    const config = yaml.load(file);

    const devices = [];

    if (config.devices) {
      Object.entries(config.devices).forEach(([ieee, value]) => {
        devices.push({
          ieee_address: ieee,
          name: value?.friendly_name
            ? value.friendly_name
            : `New device: ${ieee}`,
        });
      });
    }

    res.json(devices);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

app.listen(4000, "0.0.0.0", () => {
  console.log("✅ Backend running on port 4000");
});
