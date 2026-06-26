import fs from "fs";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEVICES_PATH = path.join(__dirname, "../data/devices.json");

if (!fs.existsSync(DEVICES_PATH)) {
  fs.writeFileSync(DEVICES_PATH, "[]");
}

const readDevices = () => {
  try {
    return JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
  } catch {
    return [];
  }
};

const writeDevices = (devices) => {
  fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2));
};

export const getDevices = () => readDevices();

export const upsertDevice = (device) => {
  const devices = readDevices();
  const index = devices.findIndex(
    (d) => d.ieee_address === device.ieee_address,
  );

  if (index !== -1) {
    const existing = devices[index];
    if (existing.status === "mapped" && existing.is_unassigned === false) {
      devices[index] = { ...existing, type: device.type || existing.type };
    } else {
      devices[index] = { ...existing, ...device };
    }
  } else {
    devices.push({
      status: "unmapped",
      is_unassigned: true,
      ...device,
    });
  }

  writeDevices(devices);
  return devices;
};

export const deleteDevice = async (ieee_address) => {
  const devices = readDevices();

  const device = devices.find((d) => d.ieee_address === ieee_address);
  if (!device) {
    throw new Error("Device not found in devices.json");
  }

  if (
    device.status === "mapped" &&
    device.is_unassigned === false &&
    device.name &&
    !device.name.startsWith("0x")
  ) {
    try {
      await axios.delete(
        // `https://backend-awesomliving.onrender.com
        `https://localhost:3001/api/user/devices/${device.name}`,
      );
      console.log("✅ Deleted from remote backend:", device.name);
    } catch (err) {
      console.log(
        "⚠️ Remote backend delete failed:",
        err.response?.status,
        err.message,
      );
    }
  } else {
    console.log("ℹ️ Skipping remote backend delete — unmapped or IEEE name");
  }

  const updated = devices.filter((d) => d.ieee_address !== ieee_address);
  writeDevices(updated);
  console.log("✅ Deleted from devices.json:", ieee_address);
  return updated;
};
