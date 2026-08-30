#!/usr/bin/env node
/**
 * diagnose_cameras_v5.js — ONVIF-based network config comparison
 *
 * Both CP Plus cameras expose ONVIF on port 80 (confirmed by v4 probe).
 * The standard Dahua CGI API does NOT exist on these cameras.
 * This script uses ONVIF SOAP to query network settings from both cameras
 * and highlights differences that could explain the IP instability.
 *
 * Usage:  node diagnose_cameras_v5.js
 */

var http = require("http");
var https = require("https");
var crypto = require("crypto");

var CAM_STABLE = process.env.CAM_STABLE || "192.168.50.102";
var CAM_UNSTABLE = process.env.CAM_UNSTABLE || "192.168.50.101";
var CAM_USER = process.env.CAM_USER || "admin";
var CAM_PASS = process.env.CAM_PASS || "Test@1234";

// ---- ONVIF WS-Security UsernameToken ----
var makeWsseHeader = function () {
  var nonce = crypto.randomBytes(16);
  var created = new Date().toISOString();
  // Password digest = Base64(SHA1(nonce + created + password))
  var sha1 = crypto.createHash("sha1");
  sha1.update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(CAM_PASS)]));
  var digest = sha1.digest("base64");
  var nonceB64 = nonce.toString("base64");

  return (
    '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
    "<UsernameToken>" +
    "<Username>" + CAM_USER + "</Username>" +
    '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' + digest + "</Password>" +
    '<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' + nonceB64 + "</Nonce>" +
    '<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' + created + "</Created>" +
    "</UsernameToken>" +
    "</Security>"
  );
};

// ---- SOAP envelope builder ----
var makeSoap = function (bodyXml) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl"' +
    ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
    "<s:Header>" + makeWsseHeader() + "</s:Header>" +
    "<s:Body>" + bodyXml + "</s:Body>" +
    "</s:Envelope>"
  );
};

// Same envelope without auth — some ONVIF methods are public
var makeSoapNoAuth = function (bodyXml) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"' +
    ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl"' +
    ' xmlns:tt="http://www.onvif.org/ver10/schema">' +
    "<s:Header/>" +
    "<s:Body>" + bodyXml + "</s:Body>" +
    "</s:Envelope>"
  );
};

// ---- HTTP POST for SOAP ----
var soapPost = function (ip, path, body) {
  return new Promise(function (resolve, reject) {
    var data = Buffer.from(body, "utf8");
    var opts = {
      hostname: ip,
      port: 80,
      path: path,
      method: "POST",
      headers: {
        "Content-Type": 'application/soap+xml; charset=utf-8',
        "Content-Length": data.length,
      },
      timeout: 10000,
    };

    var req = http.request(opts, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
};

// Also try HTTPS POST
var soapPostHttps = function (ip, path, body) {
  return new Promise(function (resolve, reject) {
    var data = Buffer.from(body, "utf8");
    var opts = {
      hostname: ip,
      port: 443,
      path: path,
      method: "POST",
      headers: {
        "Content-Type": 'application/soap+xml; charset=utf-8',
        "Content-Length": data.length,
      },
      timeout: 10000,
      rejectUnauthorized: false,
    };

    var req = https.request(opts, function (res) {
      var chunks = [];
      res.on("data", function (chunk) { chunks.push(chunk); });
      res.on("end", function () {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.on("timeout", function () { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
};

// ---- Try SOAP on HTTP then HTTPS ----
var trySoap = async function (ip, path, body) {
  // Try HTTP first
  try {
    var result = await soapPost(ip, path, body);
    if (result.status === 200) return { protocol: "http", body: result.body };
    // If we got a response but not 200, try with auth if it was no-auth
    if (result.status === 400 || result.status === 401 || result.status === 403) {
      // Save for fallback
    }
  } catch (e) { /* try next */ }

  // Try HTTPS
  try {
    var result2 = await soapPostHttps(ip, path, body);
    if (result2.status === 200) return { protocol: "https", body: result2.body };
  } catch (e) { /* fail */ }

  return null;
};

// ---- XML helpers (simple, no deps) ----
var extractTag = function (xml, tagName) {
  // Matches with or without namespace prefix
  var pattern = new RegExp("<(?:[^:]+:)?" + tagName + "[^>]*>([\\s\\S]*?)</(?:[^:]+:)?" + tagName + ">", "g");
  var matches = [];
  var m;
  while ((m = pattern.exec(xml)) !== null) {
    matches.push(m[1]);
  }
  return matches;
};

var extractTagFirst = function (xml, tagName) {
  var results = extractTag(xml, tagName);
  return results.length > 0 ? results[0].trim() : null;
};

// Extract simple leaf value
var extractLeaf = function (xml, tagName) {
  var pattern = new RegExp("<(?:[^:]+:)?" + tagName + "[^>]*>([^<]*)</(?:[^:]+:)?" + tagName + ">", "i");
  var m = xml.match(pattern);
  return m ? m[1].trim() : null;
};

// Extract attribute
var extractAttr = function (xml, tagName, attrName) {
  var pattern = new RegExp("<(?:[^:]+:)?" + tagName + "[^>]*?" + attrName + '="([^"]*)"', "i");
  var m = xml.match(pattern);
  return m ? m[1] : null;
};

// ---- ONVIF queries ----
var QUERIES = [
  {
    label: "GetDeviceInformation",
    path: "/onvif/device_service",
    body: "<tds:GetDeviceInformation/>",
  },
  {
    label: "GetNetworkInterfaces",
    path: "/onvif/device_service",
    body: "<tds:GetNetworkInterfaces/>",
  },
  {
    label: "GetNetworkProtocols",
    path: "/onvif/device_service",
    body: "<tds:GetNetworkProtocols/>",
  },
  {
    label: "GetNetworkDefaultGateway",
    path: "/onvif/device_service",
    body: "<tds:GetNetworkDefaultGateway/>",
  },
  {
    label: "GetDNS",
    path: "/onvif/device_service",
    body: "<tds:GetDNS/>",
  },
  {
    label: "GetNTP",
    path: "/onvif/device_service",
    body: "<tds:GetNTP/>",
  },
  {
    label: "GetHostname",
    path: "/onvif/device_service",
    body: "<tds:GetHostname/>",
  },
  {
    label: "GetDiscoveryMode",
    path: "/onvif/device_service",
    body: "<tds:GetDiscoveryMode/>",
  },
  {
    label: "GetScopes",
    path: "/onvif/device_service",
    body: "<tds:GetScopes/>",
  },
  {
    label: "GetSystemDateAndTime",
    path: "/onvif/device_service",
    body: "<tds:GetSystemDateAndTime/>",
  },
];

// ---- Extract structured data from ONVIF responses ----
var parseDeviceInfo = function (xml) {
  return {
    manufacturer: extractLeaf(xml, "Manufacturer"),
    model: extractLeaf(xml, "Model"),
    firmware: extractLeaf(xml, "FirmwareVersion"),
    serial: extractLeaf(xml, "SerialNumber"),
    hardware: extractLeaf(xml, "HardwareId"),
  };
};

var parseNetworkInterface = function (xml) {
  var info = {};
  info.name = extractAttr(xml, "NetworkInterfaces", "token");
  info.enabled = extractLeaf(xml, "Enabled");
  info.hwAddress = extractLeaf(xml, "HwAddress");
  info.mtu = extractLeaf(xml, "MTU");

  // IPv4 config
  var ipv4Block = extractTagFirst(xml, "IPv4");
  if (ipv4Block) {
    info.ipv4_enabled = extractLeaf(ipv4Block, "Enabled");
    info.dhcp = extractLeaf(ipv4Block, "DHCP");

    // Manual addresses
    var manualBlocks = extractTag(ipv4Block, "Manual");
    if (manualBlocks.length > 0) {
      info.manual_addresses = manualBlocks.map(function (b) {
        return {
          address: extractLeaf(b, "Address"),
          prefix: extractLeaf(b, "PrefixLength"),
        };
      });
    }

    // From DHCP
    var dhcpBlocks = extractTag(ipv4Block, "FromDHCP");
    if (dhcpBlocks.length > 0) {
      info.dhcp_addresses = dhcpBlocks.map(function (b) {
        return {
          address: extractLeaf(b, "Address"),
          prefix: extractLeaf(b, "PrefixLength"),
        };
      });
    }

    // Link addresses
    var linkBlocks = extractTag(ipv4Block, "LinkLocal");
    if (linkBlocks.length > 0) {
      info.link_local = linkBlocks.map(function (b) {
        return {
          address: extractLeaf(b, "Address"),
          prefix: extractLeaf(b, "PrefixLength"),
        };
      });
    }
  }

  // IPv6
  var ipv6Block = extractTagFirst(xml, "IPv6");
  if (ipv6Block) {
    info.ipv6_enabled = extractLeaf(ipv6Block, "Enabled");
  }

  return info;
};

var parseHostname = function (xml) {
  return {
    from_dhcp: extractLeaf(xml, "FromDHCP"),
    name: extractLeaf(xml, "Name"),
  };
};

var parseDNS = function (xml) {
  var info = {};
  info.from_dhcp = extractLeaf(xml, "FromDHCP");
  var searchDomain = extractTag(xml, "SearchDomain");
  if (searchDomain.length) info.search_domains = searchDomain;
  // DNS servers
  var servers = extractTag(xml, "DNSManual");
  if (servers.length) {
    info.manual_dns = servers.map(function (s) {
      return { type: extractLeaf(s, "Type"), address: extractLeaf(s, "IPv4Address") || extractLeaf(s, "IPv6Address") };
    });
  }
  var dhcpDns = extractTag(xml, "DNSFromDHCP");
  if (dhcpDns.length) {
    info.dhcp_dns = dhcpDns.map(function (s) {
      return { type: extractLeaf(s, "Type"), address: extractLeaf(s, "IPv4Address") || extractLeaf(s, "IPv6Address") };
    });
  }
  return info;
};

var parseGateway = function (xml) {
  var addrs = extractTag(xml, "IPv4Address");
  return { gateways: addrs.map(function (a) { return a.trim(); }) };
};

var parseNTP = function (xml) {
  var info = {};
  info.from_dhcp = extractLeaf(xml, "FromDHCP");
  var manual = extractTag(xml, "NTPManual");
  if (manual.length) {
    info.manual_servers = manual.map(function (s) {
      return { type: extractLeaf(s, "Type"), address: extractLeaf(s, "IPv4Address") || extractLeaf(s, "DNSname") };
    });
  }
  var fromDhcp = extractTag(xml, "NTPFromDHCP");
  if (fromDhcp.length) {
    info.dhcp_servers = fromDhcp.map(function (s) {
      return { type: extractLeaf(s, "Type"), address: extractLeaf(s, "IPv4Address") || extractLeaf(s, "DNSname") };
    });
  }
  return info;
};

// ============================================================================
// MAIN
// ============================================================================
var run = async function () {
  console.log("======================================================================");
  console.log("CP PLUS CAMERA DIAGNOSTIC v5 — ONVIF NETWORK COMPARISON");
  console.log("======================================================================");
  console.log("Stable camera (keeps IP):   " + CAM_STABLE);
  console.log("Unstable camera (changes):  " + CAM_UNSTABLE);
  console.log("Date:                       " + new Date().toISOString());
  console.log("");

  var results = {};

  for (var cam of [CAM_STABLE, CAM_UNSTABLE]) {
    var label = cam === CAM_STABLE ? "STABLE" : "UNSTABLE";
    results[cam] = {};
    console.log("======================================================================");
    console.log(label + " CAMERA (" + cam + ")");
    console.log("======================================================================");

    for (var q of QUERIES) {
      console.log("\n  --- " + q.label + " ---");

      // Try with auth first
      var soapBody = makeSoap(q.body);
      var resp = await trySoap(cam, q.path, soapBody);

      // If auth failed, try without auth (some ONVIF methods are public)
      if (!resp) {
        var soapBodyNoAuth = makeSoapNoAuth(q.body);
        resp = await trySoap(cam, q.path, soapBodyNoAuth);
      }

      if (!resp) {
        console.log("  FAILED — no response from either HTTP or HTTPS");
        results[cam][q.label] = null;
        continue;
      }

      console.log("  OK (" + resp.protocol + ")");
      results[cam][q.label] = resp.body;

      // Check for SOAP fault
      if (resp.body.indexOf("Fault") !== -1 && resp.body.indexOf("faultstring") !== -1) {
        var faultStr = extractLeaf(resp.body, "faultstring") || extractTagFirst(resp.body, "Text") || "unknown fault";
        console.log("  SOAP FAULT: " + faultStr);
        continue;
      }

      // Parse and display key info
      if (q.label === "GetDeviceInformation") {
        var devInfo = parseDeviceInfo(resp.body);
        console.log("  Manufacturer:     " + (devInfo.manufacturer || "?"));
        console.log("  Model:            " + (devInfo.model || "?"));
        console.log("  Firmware:         " + (devInfo.firmware || "?"));
        console.log("  Serial:           " + (devInfo.serial || "?"));
        console.log("  Hardware ID:      " + (devInfo.hardware || "?"));
      }

      if (q.label === "GetNetworkInterfaces") {
        var netInfo = parseNetworkInterface(resp.body);
        console.log("  Interface:        " + (netInfo.name || "?"));
        console.log("  Enabled:          " + (netInfo.enabled || "?"));
        console.log("  MAC:              " + (netInfo.hwAddress || "?"));
        console.log("  MTU:              " + (netInfo.mtu || "?"));
        console.log("  IPv4 Enabled:     " + (netInfo.ipv4_enabled || "?"));
        console.log("  DHCP:             " + (netInfo.dhcp || "?"));
        if (netInfo.manual_addresses && netInfo.manual_addresses.length) {
          console.log("  Manual IPs:       " + JSON.stringify(netInfo.manual_addresses));
        }
        if (netInfo.dhcp_addresses && netInfo.dhcp_addresses.length) {
          console.log("  DHCP IPs:         " + JSON.stringify(netInfo.dhcp_addresses));
        }
        if (netInfo.link_local && netInfo.link_local.length) {
          console.log("  Link-Local:       " + JSON.stringify(netInfo.link_local));
        }
      }

      if (q.label === "GetHostname") {
        var hostInfo = parseHostname(resp.body);
        console.log("  Hostname:         " + (hostInfo.name || "(empty)"));
        console.log("  From DHCP:        " + (hostInfo.from_dhcp || "?"));
      }

      if (q.label === "GetDNS") {
        var dnsInfo = parseDNS(resp.body);
        console.log("  DNS from DHCP:    " + (dnsInfo.from_dhcp || "?"));
        if (dnsInfo.manual_dns) console.log("  Manual DNS:       " + JSON.stringify(dnsInfo.manual_dns));
        if (dnsInfo.dhcp_dns) console.log("  DHCP DNS:         " + JSON.stringify(dnsInfo.dhcp_dns));
        if (dnsInfo.search_domains) console.log("  Search domains:   " + JSON.stringify(dnsInfo.search_domains));
      }

      if (q.label === "GetNetworkDefaultGateway") {
        var gwInfo = parseGateway(resp.body);
        console.log("  Gateways:         " + JSON.stringify(gwInfo.gateways));
      }

      if (q.label === "GetNTP") {
        var ntpInfo = parseNTP(resp.body);
        console.log("  NTP from DHCP:    " + (ntpInfo.from_dhcp || "?"));
        if (ntpInfo.manual_servers) console.log("  Manual NTP:       " + JSON.stringify(ntpInfo.manual_servers));
        if (ntpInfo.dhcp_servers) console.log("  DHCP NTP:         " + JSON.stringify(ntpInfo.dhcp_servers));
      }

      if (q.label === "GetDiscoveryMode") {
        console.log("  Discovery:        " + (extractLeaf(resp.body, "DiscoveryMode") || "?"));
      }

      if (q.label === "GetScopes") {
        var scopes = extractTag(resp.body, "ScopeItem");
        if (scopes.length === 0) scopes = extractTag(resp.body, "Scopes");
        for (var si = 0; si < scopes.length; si++) {
          var scopeDef = extractLeaf(scopes[si], "ScopeDef") || "";
          var scopeItem = extractLeaf(scopes[si], "ScopeItem") || scopes[si].trim();
          if (scopeItem) console.log("  Scope:            " + scopeDef + " " + scopeItem);
        }
      }

      if (q.label === "GetSystemDateAndTime") {
        var dstEnabled = extractLeaf(resp.body, "DaylightSavings");
        var dateTimeType = extractLeaf(resp.body, "DateTimeType");
        var tz = extractLeaf(resp.body, "TZ");
        console.log("  DateTime Type:    " + (dateTimeType || "?"));
        console.log("  Timezone:         " + (tz || "?"));
        console.log("  DST:              " + (dstEnabled || "?"));
      }
    }
    console.log("");
  }

  // ========== SIDE-BY-SIDE COMPARISON ==========
  console.log("\n======================================================================");
  console.log("SIDE-BY-SIDE COMPARISON — KEY NETWORK SETTINGS");
  console.log("======================================================================");

  // Compare network interfaces
  if (results[CAM_STABLE]["GetNetworkInterfaces"] && results[CAM_UNSTABLE]["GetNetworkInterfaces"]) {
    var netStable = parseNetworkInterface(results[CAM_STABLE]["GetNetworkInterfaces"]);
    var netUnstable = parseNetworkInterface(results[CAM_UNSTABLE]["GetNetworkInterfaces"]);

    var fields = ["name", "enabled", "hwAddress", "mtu", "ipv4_enabled", "dhcp", "ipv6_enabled"];
    console.log("\n  Network Interface:");
    for (var fi = 0; fi < fields.length; fi++) {
      var f = fields[fi];
      var sv = JSON.stringify(netStable[f]) || "(missing)";
      var uv = JSON.stringify(netUnstable[f]) || "(missing)";
      var marker = sv !== uv ? " *** DIFFERENT ***" : "";
      console.log("    " + f);
      console.log("      STABLE:   " + sv + marker);
      console.log("      UNSTABLE: " + uv + marker);
    }

    // Compare manual and DHCP addresses
    console.log("\n    Manual addresses:");
    console.log("      STABLE:   " + JSON.stringify(netStable.manual_addresses || []));
    console.log("      UNSTABLE: " + JSON.stringify(netUnstable.manual_addresses || []));
    if (JSON.stringify(netStable.manual_addresses) !== JSON.stringify(netUnstable.manual_addresses)) {
      console.log("      *** DIFFERENT ***");
    }

    console.log("\n    DHCP addresses:");
    console.log("      STABLE:   " + JSON.stringify(netStable.dhcp_addresses || []));
    console.log("      UNSTABLE: " + JSON.stringify(netUnstable.dhcp_addresses || []));
  }

  // Compare hostname
  if (results[CAM_STABLE]["GetHostname"] && results[CAM_UNSTABLE]["GetHostname"]) {
    var hostStable = parseHostname(results[CAM_STABLE]["GetHostname"]);
    var hostUnstable = parseHostname(results[CAM_UNSTABLE]["GetHostname"]);
    console.log("\n  Hostname:");
    console.log("    STABLE:   name=" + JSON.stringify(hostStable.name) + " fromDHCP=" + hostStable.from_dhcp);
    console.log("    UNSTABLE: name=" + JSON.stringify(hostUnstable.name) + " fromDHCP=" + hostUnstable.from_dhcp);
    if (hostStable.name !== hostUnstable.name || hostStable.from_dhcp !== hostUnstable.from_dhcp) {
      console.log("    *** DIFFERENT ***");
    }
  }

  // Compare device info
  if (results[CAM_STABLE]["GetDeviceInformation"] && results[CAM_UNSTABLE]["GetDeviceInformation"]) {
    var devStable = parseDeviceInfo(results[CAM_STABLE]["GetDeviceInformation"]);
    var devUnstable = parseDeviceInfo(results[CAM_UNSTABLE]["GetDeviceInformation"]);
    console.log("\n  Device Info:");
    var devFields = ["manufacturer", "model", "firmware", "serial", "hardware"];
    for (var dfi = 0; dfi < devFields.length; dfi++) {
      var df = devFields[dfi];
      var dsv = devStable[df] || "(missing)";
      var duv = devUnstable[df] || "(missing)";
      var dmarker = dsv !== duv ? " *** DIFFERENT ***" : "";
      console.log("    " + df + ":");
      console.log("      STABLE:   " + dsv + dmarker);
      console.log("      UNSTABLE: " + duv + dmarker);
    }
  }

  // Compare DNS
  if (results[CAM_STABLE]["GetDNS"] && results[CAM_UNSTABLE]["GetDNS"]) {
    var dnsStable = parseDNS(results[CAM_STABLE]["GetDNS"]);
    var dnsUnstable = parseDNS(results[CAM_UNSTABLE]["GetDNS"]);
    console.log("\n  DNS:");
    console.log("    STABLE:   fromDHCP=" + dnsStable.from_dhcp + " manual=" + JSON.stringify(dnsStable.manual_dns || []));
    console.log("    UNSTABLE: fromDHCP=" + dnsUnstable.from_dhcp + " manual=" + JSON.stringify(dnsUnstable.manual_dns || []));
  }

  // Compare NTP
  if (results[CAM_STABLE]["GetNTP"] && results[CAM_UNSTABLE]["GetNTP"]) {
    var ntpStable = parseNTP(results[CAM_STABLE]["GetNTP"]);
    var ntpUnstable = parseNTP(results[CAM_UNSTABLE]["GetNTP"]);
    console.log("\n  NTP:");
    console.log("    STABLE:   fromDHCP=" + ntpStable.from_dhcp + " manual=" + JSON.stringify(ntpStable.manual_servers || []));
    console.log("    UNSTABLE: fromDHCP=" + ntpUnstable.from_dhcp + " manual=" + JSON.stringify(ntpUnstable.manual_servers || []));
  }

  // Compare gateway
  if (results[CAM_STABLE]["GetNetworkDefaultGateway"] && results[CAM_UNSTABLE]["GetNetworkDefaultGateway"]) {
    var gwStable = parseGateway(results[CAM_STABLE]["GetNetworkDefaultGateway"]);
    var gwUnstable = parseGateway(results[CAM_UNSTABLE]["GetNetworkDefaultGateway"]);
    console.log("\n  Default Gateway:");
    console.log("    STABLE:   " + JSON.stringify(gwStable.gateways));
    console.log("    UNSTABLE: " + JSON.stringify(gwUnstable.gateways));
    if (JSON.stringify(gwStable.gateways) !== JSON.stringify(gwUnstable.gateways)) {
      console.log("    *** DIFFERENT ***");
    }
  }

  // Also dump the raw SOAP responses for GetNetworkInterfaces (most important)
  console.log("\n======================================================================");
  console.log("RAW RESPONSES — GetNetworkInterfaces");
  console.log("======================================================================");
  if (results[CAM_STABLE]["GetNetworkInterfaces"]) {
    console.log("\n  STABLE (" + CAM_STABLE + "):");
    console.log(results[CAM_STABLE]["GetNetworkInterfaces"]);
  }
  if (results[CAM_UNSTABLE]["GetNetworkInterfaces"]) {
    console.log("\n  UNSTABLE (" + CAM_UNSTABLE + "):");
    console.log(results[CAM_UNSTABLE]["GetNetworkInterfaces"]);
  }

  console.log("\n======================================================================");
  console.log("DONE");
  console.log("======================================================================");
};

run().catch(function (err) {
  console.error("Fatal error:", err);
  process.exit(1);
});
