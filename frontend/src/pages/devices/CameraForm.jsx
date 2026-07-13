import { useState } from "react";
import { Button } from "../../components/buttons";

// Modal for mapping a CP Plus camera to a resident, with a guided password-setup
// step. The camera's own setup page is embedded here (inside the Pie platform)
// so the user can set the admin password without leaving to a browser.
const CameraForm = ({
  form,
  residents,
  isSaving,
  onChange,
  onClose,
  onSubmit,
}) => {
  const [showEmbed, setShowEmbed] = useState(false);
  // Direct URL for the "new tab" fallback. Camera UIs are served over HTTPS
  // (plain http returns "invalid referer"), so open https directly.
  const cameraUrl = form.local_ip ? `https://${form.local_ip}` : "";
  // Same-origin proxy URL for embedding inside the Pie platform.
  const embedUrl = form.local_ip ? `/camera-proxy/${form.local_ip}/` : "";

  return (
    <div className="device-form-modal">
      <div className="modal-backdrop" onClick={onClose}>
        <form
          className="crud-form"
          onClick={(e) => e.stopPropagation()}
          onSubmit={onSubmit}
          style={showEmbed ? { width: "90vw", maxWidth: 900 } : undefined}
        >
          <h2>Map Camera</h2>

          {/* Guided setup instructions */}
          <div
            style={{
              gridColumn: "1 / -1",
              background: "#fff7ed",
              border: "1px solid #fed7aa",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 14,
              fontSize: 13,
              color: "#7c2d12",
              lineHeight: 1.5,
            }}
          >
            <strong>New camera? Set its password first:</strong>
            <ol style={{ margin: "6px 0 8px", paddingLeft: 18 }}>
              <li>
                Click <b>Open Camera Page</b> below — the camera's own setup page
                opens right here. If it's a brand-new camera, it will ask you to
                create an admin password; use your standard camera password so
                it's the same on every camera.
              </li>
              <li>
                Enter that same password in the <b>Camera Password</b> field.
              </li>
              <li>
                Choose the resident, then click <b>Map Camera</b>.
              </li>
            </ol>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="outline-button"
                onClick={() => setShowEmbed((v) => !v)}
                disabled={!form.local_ip}
              >
                {showEmbed ? "Hide Camera Page" : "Open Camera Page"}
              </button>
              <button
                type="button"
                className="outline-button"
                onClick={() =>
                  window.open(cameraUrl, "_blank", "noopener,noreferrer")
                }
                disabled={!form.local_ip}
              >
                Open in new tab
              </button>
            </div>
          </div>

          {/* Embedded camera setup page (inside the Pie platform window) */}
          {showEmbed && form.local_ip && (
            <div style={{ marginBottom: 14, gridColumn: "1 / -1" }}>
              <iframe
                title="Camera setup"
                src={embedUrl}
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
                style={{
                  width: "100%",
                  height: 380,
                  border: "1px solid #ddd",
                  borderRadius: 8,
                }}
              />
              <p style={{ fontSize: 12, color: "#9a3412", margin: "6px 0 0" }}>
                Nothing showing above? Some cameras block being embedded — use{" "}
                <b>Open in new tab</b>. If the page never loads at all, this
                device may not be a camera, or your computer isn't on the same
                network as it.
              </p>
            </div>
          )}

          <label className="form-field">
            <span>Stream Name</span>
            <input
              name="stream_name"
              value={form.stream_name}
              onChange={onChange}
              placeholder="e.g. camera1"
            />
          </label>
          <label className="form-field">
            <span>Camera IP</span>
            <input
              name="local_ip"
              value={form.local_ip}
              onChange={onChange}
              placeholder="e.g. 192.168.1.38"
            />
          </label>
          <label className="form-field">
            <span>Camera Password</span>
            <input
              name="camera_password"
              type="password"
              value={form.camera_password}
              onChange={onChange}
              placeholder="admin password you set on the camera"
            />
          </label>
          <label className="form-field">
            <span>Room</span>
            <input
              name="room"
              value={form.room}
              onChange={onChange}
              placeholder="e.g. living_room"
            />
          </label>
          <label className="form-field">
            <span>Resident</span>
            <select name="resident" value={form.resident} onChange={onChange}>
              <option value="">Select Resident</option>
              {residents.map((resident) => (
                <option key={resident._id} value={resident._id}>
                  {resident.name || resident.full_name}
                </option>
              ))}
            </select>
          </label>

          <div className="form-actions">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Mapping..." : "Map Camera"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CameraForm;
