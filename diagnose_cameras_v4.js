#!/usr/bin/env node
/**
 * diagnose_cameras_v4.js
 *
 * Comprehensive CP Plus camera probe — discovers what web endpoints
 * the cameras actually expose, then queries network config through
 * whatever API is available.
 *
 * Usage:  node diagnose_cameras_v4.js
 */

var http = require("http");
var https = require("https");
var crypto = require("crypto");
var net = require("net");

var CAM_STABLE = process.env.CAM_STABLE || "192.168.50.102";
var CAM_UNSTABLE = process.env.CAM_UNSTABLE || "192.168.50.101";
var CAM_USER = process.env.CAM_USER || "admin";
var CAM_PASS = process.env.CAM_PASS || "Test@1234";

var md5 = function (s) {
  return crypto.createHash("md5").update(s).digest("hex");
};

// ---- Generic HTTP/HTTPS GET (follows redirects) ----
var doGet = function (protocol, ip, port, pathWithQuery, headers, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 3;
  return new Promise(function (resolve, reject) {
    var opts = {
      hostname: ip,
      port: port,
      path: pathWithQuery,
      method: "GET",
      headers: headers || {},
      timeout: 8000,
    };
    if (protocol === "https") opts.rejectUnauthorized = false;

    var mod = protocol === "https" ? https : http;
    var req = mod.request(opts, function (res) {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && maxRedirects > 0) {
        var loc = res.headers.location;
        // Parse redirect location
        var newPath = loc;
        if (loc.indexOf("http") === 0) {
          try {
            var parsed = new URL(loc);
            newPath = parsed.pathname + parsed.search;
          } catch(e) { /* use as-is */ }
        }
        resolve(doGet(protocol, ip, port, newPath, headers, maxRedirects - 1));
        return;
      }
      var body = "";
      res.on("data", function (chunk) {
        if (body.length < 8000) body += chunk; // cap capture
      });
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

// ---- Digest auth GET (tries HTTP then HTTPS) ----
var digestGet = function (ip, pathWithQuery) {
  var protocols = [
    { name: "http", port: 80 },
    { name: "https", port: 443 },
  ];

  return new Promise(async function (resolve, reject) {
    for (var p of protocols) {
      try {
        var first = await doGet(p.name, ip, p.port, pathWithQuery, {});
        if (first.status === 200) {
          resolve({ protocol: p.name, port: p.port, body: first.body });
          return;
        }
        if (first.status !== 401) continue;

        var challenge = first.headers["www-authenticate"];
        if (!challenge) continue;

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

        var second = await doGet(p.name, ip, p.port, pathWithQuery, { Authorization: auth });
        if (second.status === 200) {
          resolve({ protocol: p.name, port: p.port, body: second.body });
          return;
        }
      } catch (e) {
        // connection refused / timeout — try next protocol
      }
    }
    reject(new Error("All protocols failed for " + pathWithQuery));
  });
};

// ---- Port probe ----
var probePort = function (ip, port) {
  return new Promise(function (resolve) {
    var sock = net.createConnection({ host: ip, port: port, timeout: 3000 });
    sock.on("connect", function () { sock.destroy(); resolve(true); });
    sock.on("error", function () { resolve(false); });
    sock.on("timeout", function () { sock.destroy(); resolve(false); });
  });
};

// ---- Raw GET (no auth, just see what comes back) ----
var rawGet = async function (ip, port, path) {
  var protocol = port === 443 ? "https" : "http";
  try {
    var resp = await doGet(protocol, ip, port, path, {});
    return resp;
  } catch (e) {
    return { status: -1, headers: {}, body: "ERROR: " + e.message };
  }
};

// ---- Parse Dahua key=value response ----
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

// ============================================================================
// MAIN
// ============================================================================
var run = async function () {
  console.log("======================================================================");
  console.log("CP PLUS CAMERA DIAGNOSTIC v4 — FULL DISCOVERY");
  console.log("======================================================================");
  console.log("Stable camera (keeps IP):   " + CAM_STABLE);
  console.log("Unstable camera (changes):  " + CAM_UNSTABLE);
  console.log("Credentials:                " + CAM_USER + " / " + CAM_PASS);
  console.log("Date:                       " + new Date().toISOString());
  console.log("");

  // ========== STEP 1: PORT SCAN ==========
  console.log("----------------------------------------------------------------------");
  console.log("STEP 1: PORT SCAN");
  console.log("----------------------------------------------------------------------");
  var ports = [80, 443, 554, 8080, 8443, 37777, 37778, 34567, 5000, 8000, 9000, 81];
  var openPorts = {};

  for (var cam of [CAM_STABLE, CAM_UNSTABLE]) {
    openPorts[cam] = [];
    var results = [];
    for (var port of ports) {
      var open = await probePort(cam, port);
      if (open) openPorts[cam].push(port);
      results.push(port + ":" + (open ? "OPEN" : "closed"));
    }
    console.log("  " + cam + " -> " + results.join("  "));
  }
  console.log("");

  // ========== STEP 2: WEB SERVER IDENTITY ==========
  console.log("----------------------------------------------------------------------");
  console.log("STEP 2: WEB SERVER IDENTITY (GET / on each open port)");
  console.log("----------------------------------------------------------------------");
  for (var cam of [CAM_STABLE, CAM_UNSTABLE]) {
    for (var port of openPorts[cam]) {
      var resp = await rawGet(cam, port, "/");
      var info = [];
      info.push("HTTP " + resp.status);
      if (resp.headers["server"]) info.push("Server: " + resp.headers["server"]);
      if (resp.headers["www-authenticate"]) info.push("WWW-Auth: " + resp.headers["www-authenticate"].substring(0, 100));
      if (resp.headers["content-type"]) info.push("Content-Type: " + resp.headers["content-type"]);
      if (resp.headers["location"]) info.push("Location: " + resp.headers["location"]);

      console.log("  " + cam + ":" + port + " -> " + info.join(" | "));

      // Show first 500 chars of body for identification
      if (resp.body && resp.status >= 200 && resp.status < 400) {
        var preview = resp.body.substring(0, 500).replace(/\s+/g, " ").trim();
        console.log("    Body preview: " + preview);
      }
    }
    console.log("");
  }

  // ========== STEP 3: ENDPOINT DISCOVERY ==========
  console.log("----------------------------------------------------------------------");
  console.log("STEP 3: ENDPOINT DISCOVERY (probing known camera API paths)");
  console.log("----------------------------------------------------------------------");
  var probePaths = [
    // Dahua / CP Plus standard
    "/cgi-bin/configManager.cgi?action=getConfig&name=Network",
    "/cgi-bin/magicBox.cgi?action=getDeviceType",
    // Dahua alternate
    "/RPC2",
    "/RPC2_Login",
    // ISAPI (Hikvision-style, some CP Plus use this)
    "/ISAPI/System/deviceInfo",
    "/ISAPI/System/Network/interfaces",
    "/ISAPI/Security/userCheck",
    // ONVIF
    "/onvif/device_service",
    // Common web UI paths
    "/doc/page/login.asp",
    "/doc/page/config.asp",
    "/login.htm",
    "/login.html",
    "/index.html",
    "/index.htm",
    "/web/index.html",
    "/doc/page/main.asp",
    // CP Plus specific
    "/CPPLUS/login.html",
    "/login.asp",
    "/Pages/login.htm",
    // Generic API discovery
    "/api/v1/device/info",
    "/api/system/info",
    "/device.rsp?opt=user&cmd=list",
    "/videoInput/channels",
  ];

  for (var cam of [CAM_STABLE, CAM_UNSTABLE]) {
    console.log("\n  " + cam + ":");
    for (var port of openPorts[cam]) {
      if (port === 554 || port === 37777 || port === 37778) continue; // Skip RTSP/proprietary binary
      for (var path of probePaths) {
        var resp = await rawGet(cam, port, path);
        if (resp.status !== 404 && resp.status !== -1) {
          var line = "    :" + port + path + " -> HTTP " + resp.status;
          if (resp.headers["www-authenticate"]) line += " [AUTH: " + resp.headers["www-authenticate"].substring(0, 60) + "]";
          if (resp.headers["content-type"]) line += " [" + resp.headers["content-type"].substring(0, 40) + "]";
          if (resp.status === 200 && resp.body) {
            line += " body=" + resp.body.length + "B";
          }
          console.log(line);
        }
      }
    }
  }
  console.log("");

  // ========== STEP 4: TRY DIGEST AUTH ON EVERY WORKING PATH ==========
  console.log("----------------------------------------------------------------------");
  console.log("STEP 4: DIGEST AUTH ATTEMPTS (trying auth on endpoints that returned 401)");
  console.log("----------------------------------------------------------------------");

  // Collect 401 endpoints from step 3 for each camera
  var authEndpoints = [
    "/cgi-bin/configManager.cgi?action=getConfig&name=Network",
    "/cgi-bin/magicBox.cgi?action=getDeviceType",
    "/ISAPI/System/deviceInfo",
    "/ISAPI/System/Network/interfaces",
    "/onvif/device_service",
  ];

  for (var cam of [CAM_STABLE, CAM_UNSTABLE]) {
    console.log("\n  " + cam + ":");
    for (var port of openPorts[cam]) {
      if (port === 554 || port === 37777 || port === 37778) continue;
      var protocol = port === 443 || port === 8443 ? "https" : "http";
      for (var path of authEndpoints) {
        try {
          var first = await doGet(protocol, cam, port, path, {});
          if (first.status !== 401 || !first.headers["www-authenticate"]) continue;

          // Try digest auth
          var challenge = first.headers["www-authenticate"];
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
          var ha2 = md5("GET:" + path);
          var dresp = qop
            ? md5(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2)
            : md5(ha1 + ":" + nonce + ":" + ha2);

          var auth =
            'Digest username="' + CAM_USER + '", realm="' + realm + '", nonce="' + nonce +
            '", uri="' + path + '", response="' + dresp + '"';
          if (qop) auth += ", qop=" + qop + ", nc=" + nc + ', cnonce="' + cnonce + '"';
          if (opaque) auth += ', opaque="' + opaque + '"';

          var second = await doGet(protocol, cam, port, path, { Authorization: auth });
          console.log("    :" + port + path + " -> AUTH " + second.status +
            (second.status === 200 ? " [SUCCESS] body=" + second.body.length + "B" : ""));
          if (second.status === 200 && second.body) {
            console.log("      " + second.body.substring(0, 600).replace(/\s+/g, " ").trim());
          }
        } catch (e) {
          // skip
        }
      }
    }
  }
  console.log("");

  // ========== STEP 5: NETWORK CONFIG (try Dahua CGI on both ports) ==========
  console.log("----------------------------------------------------------------------");
  console.log("STEP 5: NETWORK CONFIG QUERY (Dahua CGI on all open web ports)");
  console.log("----------------------------------------------------------------------");
  var configPaths = [
    { label: "Network Config", path: "/cgi-bin/configManager.cgi?action=getConfig&name=Network" },
    { label: "DHCP Config", path: "/cgi-bin/configManager.cgi?action=getConfig&name=Network.eth0.DhcpEnable" },
    { label: "Device Type", path: "/cgi-bin/magicBox.cgi?action=getDeviceType" },
    { label: "Software Version", path: "/cgi-bin/magicBox.cgi?action=getSoftwareVersion" },
    { label: "Serial Number", path: "/cgi-bin/magicBox.cgi?action=getSerialNo" },
    { label: "NTP Config", path: "/cgi-bin/configManager.cgi?action=getConfig&name=NTP" },
  ];

  for (var cam of [CAM_STABLE, CAM_UNSTABLE]) {
    console.log("\n  " + cam + ":");
    for (var q of configPaths) {
      try {
        var result = await digestGet(cam, q.path);
        console.log("    " + q.label + " (" + result.protocol + ":" + result.port + "): OK");
        console.log("      " + result.body.substring(0, 500).trim());
      } catch (e) {
        console.log("    " + q.label + ": FAILED (" + e.message + ")");
      }
    }
  }
  console.log("");

  // ========== STEP 6: ARP TABLE ON THE PI ==========
  console.log("----------------------------------------------------------------------");
  console.log("STEP 6: PI ARP TABLE (MAC addresses for both cameras)");
  console.log("----------------------------------------------------------------------");
  try {
    var exec = require("child_process").execSync;
    var arp = exec("arp -a 2>/dev/null || cat /proc/net/arp 2>/dev/null || echo 'no arp available'", { encoding: "utf8" });
    var lines = arp.split("\n");
    for (var line of lines) {
      if (line.indexOf(CAM_STABLE) !== -1 || line.indexOf(CAM_UNSTABLE) !== -1 ||
          line.toLowerCase().indexOf("f8:20:97") !== -1 || line.indexOf("Address") !== -1 ||
          line.indexOf("HWaddress") !== -1) {
        console.log("  " + line.trim());
      }
    }
  } catch (e) {
    console.log("  ARP lookup failed: " + e.message);
  }
  console.log("");

  // ========== STEP 7: DHCP LEASE FILE ON THE PI ==========
  console.log("----------------------------------------------------------------------");
  console.log("STEP 7: PI DHCP LEASE INFO");
  console.log("----------------------------------------------------------------------");
  try {
    var exec = require("child_process").execSync;
    // Check if Pi is running a DHCP server
    var leaseFiles = [
      "/var/lib/dhcp/dhclient.leases",
      "/var/lib/dhcpcd5/dhcpcd-eth0.lease",
      "/var/lib/dhcpcd/dhcpcd-eth0.lease",
      "/var/lib/NetworkManager/internal-*",
    ];
    for (var lf of leaseFiles) {
      try {
        var content = exec("cat " + lf + " 2>/dev/null || true", { encoding: "utf8" });
        if (content.trim()) {
          console.log("  " + lf + ":");
          console.log("  " + content.substring(0, 500));
        }
      } catch (e) { /* skip */ }
    }
    // Also check Pi's own network config
    var piNet = exec("ip addr show eth0 2>/dev/null || ifconfig eth0 2>/dev/null || echo 'no eth0'", { encoding: "utf8" });
    console.log("  Pi eth0 config:");
    console.log("  " + piNet.trim());
  } catch (e) {
    console.log("  " + e.message);
  }
  console.log("");

  // ========== STEP 8: ROUTER DHCP LEASES (via web scrape if possible) ==========
  console.log("----------------------------------------------------------------------");
  console.log("STEP 8: ROUTER INFO (TP-Link at 192.168.50.1)");
  console.log("----------------------------------------------------------------------");
  try {
    var routerResp = await rawGet("192.168.50.1", 80, "/");
    console.log("  Router HTTP " + routerResp.status);
    if (routerResp.headers["server"]) console.log("  Server: " + routerResp.headers["server"]);
    if (routerResp.headers["www-authenticate"]) console.log("  Auth: " + routerResp.headers["www-authenticate"]);
    // Try DHCP lease page
    var dhcpResp = await rawGet("192.168.50.1", 80, "/userRpm/AssignedIpAddrListRpm.htm");
    console.log("  DHCP lease page: HTTP " + dhcpResp.status);
    if (dhcpResp.status === 200 && dhcpResp.body) {
      console.log("  " + dhcpResp.body.substring(0, 1000).replace(/\s+/g, " ").trim());
    }
  } catch (e) {
    console.log("  Router unreachable: " + e.message);
  }

  console.log("\n======================================================================");
  console.log("DONE");
  console.log("======================================================================");
};

run().catch(function (err) {
  console.error("Fatal error:", err);
  process.exit(1);
});
