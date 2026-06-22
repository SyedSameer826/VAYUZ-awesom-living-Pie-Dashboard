import { useEffect, useMemo, useState } from "react";
import DataTable from "../../components/table/dataTable";
import {
  deviceHeaders,
  emptyDeviceForm,
  sampleDevices,
} from "../../constants/device";
import {
  assignDeviceName,
  getDeviceDetails,
  getResidents,
} from "../../services/deviceService";
import { getDeviceId, mapDeviceRows } from "../../utils/devices";
import DeviceForm from "./DeviceForm";

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
    try {
      if (showLoader) {
        setIsLoading(true);
      }

      const [deviceData, residentData] = await Promise.all([
        getDeviceDetails(),
        getResidents(),
      ]);

      const updatedDevices = deviceData.length > 0 ? deviceData : sampleDevices;

      setDevices(updatedDevices);
      setResidents(residentData);
    } catch {
      setDevices(sampleDevices);
      setResidents([]);
      setError("");
    } finally {
      if (showLoader) {
        setIsLoading(false);
      }
    }
  };

  const openEditForm = (device) => {
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

      setDevices((current) =>
        current.filter((device) => device.ieee_address !== ieee_address),
      );
    } catch (deleteError) {
      alert(
        "Something went wrong while deleting the device. Please try again later or contact support.",
        deleteError,
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
    </main>
  );
}

export default Devices;
