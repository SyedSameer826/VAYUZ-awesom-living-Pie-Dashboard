import { Button } from "../../components/buttons";
const DeviceForm = ({
  editingId,
  form,
  devices,
  isSaving,
  onChange,
  onClose,
  onSubmit,
}) => {
  // Filter available sensors for pairing dropdowns (exclude the device being edited)
  const motion_sensors = (devices || []).filter(
    (d) => d.type === "motion" && d.ieee_address !== form.ieee_address,
  );

  // Collect window/door sensor IEEEs already paired to OTHER motion sensors
  const paired_window_iees = new Set(
    (devices || [])
      .filter(
        (d) =>
          d.type === "motion" &&
          d.paired_with?.window_ieee &&
          d.ieee_address !== form.ieee_address,
      )
      .map((d) => d.paired_with.window_ieee),
  );

  // Only show unpaired contact sensors (+ the one already paired to THIS device)
  const contact_sensors = (devices || []).filter(
    (d) =>
      (d.type === "contact" || d.type === "door & window") &&
      (!paired_window_iees.has(d.ieee_address) ||
        d.ieee_address === form.paired_window_ieee),
  );

  const is_motion = form.type === "motion";

  return (
    <div className="device-form-modal">
      <div className="modal-backdrop" onClick={onClose}>
        <form className="crud-form" onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
          <h2>Edit Device</h2>
          <label className="form-field">
            <span>Device</span>
            <input
              name="device"
              value={form.device}
              onChange={onChange}
              placeholder="Enter device name"
            />
          </label>
          <label className="form-field">
            <span>IEEE Address</span>
            <input
              name="ieee_address"
              value={form.ieee_address}
              onChange={onChange}
              disabled
              placeholder="Enter IEEE address"
            />
          </label>
          <label className="form-field">
            <span>Type</span>
            <select name="type" value={form.type} onChange={onChange}>
              <option value="">Select device type</option>
              <option value="contact">Contact</option>
              <option value="motion">Motion</option>
              <option value="switch">Switch</option>
              <option value="presence">Presence</option>
              <option value="temperature">Temperature</option>
              <option value="leak">Leak</option>
              <option value="zigbee">Zigbee</option>
            </select>
          </label>

          {is_motion && (
            <>
              <label className="form-field">
                <span>Paired Motion Sensor</span>
                <select
                  name="paired_motion_ieee"
                  value={form.paired_motion_ieee}
                  onChange={onChange}
                >
                  <option value="">Select paired motion sensor</option>
                  {motion_sensors.map((d) => (
                    <option key={d.ieee_address} value={d.ieee_address}>
                      {d.device || d.friendly_name || d.ieee_address}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>Paired Window / Door Sensor</span>
                <select
                  name="paired_window_ieee"
                  value={form.paired_window_ieee}
                  onChange={onChange}
                >
                  <option value="">Select paired window sensor</option>
                  {contact_sensors.map((d) => (
                    <option key={d.ieee_address} value={d.ieee_address}>
                      {d.device || d.friendly_name || d.ieee_address}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          <div className="form-actions">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving..." : "Submit"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default DeviceForm;
