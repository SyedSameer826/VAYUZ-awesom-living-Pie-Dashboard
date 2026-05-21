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

    const data = fs.readFileSync(DEVICES_PATH, "utf8");

    return JSON.parse(data);
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

  if (index !== -1) {
    devices[index] = {
      ...devices[index],
      ...device,
    };
  } else {
    devices.push(device);
  }

  saveDevices(devices);

  return devices;
};
