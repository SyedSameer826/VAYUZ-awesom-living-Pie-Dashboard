import fs from "fs";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEVICES_PATH = path.join(__dirname, "../data/devices.json");

let devices = [];

try {
  if (!fs.existsSync(DEVICES_PATH)) {
    fs.writeFileSync(DEVICES_PATH, "[]");
  }
  devices = JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
} catch {
  devices = [];
}

export const getDevices = () => {
  try {
    return JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
  } catch {
    return [];
  }
};

export const saveDevices = () => {
  fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2));
};

export const upsertDevice = (device) => {
  const index = devices.findIndex(
    (d) => d.ieee_address === device.ieee_address,
  );

  if (index !== -1) {
    devices[index] = { ...devices[index], ...device };
  } else {
    devices.push({
      status: "unmapped",
      is_unassigned: true,
      ...device,
    });
  }

  saveDevices();
  return devices;
};

export const deleteDevice = async (ieee_address) => {
  try {
    devices = JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
  } catch {
    devices = [];
  }

  const device = devices.find((d) => d.ieee_address === ieee_address);

  if (!device) {
    throw new Error("Device not found in devices.json");
  }

  // Only call remote backend if device has a real friendly name (not IEEE address)
  if (
    device.status === "mapped" &&
    device.is_unassigned === false &&
    device.name &&
    !device.name.startsWith("0x")
  ) {
    try {
      await axios.delete(
        `https://backend-awesomliving.onrender.com/api/user/devices/${device.name}`,
      );
      console.log("✅ Deleted from remote backend:", device.name);
    } catch (err) {
      console.log(
        "⚠️ Remote backend delete failed (continuing locally):",
        err.response?.status,
        err.message,
      );
    }
  } else {
    console.log(
      "ℹ️ Skipping remote backend delete — device uses IEEE as name or is unmapped",
    );
  }

  devices = devices.filter((d) => d.ieee_address !== ieee_address);
  saveDevices();

  console.log("✅ Deleted from devices.json:", ieee_address);
  return devices;
};
