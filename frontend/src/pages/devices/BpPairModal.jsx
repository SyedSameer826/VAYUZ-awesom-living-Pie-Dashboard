import { useState } from "react";
import { Button } from "../../components/buttons";

// Pairing flow for BLE Blood Pressure monitors. We scan for devices
// advertising the Blood Pressure Service (0x1810), then bond with the
// selected device and map it to a resident. After pairing, bp_bridge.py
// periodically connects to read stored measurements.
const BpPairModal = ({
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
    resident: "",
  });

  const change = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const canPair = selected && form.resident;

  const submit = (e) => {
    e.preventDefault();
    if (!canPair) return;
    onPair({
      address: selected.address,
      name: selected.name,
      resident: form.resident,
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
          <h2>Pair BP Monitor</h2>

          <div
            style={{
              marginBottom: 14,
              padding: "10px 12px",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 8,
              fontSize: 12.5,
              color: "#991b1b",
              lineHeight: 1.5,
            }}
          >
            <b>Before you start:</b> turn on the BP monitor and put it in{" "}
            <b>pairing mode</b> (usually by holding the Bluetooth button). Keep
            it close to the Pi during scanning.
          </div>

          {error && <p className="crud-alert">{error}</p>}

          {/* 1) Scan + device list */}
          {isScanning ? (
            <p style={{ margin: "0 0 12px", color: "#555" }}>
              Scanning over Bluetooth for BP monitors…
            </p>
          ) : devices.length > 0 ? (
            <>
              <p style={{ margin: "0 0 8px", color: "#555" }}>
                BP monitors found — pick one:
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
                          ? "2px solid #dc2626"
                          : "1px solid #eee",
                      borderRadius: 8,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="bp_device"
                      checked={selected?.address === d.address}
                      onChange={() => setSelected(d)}
                    />
                    <span>
                      <strong>{d.name || "BP Monitor"}</strong>
                      <span style={{ color: "#888" }}> · {d.address}</span>
                      {d.rssi != null && (
                        <span style={{ color: "#aaa", fontSize: 11 }}>
                          {" "}(RSSI {d.rssi})
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <p style={{ margin: "0 0 12px", color: "#555" }}>
              No BP monitors found. Make sure it's powered on and in pairing
              mode, then rescan.
            </p>
          )}

          {/* 2) Resident (enabled once a device is selected) */}
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

export default BpPairModal;
