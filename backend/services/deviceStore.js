import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEVICES_PATH = path.join(__dirname, "../data/devices.json");

// ========================================
// LOAD ONCE INTO MEMORY
// ========================================

let devices = [];

try {
  if (!fs.existsSync(DEVICES_PATH)) {
    fs.writeFileSync(DEVICES_PATH, "[]");
  }

  devices = JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
} catch {
  devices = [];
}

// ========================================
// GET DEVICES
// ========================================

export const getDevices = () => {
  try {
    return JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
  } catch {
    return [];
  }
};

// ========================================
// SAVE DEVICES
// ========================================

export const saveDevices = () => {
  fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2));
};

// ========================================
// UPSERT DEVICE
// ========================================

export const upsertDevice = (device) => {
  const index = devices.findIndex(
    (d) => d.ieee_address === device.ieee_address,
  );

  // ========================================
  // UPDATE EXISTING
  // ========================================

  if (index !== -1) {
    devices[index] = {
      ...devices[index],
      ...device,
    };
  }

  // ========================================
  // CREATE NEW
  // ========================================
  else {
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
    throw new Error("Device not found");
  }

  // Only delete from main backend if mapped
  if (device.status === "mapped" && device.is_unassigned === false) {
    await axios.delete(
      `https://backend-awesomliving.onrender.com/api/user/devices/${device.name}`,
    );
  }

  devices = devices.filter((d) => d.ieee_address !== ieee_address);

  saveDevices();

  return devices;
};
