import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
  return devices;
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
