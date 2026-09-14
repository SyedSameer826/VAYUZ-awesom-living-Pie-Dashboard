/**
 * zigbeeTypeDetector.js
 *
 * Detects the logical device type (motion, contact, presence, switch, etc.)
 * from Zigbee2MQTT device data — specifically the cluster list, definition
 * fields, and model identifier that Z2M publishes on bridge/devices.
 *
 * Returns one of the types the Pie platform uses:
 *   "motion" | "contact" | "presence" | "switch" | "unknown"
 *
 * Detection priority:
 *   1. definition.description keyword match  (most reliable)
 *   2. definition.model match against known models
 *   3. Cluster-based heuristic (fallback)
 */

// ── 1. Description keywords ────────────────────────────────────────────
// Checked against definition.description (case-insensitive).
// Order matters — first match wins.
const DESCRIPTION_RULES = [
  { pattern: /\bpresence\b/i, type: "presence" },
  { pattern: /\boccupancy\b/i, type: "presence" },
  { pattern: /\bmotion\b/i, type: "motion" },
  { pattern: /\bpir\b/i, type: "motion" },
  { pattern: /\bdoor\b.*\bwindow\b/i, type: "contact" },
  { pattern: /\bcontact\b/i, type: "contact" },
  { pattern: /\bopen\b.*\bclose\b/i, type: "contact" },
  { pattern: /\bswitch\b/i, type: "switch" },
  { pattern: /\brelay\b/i, type: "switch" },
  { pattern: /\bplug\b/i, type: "switch" },
  { pattern: /\bbutton\b/i, type: "switch" },
];

// ── 2. Known model IDs ─────────────────────────────────────────────────
// Maps specific Z2M model strings to device types. These cover the sensors
// most commonly used in the Awesom Living kit (Aqara / SONOFF / Tuya).
const MODEL_MAP = {
  // Aqara motion sensors
  RTCGQ11LM: "motion",
  RTCGQ12LM: "motion",
  RTCGQ13LM: "motion",
  RTCGQ14LM: "motion",
  RTCGQ15LM: "motion",
  RTCGQ01LM: "motion",

  // Aqara door/window contact sensors
  MCCGQ11LM: "contact",
  MCCGQ12LM: "contact",
  MCCGQ14LM: "contact",
  MCCGQ01LM: "contact",

  // Aqara presence sensors (FP1, FP2)
  RTCZCGQ11LM: "presence",
  RTCZCGQ12LM: "presence",

  // SONOFF motion sensors
  SNZB_03: "motion",
  "SNZB-03": "motion",
  SNZB_03P: "motion",
  "SNZB-03P": "motion",
  "SNZB-06P": "presence",

  // SONOFF contact sensors
  SNZB_04: "contact",
  "SNZB-04": "contact",
  SNZB_04P: "contact",
  "SNZB-04P": "contact",

  // SONOFF switches / buttons
  SNZB_01: "switch",
  "SNZB-01": "switch",
  SNZB_01P: "switch",
  "SNZB-01P": "switch",

  // Tuya presence sensors
  ZY_M100: "presence",
  "ZY-M100": "presence",
  "ZY-M100-24G": "presence",

  // Tuya motion sensors
  IH012_RT01: "motion",
  "IH012-RT01": "motion",
  TS0202: "motion",
  "_TZ3000_msl6wxk9": "motion",

  // Tuya contact sensors
  TS0203: "contact",

  // Tuya smart plugs / switches
  TS0121: "switch",
  TS011F: "switch",
  TS0001: "switch",
  TS0002: "switch",
};

// ── 3. Cluster-based heuristic ─────────────────────────────────────────
// Uses the input cluster names from all endpoints. Presence sensors and
// motion sensors both report msOccupancySensing, so we separate them by
// checking for extra clusters that only presence sensors carry (e.g.
// aqaraOpple for FP1/FP2, or specific Tuya cluster patterns).
const PRESENCE_EXTRA_CLUSTERS = [
  "aqaraOpple",
  "manuSpecificTuya",
];

/**
 * Collect all input cluster names from every endpoint.
 */
const collect_input_clusters = (device) => {
  const clusters = new Set();
  const endpoints = device.endpoints || {};

  for (const ep of Object.values(endpoints)) {
    const input = ep.clusters?.input || ep.clusters?.in || [];
    for (const c of input) {
      clusters.add(typeof c === "string" ? c : c.name || c);
    }
  }
  return clusters;
};

/**
 * Check if any expose entry has a specific feature type/name.
 */
const has_expose = (device, feature_name) => {
  const exposes = device.definition?.exposes || [];
  for (const expose of exposes) {
    if (expose.name === feature_name || expose.property === feature_name) {
      return true;
    }
    // Check nested features (e.g. inside a "composite" or "specific" expose)
    const features = expose.features || [];
    for (const f of features) {
      if (f.name === feature_name || f.property === feature_name) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Detect the device type from a single Z2M device object.
 *
 * @param {object} device  — one entry from the zigbee2mqtt/bridge/devices array
 * @returns {string}       — "motion" | "contact" | "presence" | "switch" | "unknown"
 */
export const detect_zigbee_type = (device) => {
  // Skip the coordinator — it's the Z2M dongle itself.
  if (device.type === "Coordinator") return null;

  const definition = device.definition || {};
  const description = definition.description || "";
  const model = definition.model || "";

  // ── Pass 1: description keywords ──
  for (const rule of DESCRIPTION_RULES) {
    if (rule.pattern.test(description)) {
      return rule.type;
    }
  }

  // ── Pass 2: known model ID ──
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // ── Pass 3: exposes-based detection ──
  // Z2M's "exposes" array is the most structured way to identify capabilities.
  if (has_expose(device, "presence")) return "presence";
  if (has_expose(device, "occupancy")) {
    // occupancy can be motion OR presence — check for presence-specific signals
    const clusters = collect_input_clusters(device);
    const is_presence = PRESENCE_EXTRA_CLUSTERS.some((c) => clusters.has(c));
    return is_presence ? "presence" : "motion";
  }
  if (has_expose(device, "contact")) return "contact";
  if (has_expose(device, "state") || has_expose(device, "switch")) return "switch";

  // ── Pass 4: raw cluster fallback ──
  const clusters = collect_input_clusters(device);

  if (clusters.has("ssIasZone")) {
    // IAS Zone can be contact or motion — lean toward contact for door/window
    // sensors; motion sensors usually also have msOccupancySensing.
    if (clusters.has("msOccupancySensing")) return "motion";
    return "contact";
  }

  if (clusters.has("msOccupancySensing")) {
    const is_presence = PRESENCE_EXTRA_CLUSTERS.some((c) => clusters.has(c));
    return is_presence ? "presence" : "motion";
  }

  if (clusters.has("genOnOff")) return "switch";

  return "unknown";
};

/**
 * Process the full bridge/devices array and return a map of
 * ieee_address → detected type for all non-coordinator devices.
 *
 * @param {Array} devices — the payload from zigbee2mqtt/bridge/devices
 * @returns {Array<{ieee_address: string, friendly_name: string, type: string}>}
 */
export const detect_all_types = (devices) => {
  if (!Array.isArray(devices)) return [];

  const results = [];

  for (const device of devices) {
    const type = detect_zigbee_type(device);
    if (type === null) continue; // coordinator

    results.push({
      ieee_address: device.ieee_address,
      friendly_name: device.friendly_name || device.ieee_address,
      type,
      model: device.definition?.model || null,
      vendor: device.definition?.vendor || null,
      description: device.definition?.description || null,
    });
  }

  return results;
};
