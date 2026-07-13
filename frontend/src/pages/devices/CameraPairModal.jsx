import { Button } from "../../components/buttons";

// Camera UIs are served over HTTPS and reject any Referer that isn't the camera
// itself ("invalid referer"). Opening with "noreferrer" sends no Referer at all
// — the same as typing the URL directly — so the page loads without a reload.
const openCameraPage = (ip) =>
  window.open(`https://${ip}`, "_blank", "noopener,noreferrer");

// We can't reliably tell from the network whether a camera has been configured:
// its RTSP port is open before AND after setup, and a fresh/reset camera can sit
// on a subnet the browser can't even reach. So we DON'T guess. Every not-yet-
// mapped camera simply offers BOTH actions — "Set Up" (open its page to
// configure) and "Map" (assign to a resident) — and the user runs them in order.
// (A previous version remembered "setup started" in localStorage the moment you
// clicked Set Up, which wrongly showed "Map" even when setup never happened.)
// A camera sitting on the camera-default subnet (192.168.1.x) with DHCP off is
// unreachable from the laptop. We offer an "Enable DHCP" action for those — the
// Pi flips DHCP on so the camera reboots onto the main network.
const isOnDefaultSubnet = (ip) => (ip || "").startsWith("192.168.1.");

const CameraPairModal = ({
  cameras,
  isScanning,
  onMap,
  onEnableDhcp,
  onRescan,
  onClose,
}) => {
  const hasUnmapped = cameras.some(
    (c) => !(c.already_known && c.status === "mapped"),
  );

  // Set Up: open the camera's own page (to configure it), then close this dialog.
  const handleSetUp = (ip) => {
    openCameraPage(ip);
    onClose();
  };

  // Map: hand off to the map form.
  const handleMap = (cam) => {
    onMap(cam);
  };

  return (
    <div className="device-form-modal">
      <div className="modal-backdrop" onClick={onClose}>
        {/* Force a single column so the instructions stack above the list. */}
        <div
          className="crud-form"
          style={{ display: "block" }}
          onClick={(e) => e.stopPropagation()}
        >
          <h2>Pair Camera</h2>

          {isScanning && (
            <p style={{ margin: "0 0 12px", color: "#555" }}>
              Scanning the network for cameras...
            </p>
          )}

          {/* 1) Instructions first */}
          {!isScanning && hasUnmapped && (
            <div
              style={{
                marginBottom: 14,
                padding: "10px 12px",
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 8,
                fontSize: 12.5,
                color: "#92400e",
                lineHeight: 1.5,
              }}
            >
              <b>New camera?</b> Click <b>Set Up</b> — the camera's page opens and
              this dialog closes. Configure it (steps below), then reopen Pair
              Camera and click <b>Map</b> to assign it to a resident.
              <div style={{ marginTop: 6 }}>
                <b>On the camera's page, do these:</b>
              </div>
              <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>
                  If the browser warns "not private," click{" "}
                  <b>Advanced → Proceed</b> (it's your own camera).
                </li>
                <li>
                  Choose <b>Region</b> and create the <b>admin password</b> (use
                  your standard camera password so every camera matches).
                </li>
                <li>
                  <b>Setting → System → Safety → System Service</b>: set{" "}
                  <b>Native Integration Authentication Mode</b> to{" "}
                  <b>Compatible Mode</b> → <b>uncheck "RTSP over TLS"</b> → Save.
                </li>
                <li>
                  <b>Setting → Camera → Video</b>: set both <b>Encode Mode</b>{" "}
                  dropdowns (Main + Sub) to <b>H.264</b> → Save.
                </li>
                <li>
                  Reopen Pair Camera here, then click <b>Map</b> to assign it to a
                  resident.
                </li>
              </ol>
            </div>
          )}

          {/* 2) Then the found-cameras list */}
          {!isScanning && cameras.length > 0 && (
            <>
              <p style={{ margin: "0 0 8px", color: "#555" }}>
                Cameras found on the network:
              </p>
              {cameras.some((c) => isOnDefaultSubnet(c.ip)) && (
                <p
                  style={{
                    margin: "0 0 8px",
                    fontSize: 12.5,
                    color: "#92400e",
                  }}
                >
                  A camera on <b>192.168.1.x</b> is on its default network and
                  can't be reached directly. Click <b>Enable DHCP</b> (you'll need
                  its admin password); it reboots onto the main network, then{" "}
                  <b>Rescan</b> and Set Up / Map it normally.
                </p>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {cameras.map((cam) => {
                  const isMapped =
                    cam.already_known && cam.status === "mapped";
                  return (
                    <div
                      key={cam.ip}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        border: "1px solid #eee",
                        borderRadius: 8,
                      }}
                    >
                      <div>
                        <strong>{cam.ip}</strong>
                        <span style={{ color: "#888" }}>
                          {" "}
                          · {cam.stream_name}
                        </span>
                      </div>
                      {isMapped ? (
                        <span style={{ color: "#2e7d32", fontSize: 13 }}>
                          Already mapped
                        </span>
                      ) : isOnDefaultSubnet(cam.ip) ? (
                        // Stuck on 192.168.1.x — can't reach it from the laptop.
                        // Flip DHCP on via the Pi so it hops onto the network.
                        <Button onClick={() => onEnableDhcp(cam)}>
                          Enable DHCP
                        </Button>
                      ) : (
                        <div style={{ display: "flex", gap: 8 }}>
                          <Button
                            variant="outline"
                            onClick={() => handleSetUp(cam.ip)}
                          >
                            Set Up
                          </Button>
                          <Button onClick={() => handleMap(cam)}>Map</Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {!isScanning && cameras.length === 0 && (
            <p style={{ margin: "0 0 12px", color: "#555" }}>
              No cameras found. Make sure the camera is powered and connected,
              then rescan.
            </p>
          )}

          <div className="form-actions" style={{ marginTop: 14 }}>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button onClick={onRescan} disabled={isScanning}>
              {isScanning ? "Scanning..." : "Rescan"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CameraPairModal;
