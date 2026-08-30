#!/usr/bin/env node
/**
 * diagnose_cameras.js — v3
 *
 * Queries two CP Plus (Dahua OEM) cameras side-by-side via the CGI config API.
 * Tries HTTP first (port 80), falls back to HTTPS (port 443).
 *
 * Usage:  node diagnose_cameras.js
 *   CAM_STABLE=192.168.50.102 CAM_UNSTABLE=192.168.50.101 CAM_PASS=Test@1234 node diagnose_cameras.js
 */

var http = require("http");
var https = require("https");
var crypto = require("crypto");

var CAM_STABLE = process.env.CAM_STABLE || "192.168.50.102";
var CAM_UNSTABLE = process.env.CAM_UNSTABLE || "192.168.50.101";
var CAM_USER = process.env.CAM_USER || "admin";
var CAM_PASS = process.env.CAM_PASS || "Test@1234";

var md5 = function (s) {
  return crypto.createHash("md5").update(s).digest("hex");
};

// Generic HTTP/HTTPS GET
var doGet = function (protocol, ip, port, pathWithQuery, headers) {
  return new Promise(function (resolve, reject) {
    var opts = {
      hostname: ip,
      port: port,
      path: pathWithQuery,
      method: "GET",
      headers: headers || {},
      timeout: 10000,
      rejectAuthorized: false,
    };
    if (protocol === "https") opts.rejectUnauthorized = false;

    var mod = protocol === "https" ? https : http;
    var req = mod.request(opts, function (res) {
      var body = "";
      res.on("data", function (chunk) { body += chunk; });
      res.on("end", function () {
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
    });
    req.on("error", reject);
    req.on("timeout", function () {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
};

// Try HTTP then HTTPS for a digest-auth GET
var digestGet = async function (ip, pathWithQuery) {
  var protocols = [
    { name: "http", port: 80 },
    { name: "https", port: 443 },
  ];

  for (var p of protocols) {
    try {
      // Step 1: unauthenticated
      var first = await doGet(p.name, ip, p.port, pathWithQuery, {});

      // If we get 404, this protocol doesn't have the CGI - try next
      if (first.status === 404) continue;

      // If not 401, unexpected
      if (first.status !== 401) {
        // Maybe it returned 200 without auth (some cameras)
        if (first.status === 200) return { protocol: p.name, body: first.body };
        continue;
      }

      var challenge = first.headers["www-authenticate"];
      if (!challenge) continue;

      // Step 2: compute digest
      var field = function (k) {
        var m = challenge.match(new RegExp(k + '="?([^",]+)"?'));
        return m ? m[1] : undefined;
      };
      var realm = field("realm");
      var nonce = field("nonce");
      var qop = field("qop");
      var opaque = field("opaque");
      var nc = "00000001";
      var cnonce = crypto.randomBytes(8).toString("hex");
      var ha1 = md5(CAM_USER + ":" + realm + ":" + CAM_PASS);
      var ha2 = md5("GET:" + pathWithQuery);
      var response = qop
        ? md5(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2)
        : md5(ha1 + ":" + nonce + ":" + ha2);

      var auth =
        'Digest username="' + CAM_USER + '", realm="' + realm + '", nonce="' + nonce +
        '", uri="' + pathWithQuery + '", response="' + response + '"';
      if (qop) auth += ", qop=" + qop + ", nc=" + nc + ', cnonce="' + cnonce + '"';
      if (opaque) auth += ', opaque="' + opaque + '"';

      // Step 3: authenticated
      var second = await doGet(p.name, ip, p.port, pathWithQuery, { Authorization: auth });
      if (second.status === 200) {
        return { protocol: p.name, body: second.body };
      }
    } catch (e) {
      // This protocol failed (connection refused, timeout) — try next
    }
  }

  throw new Error("Both HTTP and HTTPS failed (404 or unreachable)");
};

// Parse Dahua key=value response
var parseConfig = function (raw) {
  var config = {};
  var lines = raw.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (!trimmed || trimmed === "OK") continue;
    var eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    config[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return config;
};

// ---- Port probe ----
var probePort = function (ip, port) {
  return new Promise(function (resolve) {
    var net = require("net");
    var sock = net.createConnection({ host: ip, port: port, timeout: 3000 });
    sock.on("connect", function () { sock.destroy(); resolve(true); });
    sock.on("error", function () { resolve(false); });
    sock.on("timeout", function () { sock.destroy(); resolve(false); });
  });
};

// ---- Queries ----
var QUERIES = [
  { label: "Network Config", path: "/cgi-bin/configManager.cgi?action=getConfig&name=Network" },
  { label: "NTP Config", path: "/cgi-bin/configManager.cgi?action=getConfig&name=NTP" },
  { label: "General Config", path: "/cgi-bin/configManager.cgi?action=getConfig&name=General" },
  { label: "Device Type", path: "/cgi-bin/magicBox.cgi?action=getDeviceType" },
  { label: "Software Version", path: "/cgi-bin/magicBox.cgi?action=getSoftwareVersion" },
  { label: "Serial Number", path: "/cgi-bin/magicBox.cgi?action=getSerialNo" },
  { label: "Hardware Version", path: "/cgi-bin/magicBox.cgi?action=getHardwareVersion" },
  { label: "System Info", path: "/cgi-bin/magicBox.cgi?action=getSystemInfo" },
];

// ---- Main ----
var run = async function () {
  console.log("======================================================================");
  console.log("CP PLUS CAMERA NETWORK DIAGNOSTIC v3");
  console.log("======================================================================");
  console.log("Stable camera (keeps IP):   " + CAM_STABLE);
  console.log("Unstable camera (changes):  " + CAM_UNSTABLE);
  console.log("");

  // Step 0: Probe ports on both cameras
  console.log("----------------------------------------------------------------------");
  console.log("[Port Probe]");
  console.log("----------------------------------------------------------------------");
  var ports = [80, 443, 554, 37777];
  for (var cam of [CAM_STABLE, CAM_UNSTABLE]) {
    var results = [];
    for (var port of ports) {
      var open = await probePort(cam, port);
      results.push(port + ":" + (open ? "OPEN" : "closed"));
    }
    console.log("  " + cam + " -> " + results.join("  "));
  }
  console.log("");

  // Step 1: Try a raw HTTP GET to see what the web server returns (headers, server ID)
  console.log("----------------------------------------------------------------------");
  console.log("[Web Server Identity (HTTP GET /)]");
  console.log("----------------------------------------------------------------------");
  for (var cam of [CAM_STABLE, CAM_UNSTABLE]) {
    for (var proto of [{ name: "http", port: 80 }, { name: "https", port: 443 }]) {
      try {
        var resp = await doGet(proto.name, cam, proto.port, "/", {});
        var hdrs = [];
        if (resp.headers["server"]) hdrs.push("Server: " + resp.headers["server"]);
        if (resp.headers["www-authenticate"]) hdrs.push("Auth: " + resp.headers["www-authenticate"].substring(0, 80));
        if (resp.headers["content-type"]) hdrs.push("Type: " + resp.headers["content-type"]);
        console.log("  " + cam + " " + proto.name + ":" + proto.port + " -> HTTP " + resp.status + "  " + hdrs.join(" | "));
      } catch (e) {
        console.log("  " + cam + " " + proto.name + ":" + proto.port + " -> " + e.message);
      }
    }
  }
  console.log("");

  // Step 2: Run all config queries
  for (var q of QUERIES) {
    console.log("----------------------------------------------------------------------");
    console.log("[" + q.label + "]");
    console.log("----------------------------------------------------------------------");

    var stableResult = null;
    var unstableResult = null;

    try {
      stableResult = await digestGet(CAM_STABLE, q.path);
      console.log("  " + CAM_STABLE + " (" + stableResult.protocol + "): OK");
    } catch (err) {
      console.log("  " + CAM_STABLE + ": " + err.message);
    }

    try {
      unstableResult = await digestGet(CAM_UNSTABLE, q.path);
      console.log("  " + CAM_UNSTABLE + " (" + unstableResult.protocol + "): OK");
    } catch (err) {
      console.log("  " + CAM_UNSTABLE + ": " + err.message);
    }

    if (!stableResult && !unstableResult) {
      console.log("  Both cameras failed for this query.\n");
      continue;
    }

    var stableRaw = stableResult ? stableResult.body : null;
    var unstableRaw = unstableResult ? unstableResult.body : null;

    // For magicBox queries, just print raw
    if (q.path.indexOf("magicBox") !== -1) {
      console.log("  " + CAM_STABLE + ":  " + (stableRaw || "N/A").trim());
      console.log("  " + CAM_UNSTABLE + ": " + (unstableRaw || "N/A").trim());
      console.log("");
      continue;
    }

    // For configManager, parse and diff
    var stableConfig = stableRaw ? parseConfig(stableRaw) : {};
    var unstableConfig = unstableRaw ? parseConfig(unstableRaw) : {};

    var keySet = {};
    Object.keys(stableConfig).forEach(function (k) { keySet[k] = true; });
    Object.keys(unstableConfig).forEach(function (k) { keySet[k] = true; });
    var allKeys = Object.keys(keySet).sort();

    var diffs = [];
    var matches = [];

    for (var ki = 0; ki < allKeys.length; ki++) {
      var key = allKeys[ki];
      var sv = stableConfig[key] !== undefined ? stableConfig[key] : "(missing)";
      var uv = unstableConfig[key] !== undefined ? unstableConfig[key] : "(missing)";

      // For Network config, show only eth0 and relevant keys
      if (q.label === "Network Config") {
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
      for (var di = 0; di < diffs.length; di++) {
        var d = diffs[di];
        console.log("  " + d.key);
        console.log("    " + CAM_STABLE + ":  " + d.stable);
        console.log("    " + CAM_UNSTABLE + ": " + d.unstable);
      }
    } else {
      console.log("\n  No differences found for eth0 keys.");
    }

    if (matches.length > 0) {
      console.log("\n  Same on both:");
      for (var mi = 0; mi < matches.length; mi++) {
        console.log("    " + matches[mi].key + " = " + matches[mi].value);
      }
    }

    console.log("");
  }

  console.log("\n======================================================================");
  console.log("DONE");
  console.log("======================================================================");
};

run().catch(function (err) {
  console.error("Fatal error:", err);
  process.exit(1);
});
