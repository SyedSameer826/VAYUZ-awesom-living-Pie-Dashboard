import { useState } from "react";
export const DataTable = ({
  data = [],
  headers = [],
  loading = false,
  onEdit,
  onDelete,
}) => {
  const [openMenu, setOpenMenu] = useState(null);
  const formatIeeeAddress = (address) => {
    if (!address || address.length <= 10) {
      return address || "-";
    }

    return `${address.slice(0, 8)}...`;
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header.fieldName}>{header.headerName}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={headers.length}>Loading devices...</td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={headers.length}>No devices found.</td>
            </tr>
          ) : (
            data.map((device) => (
              <tr key={device.id}>
                <td>
                  <span
                    className={
                      device.device === "Unnamed Device" ? "muted-device" : ""
                    }
                  >
                    {device.device}
                  </span>
                </td>
                <td title={device.ieee_address}>
                  {formatIeeeAddress(device.ieee_address)}
                </td>
                <td>{device.type}</td>
                <td>
                  <span
                    className={
                      device.status == "unmapped"
                        ? "status unassigned"
                        : "status"
                    }
                  >
                    {device.status != "unmapped" ? "Mapped" : "Unmapped"}
                  </span>
                </td>
                <td>
                  <div className="action-menu">
                    <button
                      className="action-trigger"
                      onClick={() =>
                        setOpenMenu(
                          openMenu === device.ieee_address
                            ? null
                            : device.ieee_address,
                        )
                      }
                    >
                      ⋮
                    </button>

                    {openMenu === device.ieee_address && (
                      <div className="action-dropdown">
                        {device.status === "unmapped" && (
                          <button
                            onClick={() => {
                              setOpenMenu(null);
                              onEdit(device);
                            }}
                          >
                            Map
                          </button>
                        )}

                        <button
                          className="delete-btn"
                          onClick={() => {
                            setOpenMenu(null);
                            onDelete(device.ieee_address);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Click-away layer: closes an open action menu when clicking elsewhere. */}
      {openMenu && (
        <div
          onClick={() => setOpenMenu(null)}
          style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        />
      )}
    </div>
  );
};

export default DataTable;
