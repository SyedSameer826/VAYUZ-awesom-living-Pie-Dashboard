export const DataTable = ({
  data = [],
  headers = [],
  loading = false,
  onEdit,
  onDelete,
}) => {
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
                      device.is_unassigned ? "status unassigned" : "status"
                    }
                  >
                    {device.is_unassigned ? "Mapped" : "Unmapped"}
                  </span>
                </td>
                <td>
                  {device.status === "unmapped" && (
                    <div className="row-actions">
                      <button
                        className="table-link"
                        type="button"
                        onClick={() => onEdit(device)}
                      >
                        {device.status === "unmapped" ? "Map" : "View"}
                      </button>
                    </div>
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => onDelete(device.ieee_address)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};

export default DataTable;
