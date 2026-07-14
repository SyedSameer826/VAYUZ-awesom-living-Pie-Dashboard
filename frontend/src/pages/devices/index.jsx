import { useEffect, useMemo, useState } from "react";
import DataTable from "../../components/table/dataTable";
import {
  deviceHeaders,
  emptyDeviceForm,
  // sampleDevices,
} from "../../constants/device";
import {
  assignDeviceName,
  assignCamera,
  scanCameras,
  enableCameraDhcp,
  openCameraSetup,
  getDeviceDetails,
  getResidents,
  deleteDevice,
} from "../../services/deviceService";
import { getDeviceId, mapDeviceRows } from "../../utils/devices";
import DeviceForm from "./DeviceForm";
import CameraForm from "./CameraForm";
import CameraPairModal from "./CameraPairModal";

const emptyCameraForm = {
  stream_name: "",
  local_ip: "",
  camera_password: "",
  room: "living_room",
  resident: "",
};

function Devices() {
  const [devices, setDevices] = useState([]);
  const [form, setForm] = useState(emptyDeviceForm);
  const [editingId, setEditingId] = useState("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [residents, setResidents] = useState([]);
  const [cameraForm, setCameraForm] = useState(emptyCameraForm);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [isPairOpen, setIsPairOpen] = useState(false);
  const [discoveredCameras, setDiscoveredCameras] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const tableRows = useMemo(() => mapDeviceRows(devices), [devices]);
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return tableRows;
    }

    return tableRows.filter((device) => {
      return [device.device, device.ieee_address, device.type, device.status]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [search, tableRows]);

  const activeCount = tableRows.filter(
    (device) => device.status === "mapped",
  ).length;
  const inactiveCount = tableRows.length - activeCount;

  const loadData = async (showLoader = false) => {
    if (showLoader) {
      setIsLoading(true);
    }

    // Devices come from the Pi backend — this is the source of truth for the
    // listing. Load it INDEPENDENTLY so a failure of the remote resident API
    // (Render free tier cold-starts / DNS hiccups) can never wipe the device
    // list. Only an explicit delete should ever remove a device from the UI.
    try {
      const deviceData = await getDeviceDetails();
      setDevices(deviceData);
      setError("");
    } catch {
      setError(
        "Could not load devices — backend may be restarting. Click Refresh to retry.",
      );
    }

    // Residents come from the remote backend (Render.com). They only populate
    // the assignment dropdown, so a failure here must NOT touch the devices.
    try {
      const residentData = await getResidents();
      setResidents(residentData);
    } catch {
      // Keep whatever residents we already have — the dropdown may be stale.
    }

    if (showLoader) {
      setIsLoading(false);
    }
  };

  const openEditForm = (device) => {
    // Camera rows go to the camera mapping flow, pre-filled — not the Zigbee form.
    if (device.type === "camera") {
      setCameraForm({
        stream_name: device.stream_name || device.ieee_address || "",
        local_ip: device.local_ip || "",
        camera_password: "",
        room: "living_room",
        resident: "",
      });
      setError("");
      setIsCameraOpen(true);
      return;
    }

    setForm({
      device: device.device === "Unnamed Device" ? "" : device.device,
      ieee_address: device.ieee_address === "-" ? "" : device.ieee_address,
      type: device.type === "unknown" ? "" : device.type,
      resident: device.resident || "",
    });

    setEditingId(device.id);
    setError("");
    setIsFormOpen(true);
  };

  const closeForm = () => {
    setForm(emptyDeviceForm);
    setEditingId("");
    setIsFormOpen(false);
  };

  const openCameraForm = () => {
    setCameraForm(emptyCameraForm);
    setError("");
    setIsCameraOpen(true);
  };

  const closeCameraForm = () => {
    setCameraForm(emptyCameraForm);
    setIsCameraOpen(false);
  };

  const handleCameraChange = (event) => {
    const { name, value } = event.target;
    setCameraForm((current) => ({ ...current, [name]: value }));
  };

  const handleSaveCamera = async (event) => {
    event.preventDefault();

    if (!cameraForm.stream_name.trim() || !cameraForm.resident) {
      setError("Stream name and resident are required");
      return;
    }

    setIsSaving(true);
    setError("");

    // Build the RTSP URL from the IP + admin password the user entered. Only
    // needed to (re)register a new camera's stream in go2rtc; if left blank the
    // stream is assumed to already exist.
    const ip = cameraForm.local_ip.trim();
    const password = (cameraForm.camera_password || "").trim();
    const rtsp_url =
      password && ip
        ? `rtsp://admin:${encodeURIComponent(password)}@${ip}:554/video/live?channel=1&subtype=0`
        : "";

    try {
      await assignCamera({
        stream_name: cameraForm.stream_name.trim(),
        local_ip: ip,
        rtsp_url,
        resident: cameraForm.resident,
        room: cameraForm.room.trim() || "living_room",
      });
      closeCameraForm();
      await loadData();
    } catch (cameraError) {
      setError(cameraError.message || "Unable to map camera");
    } finally {
      setIsSaving(false);
    }
  };

  // Sweep the network for cameras (same approach used to find the first one).
  const runCameraScan = async () => {
    setIsScanning(true);
    setError("");
    try {
      const result = await scanCameras();
      setDiscoveredCameras(result.cameras || []);
      await loadData(); // newly discovered cameras now appear as unmapped
    } catch (scanError) {
      setError(scanError.message || "Camera scan failed");
      setDiscoveredCameras([]);
    } finally {
      setIsScanning(false);
    }
  };

  const openPairModal = () => {
    setDiscoveredCameras([]);
    setIsPairOpen(true);
    runCameraScan();
  };

  // Turn on DHCP for a camera that's stuck on a static 192.168.1.x address.
  // The Pi can reach it even though the laptop can't; after this the camera
  // reboots onto the main network and the next Rescan finds it normally.
  const handleEnableDhcp = async (cam) => {
    const password = window.prompt(
      `Enter the admin password for the camera at ${cam.ip} to turn on DHCP:`,
    );
    if (!password) return; // cancelled

    setError("");
    try {
      const result = await enableCameraDhcp({ ip: cam.ip, password });
      alert(
        result.message ||
          "DHCP enabled. Wait ~1 minute for the camera to reboot, then Rescan.",
      );
    } catch (dhcpError) {
      setError(dhcpError.message || "Unable to enable DHCP on the camera");
      alert(dhcpError.message || "Unable to enable DHCP on the camera");
    }
  };

  // Open a stuck camera's own page THROUGH the Pi (reverse proxy), so the user
  // can flip DHCP on even though the laptop can't reach the camera's subnet.
  const handleOpenCameraSetup = async (cam) => {
    setError("");
    try {
      const { url } = await openCameraSetup({ ip: cam.ip });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (setupError) {
      setError(setupError.message || "Unable to open the camera setup page");
      alert(setupError.message || "Unable to open the camera setup page");
    }
  };

  // From a discovered camera, jump straight into the Map Camera form, pre-filled.
  const mapDiscoveredCamera = (cam) => {
    setIsPairOpen(false);
    setCameraForm({
      stream_name: cam.stream_name || "",
      local_ip: cam.ip || "",
      camera_password: "",
      room: "living_room",
      resident: "",
    });
    setError("");
    setIsCameraOpen(true);
  };
  useEffect(() => {
    loadData(true);
  }, []);

  const handleFormChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleSave = async (event) => {
    event.preventDefault();

    if (!form.device.trim() || !form.type.trim()) {
      setError("Device and Type are required");
      return;
    }

    setIsSaving(true);
    setError("");

    const nextDevice = {
      device: form.device.trim(),
      name: form.device.trim(),
      ieee_address: form.ieee_address.trim(),
      type: form.type.trim(),
      resident: form.resident,
      status: "mapped",
      is_unassigned: false,
    };

    try {
      try {
        await assignDeviceName({
          zigbee_ieee: nextDevice.ieee_address,
          zigbee_name: nextDevice.device,
          zigbee_type:
            nextDevice.type == "contact" ? "door & window" : nextDevice.type,
          resident: nextDevice.resident,
        });
        setDevices((current) =>
          current.map((device, index) => {
            const id = getDeviceId(device, index);

            return id === editingId ? { ...device, ...nextDevice } : device;
          }),
        );
        closeForm();
      } catch {
        closeForm();
        alert(
          "Something went wrong while saving the device.Please try again later or contact support.",
        );
        // Keep the UI responsive when the local Zigbee API is unavailable.
      }
    } catch (saveError) {
      setError(saveError.message || "Unable to save device");
    } finally {
      setIsSaving(false);
    }
  };
  const handleDelete = async (ieee_address) => {
    const confirmed = window.confirm(
      "Are you sure you want to delete this device?",
    );

    if (!confirmed) return;

    try {
      await deleteDevice(ieee_address);
      await loadData(); // refresh from server after delete
    } catch (deleteError) {
      console.log("Delete error:", deleteError);
      alert(
        "Something went wrong while deleting the device. Please try again later or contact support.",
      );
    }
  };
  return (
    <main className="crud-page">
      <header className="crud-header">
        <div>
          <p className="breadcrumb-line">
            <span className="breadcrumb-icon">::</span>
            <span>/</span>
            <strong>Device</strong>
          </p>
          <h1>Device Listing</h1>
        </div>
      </header>

      {error && <p className="crud-alert">{error}</p>}

      <section className="device-summary-grid" aria-label="Device summary">
        <article className="summary-card total">
          <div>
            <span className="summary-icon">+</span>
            <p>Total Device</p>
          </div>
          <strong>{tableRows.length}</strong>
        </article>
        <article className="summary-card active">
          <div>
            <span className="summary-icon">+</span>
            <p>Mapped Device</p>
          </div>
          <strong>{activeCount}</strong>
        </article>
        <article className="summary-card inactive">
          <div>
            <span className="summary-icon">+</span>
            <p>Unmapped Device</p>
          </div>
          <strong>{inactiveCount}</strong>
        </article>
      </section>

      <section className="crud-card">
        <div className="crud-card-title table-toolbar">
          <div className="header-actions">
            <button
              className="outline-button"
              onClick={() => loadData(true)}
              disabled={isLoading}
            >
              {isLoading ? "Refreshing..." : "Refresh"}
            </button>
            <button className="submit-button" onClick={openPairModal}>
              Pair Camera
            </button>
            <button className="submit-button" onClick={openCameraForm}>
              Map Camera
            </button>
          </div>
          <label className="table-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m20.71 19.29-4.1-4.1A7.5 7.5 0 1 0 15.2 16.6l4.1 4.1 1.41-1.41ZM5.5 10.5a5 5 0 1 1 10 0 5 5 0 0 1-10 0Z" />
            </svg>
            <input
              className="table-search-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search device"
            />
          </label>
        </div>

        <DataTable
          data={filteredRows}
          headers={deviceHeaders}
          loading={isLoading}
          onEdit={openEditForm}
          onDelete={handleDelete}
        />
      </section>

      {isFormOpen && (
        <DeviceForm
          editingId={editingId}
          form={form}
          residents={residents}
          isSaving={isSaving}
          onChange={handleFormChange}
          onClose={closeForm}
          onSubmit={handleSave}
        />
      )}

      {isCameraOpen && (
        <CameraForm
          form={cameraForm}
          residents={residents}
          isSaving={isSaving}
          onChange={handleCameraChange}
          onClose={closeCameraForm}
          onSubmit={handleSaveCamera}
        />
      )}

      {isPairOpen && (
        <CameraPairModal
          cameras={discoveredCameras}
          isScanning={isScanning}
          onMap={mapDiscoveredCamera}
          onEnableDhcp={handleEnableDhcp}
          onOpenSetup={handleOpenCameraSetup}
          onRescan={runCameraScan}
          onClose={() => setIsPairOpen(false)}
        />
      )}
    </main>
  );
}

export default Devices;
