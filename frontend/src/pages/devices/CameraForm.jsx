import { Button } from "../../components/buttons";

// Modal for mapping a CP Plus camera to a resident. Mirrors DeviceForm, but
// with camera fields (stream name, IP, optional RTSP url, room).
const CameraForm = ({
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
          <h2>Map Camera</h2>
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
            <span>RTSP URL (optional)</span>
            <input
              name="rtsp_url"
              value={form.rtsp_url}
              onChange={onChange}
              placeholder="rtsp://admin:pass@ip:554/..."
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
