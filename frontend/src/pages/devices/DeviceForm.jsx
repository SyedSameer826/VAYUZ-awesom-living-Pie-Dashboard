import { Button } from "../../components/buttons";
const DeviceForm = ({
  editingId,
  form,
  residents,
  isSaving,
  onChange,
  onClose,
  onSubmit,
}) => {
  return (
    <div className="device-form-modal">
      <div className="modal-backdrop">
        <form className="crud-form" onSubmit={onSubmit}>
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
            </select>
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
              {isSaving ? "Saving..." : "Submit"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default DeviceForm;
