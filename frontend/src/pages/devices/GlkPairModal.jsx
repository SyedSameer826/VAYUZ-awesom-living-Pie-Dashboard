import { useState } from "react";
import { Button } from "../../components/buttons";

// Pairing flow for the GLK sleep monitor. BLE is setup-only: we scan for devices
// advertising "LZ-OTA <serial>", then (per selected device) write the home 2.4GHz
// WiFi creds + this Pi's address over BLE. After that the device streams sleep
// data over TCP to the Pi's bridge and shows up under the chosen resident.
const GlkPairModal = ({
  devices,
  isScanning,
  isPairing,
  residents,
  onScan,
  onPair,
  onClose,
  error,
}) => {
  const [selected, setSelected] = useState(null); // the chosen device object
  const [form, setForm] = useState({
    ssid: "",
    password: "",
    resident: "",
    room: "bedroom",
  });

  const change = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const canPair =
    selected && form.ssid.trim() && form.password.trim() && form.resident;

  const submit = (e) => {
    e.preventDefault();
    if (!canPair) return;
    onPair({
      address: selected.address,
      serial: selected.serial,
      ssid: form.ssid.trim(),
      password: form.password.trim(),
      resident: form.resident,
      room: form.room.trim() || "bedroom",
    });
  };

  return (
    <div className="device-form-modal">
      <div className="modal-backdrop" onClick={onClose}>
        <form
          className="crud-form"
          style={{ display: "block" }}
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
        >
          <h2>Pair GLK Sleep Monitor</h2>

          <div
            style={{
              marginBottom: 14,
              padding: "10px 12px",
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: 8,
              fontSize: 12.5,
              color: "#1e3a8a",
              lineHeight: 1.5,
            }}
          >
            <b>Before you start:</b> power on the GLK device (it advertises as{" "}
            <b>LZ-OTA…</b>), keep it close to the Pi, and use your{" "}
            <b>2.4&nbsp;GHz</b> WiFi (the pad radio is 2.4&nbsp;GHz only).
          </div>

          {error && <p className="crud-alert">{error}</p>}

          {/* 1) Scan + device list */}
          {isScanning ? (
            <p style={{ margin: "0 0 12px", color: "#555" }}>
              Scanning over Bluetooth for GLK devices…
            </p>
          ) : devices.length > 0 ? (
            <>
              <p style={{ margin: "0 0 8px", color: "#555" }}>
                GLK devices found — pick one:
              </p>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}
              >
                {devices.map((d) => (
                  <label
                    key={d.address}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      border:
                        selected?.address === d.address
                          ? "2px solid #2563eb"
                          : "1px solid #eee",
                      borderRadius: 8,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="glk_device"
                      checked={selected?.address === d.address}
                      onChange={() => setSelected(d)}
                    />
                    <span>
                      <strong>{d.serial || d.name}</strong>
                      <span style={{ color: "#888" }}> · {d.address}</span>
                    </span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <p style={{ margin: "0 0 12px", color: "#555" }}>
              No GLK devices found. Make sure it's powered and in range, then
              rescan.
            </p>
          )}

          {/* 2) WiFi + resident form (enabled once a device is selected) */}
          <label className="form-field">
            <span>WiFi Name (2.4 GHz SSID)</span>
            <input
              name="ssid"
              value={form.ssid}
              onChange={change}
              placeholder="e.g. AwesoHome_24G"
              disabled={!selected}
            />
          </label>
          <label className="form-field">
            <span>WiFi Password</span>
            <input
              name="password"
              type="password"
              value={form.password}
              onChange={change}
              placeholder="WiFi password"
              disabled={!selected}
            />
          </label>
          <label className="form-field">
            <span>Room</span>
            <input
              name="room"
              value={form.room}
              onChange={change}
              placeholder="e.g. bedroom"
              disabled={!selected}
            />
          </label>
          <label className="form-field">
            <span>Resident</span>
            <select
              name="resident"
              value={form.resident}
              onChange={change}
              disabled={!selected}
            >
              <option value="">Select Resident</option>
              {residents.map((r) => (
                <option key={r._id} value={r._id}>
                  {r.name || r.full_name}
                </option>
              ))}
            </select>
          </label>

          <div className="form-actions" style={{ marginTop: 14 }}>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="outline"
              onClick={onScan}
              disabled={isScanning || isPairing}
            >
              {isScanning ? "Scanning…" : "Rescan"}
            </Button>
            <Button type="submit" disabled={!canPair || isPairing}>
              {isPairing ? "Pairing…" : "Pair & Map"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default GlkPairModal;
