import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEVICES_PATH = path.join(__dirname, "../data/devices.json");

export const getDevices = () => {
  try {
    if (!fs.existsSync(DEVICES_PATH)) {
      fs.writeFileSync(DEVICES_PATH, "[]");
    }

    return JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
  } catch {
    return [];
  }
};

export const saveDevices = (devices) => {
  fs.writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2));
};

export const upsertDevice = (device) => {
  const devices = getDevices();

  const index = devices.findIndex(
    (d) => d.ieee_address === device.ieee_address,
  );

  // =========================================
  // DEVICE MAPPING LOGIC
  // =========================================

  const isMapped = device.name !== device.ieee_address;

  const deviceData = {
    ...device,

    status: isMapped ? "mapped" : "unmapped",

    is_unassigned: !isMapped,
  };

  // =========================================
  // UPDATE EXISTING
  // =========================================

  if (index !== -1) {
    devices[index] = {
      ...devices[index],
      ...deviceData,
    };
  }

  // =========================================
  // CREATE NEW
  // =========================================
  else {
    devices.push(deviceData);
  }

  saveDevices(devices);

  return devices;
};
