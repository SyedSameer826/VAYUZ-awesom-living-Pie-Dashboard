import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Main backend this Pi maps devices to. Overridable via env; defaults to the EC2.
const REMOTE_BACKEND =
  process.env.REMOTE_BACKEND_URL || "http://51.20.102.125";
// Store device data OUTSIDE the code folder so code updates / git pulls can
// never overwrite it (a committed empty devices.json was wiping mapped devices
// on every deploy). Overridable via env; defaults to ~/awesomliving-data/.
const DATA_DIR =
  process.env.DEVICES_DIR || path.join(os.homedir(), "awesomliving-data");
const DEVICES_PATH = process.env.DEVICES_FILE || path.join(DATA_DIR, "devices.json");
// Per-process temp file so two processes never write the same temp at once.
const TMP_PATH = `${DEVICES_PATH}.tmp.${process.pid}`;
const LOCK_PATH = `${DEVICES_PATH}.lock`;

// Make sure the data directory + file exist on first run.
fs.mkdirSync(path.dirname(DEVICES_PATH), { recursive: true });
if (!fs.existsSync(DEVICES_PATH)) {
  fs.writeFileSync(DEVICES_PATH, "[]");
}

/**
 * Cross-process lock around a synchronous critical section.
 *
 * Two Node processes write devices.json — the standalone mqtt.js (on every
 * sensor message) and the platform backend (assign / delete). Without a lock,
 * both can read the list, then one overwrites the other's change — so a device
 * intermittently disappears (and Refresh, which only reads, shows the gap).
 *
 * fs.openSync(path, "wx") fails if the file already exists, giving us an atomic
 * "create-if-absent" flag that works across processes. We only ever hold the
 * lock across synchronous code (never across an await / network call), so it is
 * released in well under a millisecond. A lock older than 2s must belong to a
 * crashed process, so we treat it as stale and reclaim it.
 */
const withLock = (fn) => {
  const deadline = Date.now() + 4000;
  let acquired = false;

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(LOCK_PATH, "wx");
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Lock is held — if it's stale (holder crashed), reclaim it.
      try {
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 2000) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        // Lock vanished between stat and now — loop and retry to grab it.
      }
    }
  }

  if (!acquired) {
    throw new Error("devices.json busy — could not acquire lock");
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  }
};

/**
 * Read + parse devices.json. Returns an array, or `null` if it could not be
 * parsed. Callers MUST treat `null` as "unknown — do not overwrite the file".
 */
const readDevices = () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DEVICES_PATH, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Rare torn read — retry immediately.
    }
  }
  return null;
};

/**
 * Atomic write: serialize to a temp file, then rename it over the real file.
 * rename() is atomic, so readers always see a complete file.
 */
const writeDevices = (devices) => {
  const json = JSON.stringify(devices, null, 2);
  fs.writeFileSync(TMP_PATH, json);
  fs.renameSync(TMP_PATH, DEVICES_PATH);
};

export const getDevices = () => readDevices() ?? [];

export const upsertDevice = (device) => {
  try {
    return withLock(() => {
      const devices = readDevices();

      // Couldn't read cleanly — skip rather than clobber the list to one entry.
      if (devices === null) {
        console.log(
          "⚠️ Skipping upsert — devices.json unreadable this tick:",
          device.ieee_address,
        );
        return [];
      }

      const index = devices.findIndex(
        (d) => d.ieee_address === device.ieee_address,
      );

      if (index !== -1) {
        const existing = devices[index];
        // Preserve a mapped device's identity — only refresh its type.
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
    });
  } catch (err) {
    console.log("⚠️ upsert skipped:", err.message);
    return [];
  }
};

export const deleteDevice = async (ieee_address, token) => {
  // 1) Snapshot the device under the lock (fast, synchronous).
  let device = null;
  withLock(() => {
    const devices = readDevices();
    if (devices === null) {
      throw new Error(
        "devices.json unreadable — aborting delete to avoid data loss",
      );
    }
    device = devices.find((d) => d.ieee_address === ieee_address) || null;
  });

  if (!device) {
    throw new Error("Device not found in devices.json");
  }

  // 2) Delete from the remote backend WITHOUT holding the lock (network call).
  if (
    device.status === "mapped" &&
    device.is_unassigned === false &&
    device.name &&
    !device.name.startsWith("0x")
  ) {
    try {
      // The remote backend's delete endpoint is authenticated. Forward the
      // caller's Bearer token — without it the request returns 401 and the DB
      // record is left behind while devices.json is still cleared (which is
      // exactly the "deleted on Pie but not in DB" bug).
      await axios.delete(
        `${REMOTE_BACKEND}/api/user/devices/${ieee_address}`,
        token
          ? { headers: { Authorization: `Bearer ${token}` } }
          : undefined,
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

  // 3) Remove from devices.json under the lock, re-reading the latest list.
  let updated = [];
  withLock(() => {
    const devices = readDevices() ?? [];
    updated = devices.filter((d) => d.ieee_address !== ieee_address);
    writeDevices(updated);
  });

  console.log("✅ Deleted from devices.json:", ieee_address);
  return updated;
};
