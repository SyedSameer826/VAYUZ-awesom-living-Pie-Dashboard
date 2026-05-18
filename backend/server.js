import express from "express";
import cors from "cors";

import { devices, samples, client } from "./mqtt.js";

const app = express();

app.use(cors());

app.use(express.json());

/* =========================
   GET ALL DEVICES
========================= */

app.get("/devices", (req, res) => {
  const result = Object.values(devices).map((device) => {
    return {
      friendly_name: device.friendly_name,

      ieee_address: device.ieee_address,

      model: device.definition?.model || null,

      vendor: device.definition?.vendor || null,

      description: device.definition?.description || null,

      sample: samples[device.friendly_name] || null,

      mapped: !device.friendly_name.startsWith("0x"),
    };
  });

  res.json(result);
});

/* =========================
   RENAME DEVICE
========================= */

app.post("/rename", (req, res) => {
  const { from, to } = req.body;

  if (!from || !to) {
    return res.status(400).json({
      success: false,
      message: "from and to required",
    });
  }

  client.publish(
    "zigbee2mqtt/bridge/request/device/rename",

    JSON.stringify({
      from,
      to,
    }),
  );

  res.json({
    success: true,
  });
});

/* =========================
   START SERVER
========================= */

app.listen(4000, () => {
  console.log("🚀 Backend running on port 4000");
});
