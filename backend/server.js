import express from "express";
import cors from "cors";
import fs from "fs";
import yaml from "js-yaml";
import axios from "axios";

const app = express();

app.use(cors());
app.use(express.json());

const CONFIG_PATH = "/home/pi/zigbee2mqtt/data/configuration.yaml";

app.get("/devices", (req, res) => {
  try {
    const file = fs.readFileSync(CONFIG_PATH, "utf8");

    const config = yaml.load(file);

    const devices = [];

    if (config.devices) {
      Object.entries(config.devices).forEach(([ieee, value]) => {
        const friendlyName = value?.friendly_name || ieee;

        devices.push({
          ieee_address: ieee,
          name: friendlyName,
          is_unassigned: friendlyName === ieee,
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

app.post("/assign-name", async (req, res) => {
  try {
    const { zigbee_ieee, zigbee_name, resident, zigbee_type, room, token } =
      req.body;

    const file = fs.readFileSync(CONFIG_PATH, "utf8");

    const config = yaml.load(file);

    if (!config.devices[zigbee_ieee]) {
      return res.status(404).json({
        error: "Device not found",
      });
    }

    // update friendly name locally
    config.devices[zigbee_ieee].friendly_name = zigbee_name;

    fs.writeFileSync(CONFIG_PATH, yaml.dump(config));

    // SEND TO YOUR MAIN BACKEND
    axios.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    const response = await axios.post(
      "https://backend-awesomliving.onrender.com/api/user/devices",
      {
        type: "Zigbee",
        resident,
        name: zigbee_name,
        zigbee_id: zigbee_name,
        zigbee_ieee,
        zigbee_type,
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

app.listen(4000, "0.0.0.0", () => {
  console.log("✅ Backend running");
});
