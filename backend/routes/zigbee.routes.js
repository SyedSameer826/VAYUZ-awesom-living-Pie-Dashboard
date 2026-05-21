import express from "express";
import { enablePairing } from "../services/zigbee.service.js";

const router = express.Router();

router.post("/pair/start", async (req, res) => {
  try {
    await enablePairing();

    res.json({
      success: true,
      message: "Pairing enabled",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;
