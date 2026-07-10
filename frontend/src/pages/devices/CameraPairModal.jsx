import { Button } from "../../components/buttons";

// Shows the result of a network scan for cameras. New cameras get a "Map" action
// (which pre-fills the Map Camera form); already-mapped ones are just labelled.
const CameraPairModal = ({ cameras, isScanning, onMap, onRescan, onClose }) => {
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
                    <Button onClick={() => onMap(cam)}>Map</Button>
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
