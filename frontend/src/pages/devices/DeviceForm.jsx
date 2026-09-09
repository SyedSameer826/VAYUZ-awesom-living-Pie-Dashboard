import { Button } from "../../components/buttons";
const DeviceForm = ({
  editingId,
  form,
  residents,
  isSaving,
  onChange,
  onClose,
  onSubmit,
  unmapped_motion_devices,
  unmapped_contact_devices,
}) => {
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
            </select>
          </label>

          {is_motion && (
            <>
              <label className="form-field">
                <span>Pair with 2nd Motion Sensor</span>
                <select
                  name="paired_motion_ieee"
                  value={form.paired_motion_ieee || ""}
                  onChange={onChange}
                >
                  <option value="">Select unmapped motion sensor</option>
                  {(unmapped_motion_devices || [])
                    .filter((d) => d.ieee_address !== form.ieee_address)
                    .map((d) => (
                      <option key={d.ieee_address} value={d.ieee_address}>
                        {d.device || d.name || "Unnamed"} ({d.ieee_address})
                      </option>
                    ))}
                </select>
              </label>
              <label className="form-field">
                <span>Pair with Window Sensor</span>
                <select
                  name="paired_window_ieee"
                  value={form.paired_window_ieee || ""}
                  onChange={onChange}
                >
                  <option value="">Select unmapped window sensor</option>
                  {(unmapped_contact_devices || []).map((d) => (
                    <option key={d.ieee_address} value={d.ieee_address}>
                      {d.device || d.name || "Unnamed"} ({d.ieee_address})
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

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
              {isSaving ? "Saving..." : "Submit"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default DeviceForm;
