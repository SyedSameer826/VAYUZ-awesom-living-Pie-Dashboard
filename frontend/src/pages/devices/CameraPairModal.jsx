import { Button } from "../../components/buttons";

// Camera UIs are served over HTTPS and reject any Referer that isn't the camera
// itself ("invalid referer"). Opening with "noreferrer" sends no Referer at all
// — the same as typing the URL directly — so the page loads without a reload.
const openCameraPage = (ip) =>
  window.open(`https://${ip}`, "_blank", "noopener,noreferrer");

// We can't reliably tell from the network whether a camera has been configured,
// so we remember (in the browser) which cameras the user has clicked "Set Up"
// on. Those then show "Map" instead. Mapping clears the flag, so a later
// factory-reset of the same camera correctly shows "Set Up" again.
const SETUP_KEY = "camera_setup_started";

const getSetupStarted = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(SETUP_KEY) || "[]"));
  } catch {
    return new Set();
  }
};

const saveSetupStarted = (set) =>
  localStorage.setItem(SETUP_KEY, JSON.stringify([...set]));

const markSetupStarted = (ip) => {
  const set = getSetupStarted();
  set.add(ip);
  saveSetupStarted(set);
};

const clearSetupStarted = (ip) => {
  const set = getSetupStarted();
  set.delete(ip);
  saveSetupStarted(set);
};

const CameraPairModal = ({ cameras, isScanning, onMap, onRescan, onClose }) => {
  const setupStarted = getSetupStarted();
  const hasUnmapped = cameras.some(
    (c) => !(c.already_known && c.status === "mapped"),
  );

  // Set Up: remember it, open the camera page, and close this dialog.
  const handleSetUp = (ip) => {
    markSetupStarted(ip);
    openCameraPage(ip);
    onClose();
  };

  // Map: clear the "setup started" flag, then hand off to the map form.
  const handleMap = (cam) => {
    clearSetupStarted(cam.ip);
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
              this dialog closes. After configuring it, reopen Pair Camera and the
              camera will show a <b>Map</b> button.
              <div style={{ marginTop: 6 }}>
                <b>On the camera's page, do these:</b>
              </div>
              <ol style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                <li>
                  If the browser warns "not private," click{" "}
                  <b>Advanced → Proceed</b> (it's your own camera).
                </li>
                <li>
                  <b>Country/Region</b> screen: choose <b>Region</b> (India),
                  Language English → <b>Next</b>.
                </li>
                <li>
                  <b>Time Zone</b> screen: pick your zone (e.g. UTC+05:30
                  Chennai/Kolkata/Mumbai/New Delhi), click <b>Sync PC</b> for the
                  current time → <b>Next</b>.
                </li>
                <li>
                  <b>Device Initialization</b> screen: set the <b>admin password</b>{" "}
                  (use your standard camera password) and confirm it, add the
                  recovery email + security questions → <b>Next</b>.
                </li>
                <li>
                  <b>InstaOn</b> and <b>Online Upgrade</b> screens: leave as-is →{" "}
                  <b>Next / Save</b>. The camera then shows its login page.
                </li>
                <li>
                  <b>Log in</b> with <b>admin</b> and the password you just set.
                </li>
                <li>
                  <b>System → Safety → System Service</b>: set{" "}
                  <b>Native Integration Authentication Mode</b> to{" "}
                  <b>Compatible Mode</b>, and <b>uncheck "RTSP over TLS"</b> →
                  Save.
                </li>
                <li>
                  <b>Camera → Video</b>: set both <b>Encode Mode</b> dropdowns
                  (Main + Sub) to <b>H.264</b> → Save.
                </li>
                <li>
                  <b>Camera → Conditions</b>: if the image is upside-down, set{" "}
                  <b>Flip</b> to <b>180°</b> → Save.
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
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {cameras.map((cam) => {
                  const isMapped =
                    cam.already_known && cam.status === "mapped";
                  const readyToMap = setupStarted.has(cam.ip);
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
                      ) : readyToMap ? (
                        <Button onClick={() => handleMap(cam)}>Map</Button>
                      ) : (
                        <Button
                          variant="outline"
                          onClick={() => handleSetUp(cam.ip)}
                        >
                          Set Up
                        </Button>
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
