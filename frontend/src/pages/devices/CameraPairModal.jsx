import { Button } from "../../components/buttons";

// Camera UIs are served over HTTPS (plain http returns "invalid referer"), so
// open the https page directly — the one-time "not private" cert prompt aside,
// the camera page loads without needing a manual reload.
const openCameraPage = (ip) =>
  window.open(`https://${ip}`, "_blank", "noopener");

// Shows the result of a network scan for cameras. Un-mapped cameras get both a
// "Set Up" (open the camera page) and a "Map" action; mapped ones are labelled.
const CameraPairModal = ({ cameras, isScanning, onMap, onRescan, onClose }) => {
  const hasUnmapped = cameras.some(
    (c) => !(c.already_known && c.status === "mapped"),
  );

  return (
    <div className="device-form-modal">
      <div className="modal-backdrop" onClick={onClose}>
        <div className="crud-form" onClick={(e) => e.stopPropagation()}>
          <h2>Pair Camera</h2>

          <p style={{ margin: "0 0 12px", color: "#555" }}>
            {isScanning
              ? "Scanning the network for cameras..."
              : cameras.length
                ? "Cameras found on the network:"
                : "No cameras found. Make sure the camera is powered and connected, then rescan."}
          </p>

          {/* Instructions ABOVE the list so the steps are seen first. */}
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
              <b>New camera?</b> Click <b>Set Up</b> and follow the steps below.
              If the camera is <b>already configured</b>, just click <b>Map</b>.
              <div style={{ marginTop: 6 }}>
                <b>Setting up a new camera:</b>
              </div>
              <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>
                  Click <b>Set Up</b> — the camera's page opens in a new tab. If
                  the browser warns "not private," click <b>Advanced → Proceed</b>{" "}
                  (it's your own camera).
                </li>
                <li>
                  Choose <b>Region</b> and create the <b>admin password</b> (use
                  your standard camera password so every camera matches).
                </li>
                <li>
                  In the camera go to <b>System → Safety → System Service</b> and
                  set <b>Native Integration Authentication Mode</b> to{" "}
                  <b>Compatible Mode</b> → Save.
                </li>
                <li>
                  Go to <b>Camera → Video</b> and set both <b>Encode Mode</b>{" "}
                  dropdowns (Main + Sub) to <b>H.264</b> → Save.
                </li>
                <li>
                  Come back here, click <b>Rescan</b>, then <b>Map</b> the camera
                  to a resident.
                </li>
              </ol>
            </div>
          )}

          {!isScanning && cameras.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {cameras.map((cam) => (
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
                    <span style={{ color: "#888" }}> · {cam.stream_name}</span>
                  </div>
                  {cam.already_known && cam.status === "mapped" ? (
                    <span style={{ color: "#2e7d32", fontSize: 13 }}>
                      Already mapped
                    </span>
                  ) : (
                    <div
                      style={{ display: "flex", gap: 8, alignItems: "center" }}
                    >
                      <Button
                        variant="outline"
                        onClick={() => openCameraPage(cam.ip)}
                      >
                        Set Up
                      </Button>
                      <Button onClick={() => onMap(cam)}>Map</Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="form-actions">
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
