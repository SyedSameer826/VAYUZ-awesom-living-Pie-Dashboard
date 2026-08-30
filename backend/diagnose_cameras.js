#!/usr/bin/env node
/**
 * diagnose_cameras.js
 *
 * Queries two CP Plus (Dahua OEM) cameras side-by-side via the CGI config API
 * and compares their full network configuration. Helps identify WHY one camera
 * keeps its DHCP-assigned IP across reboots while the other doesn't.
 *
 * Usage (run on the Pi, where both cameras are reachable):
 *   node diagnose_cameras.js
 *
 * Or with custom IPs / password:
 *   CAM_STABLE=192.168.50.102 CAM_UNSTABLE=192.168.50.101 CAM_PASS=Test@1234 node diagnose_cameras.js
 *
 * No external dependencies — uses only Node.js built-ins.
 */

const https = require("https");
const crypto = require("crypto");

// ---- Config ----
const CAM_STABLE = process.env.CAM_STABLE || "192.168.50.102";
const CAM_UNSTABLE = process.env.CAM_UNSTABLE || "192.168.50.101";
const CAM_USER = process.env.CAM_USER || "admin";
const CAM_PASS = process.env.CAM_PASS || "Test@1234";

// ---- HTTP Digest Auth ----
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

const httpsGet = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { rejectUnauthorized: false, headers, timeout: 10000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });

const digestGet = async (ip, pathWithQuery) => {
  const url = `https://${ip}${pathWithQuery}`;

  // Step 1: unauthenticated to get the challenge
  const first = await httpsGet(url);
  if (first.status !== 401) {
    throw new Error(`Expected 401, got ${first.status}`);
  }
  const challenge = first.headers["www-authenticate"];
  if (!challenge) throw new Error("No WWW-Authenticate header");

  // Step 2: parse challenge and compute digest
  const field = (k) =>
    (challenge.match(new RegExp(`${k}="?([^",]+)"?`)) || [])[1];
  const realm = field("realm");
  const nonce = field("nonce");
  const qop = field("qop");
  const opaque = field("opaque");
  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = md5(`${CAM_USER}:${realm}:${CAM_PASS}`);
  const ha2 = md5(`GET:${pathWithQuery}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  let auth =
    `Digest username="${CAM_USER}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${pathWithQuery}", response="${response}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;

  // Step 3: authenticated request
  const second = await httpsGet(url, { Authorization: auth });
  if (second.status !== 200) {
    throw new Error(`Auth failed: HTTP ${second.status}`);
  }
  return second.body;
};

// Parse Dahua's key=value response into an object
const parseConfig = (raw) => {
  const config = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "OK") continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    config[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return config;
};

// ---- Queries to run on each camera ----
const QUERIES = [
  {
    label: "Network (full)",
    path: "/cgi-bin/configManager.cgi?action=getConfig&name=Network",
  },
  {
    label: "NTP",
    path: "/cgi-bin/configManager.cgi?action=getConfig&name=NTP",
  },
  {
    label: "General (hostname/machine)",
    path: "/cgi-bin/configManager.cgi?action=getConfig&name=General",
  },
  {
    label: "Device Type",
    path: "/cgi-bin/magicBox.cgi?action=getDeviceType",
  },
  {
    label: "Software Version",
    path: "/cgi-bin/magicBox.cgi?action=getSoftwareVersion",
  },
  {
    label: "Serial Number",
    path: "/cgi-bin/magicBox.cgi?action=getSerialNo",
  },
  {
    label: "Hardware Version",
    path: "/cgi-bin/magicBox.cgi?action=getHardwareVersion",
  },
  {
    label: "System Info",
    path: "/cgi-bin/magicBox.cgi?action=getSystemInfo",
  },
];

// ---- Main ----
const run = async () => {
  console.log("=".repeat(70));
  console.log("CP PLUS CAMERA NETWORK DIAGNOSTIC");
  console.log("=".repeat(70));
  console.log("Stable camera (keeps IP):   " + CAM_STABLE);
  console.log("Unstable camera (changes):  " + CAM_UNSTABLE);
  console.log("");

  for (const q of QUERIES) {
    console.log("-".repeat(70));
    console.log("[" + q.label + "]");
    console.log("-".repeat(70));

    let stableRaw = null;
    let unstableRaw = null;

    try {
      stableRaw = await digestGet(CAM_STABLE, q.path);
    } catch (err) {
      console.log("  " + CAM_STABLE + ": ERROR - " + err.message);
    }

    try {
      unstableRaw = await digestGet(CAM_UNSTABLE, q.path);
    } catch (err) {
      console.log("  " + CAM_UNSTABLE + ": ERROR - " + err.message);
    }

    if (!stableRaw && !unstableRaw) {
      console.log("  Both cameras unreachable for this query.\n");
      continue;
    }

    // For magicBox queries (simple output), just print raw
    if (q.path.includes("magicBox")) {
      console.log("  " + CAM_STABLE + ":  " + (stableRaw || "N/A").trim());
      console.log("  " + CAM_UNSTABLE + ": " + (unstableRaw || "N/A").trim());
      console.log("");
      continue;
    }

    // For configManager queries, parse and diff
    const stableConfig = stableRaw ? parseConfig(stableRaw) : {};
    const unstableConfig = unstableRaw ? parseConfig(unstableRaw) : {};

    const allKeys = [
      ...new Set([
        ...Object.keys(stableConfig),
        ...Object.keys(unstableConfig),
      ]),
    ].sort();

    const diffs = [];
    const matches = [];

    for (const key of allKeys) {
      const sv = stableConfig[key] !== undefined ? stableConfig[key] : "(missing)";
      const uv = unstableConfig[key] !== undefined ? unstableConfig[key] : "(missing)";

      // Filter to eth0 keys for Network config (skip eth2/wlan etc.)
      if (q.label === "Network (full)") {
        if (
          key.indexOf("eth0") === -1 &&
          key.indexOf("Hostname") === -1 &&
          key.indexOf("Domain") === -1 &&
          key.indexOf("DhcpHostName") === -1 &&
          key.indexOf("MachineName") === -1
        ) {
          continue;
        }
      }

      if (sv !== uv) {
        diffs.push({ key: key, stable: sv, unstable: uv });
      } else {
        matches.push({ key: key, value: sv });
      }
    }

    if (diffs.length > 0) {
      console.log("\n  >>> DIFFERENCES <<<");
      for (const d of diffs) {
        console.log("  " + d.key);
        console.log("    " + CAM_STABLE + ":  " + d.stable);
        console.log("    " + CAM_UNSTABLE + ": " + d.unstable);
      }
    }

    if (matches.length > 0) {
      console.log("\n  Same on both:");
      for (const m of matches) {
        console.log("    " + m.key + " = " + m.value);
      }
    }

    console.log("");
  }

  // Bonus: query the DHCP client ID if the camera exposes it
  console.log("-".repeat(70));
  console.log("[DHCP Client Config (direct query)]");
  console.log("-".repeat(70));
  const cameras = [
    ["STABLE", CAM_STABLE],
    ["UNSTABLE", CAM_UNSTABLE],
  ];
  for (const pair of cameras) {
    const label = pair[0];
    const ip = pair[1];
    try {
      const raw = await digestGet(
        ip,
        "/cgi-bin/configManager.cgi?action=getConfig&name=Network.eth0",
      );
      const config = parseConfig(raw);
      const dhcpKeys = Object.entries(config).filter(function (entry) {
        const k = entry[0].toLowerCase();
        return (
          k.indexOf("dhcp") !== -1 ||
          k.indexOf("hostname") !== -1 ||
          k.indexOf("clientid") !== -1 ||
          k.indexOf("dns") !== -1 ||
          k.indexOf("ipaddress") !== -1 ||
          k.indexOf("subnetmask") !== -1 ||
          k.indexOf("gateway") !== -1 ||
          k.indexOf("mac") !== -1
        );
      });
      console.log("\n  " + label + " (" + ip + "):");
      if (dhcpKeys.length) {
        for (const entry of dhcpKeys) console.log("    " + entry[0] + " = " + entry[1]);
      } else {
        console.log("    (no DHCP-specific keys found, showing all):");
        for (const entry of Object.entries(config))
          console.log("    " + entry[0] + " = " + entry[1]);
      }
    } catch (err) {
      console.log("  " + label + " (" + ip + "): ERROR - " + err.message);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("DONE. Check DIFFERENCES above for the root cause.");
  console.log("=".repeat(70));
};

run().catch(function (err) {
  console.error("Fatal error:", err);
  process.exit(1);
});
