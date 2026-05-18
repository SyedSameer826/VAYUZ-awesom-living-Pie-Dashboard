import { useEffect, useState } from "react";

import axios from "axios";

function App() {
  const [devices, setDevices] = useState([]);

  useEffect(() => {
    fetchDevices();

    const interval = setInterval(fetchDevices, 3000);

    return () => clearInterval(interval);
  }, []);

  async function fetchDevices() {
    try {
      const res = await axios.get("http://localhost:4000/devices");

      setDevices(res.data);
    } catch (err) {
      console.log(err);
    }
  }

  async function renameDevice(from) {
    const to = prompt("Enter Friendly Name");

    if (!to) return;

    try {
      await axios.post("http://localhost:4000/rename", {
        from,
        to,
      });

      alert("Rename Sent");
    } catch (err) {
      console.log(err);
    }
  }

  return (
    <div
      style={{
        padding: "20px",
        fontFamily: "Arial",
      }}
    >
      <h1>Zigbee Dashboard</h1>

      {devices.map((device) => (
        <div
          key={device.ieee_address}
          style={{
            border: "1px solid #ccc",

            marginBottom: "20px",

            padding: "15px",

            borderRadius: "10px",
          }}
        >
          <h2>{device.friendly_name}</h2>

          <p>
            <b>IEEE:</b> {device.ieee_address}
          </p>

          <p>
            <b>Model:</b> {device.model}
          </p>

          <p>
            <b>Vendor:</b> {device.vendor}
          </p>

          <p>
            <b>Description:</b> {device.description}
          </p>

          <p>
            <b>Status:</b> {device.mapped ? "Mapped" : "Unmapped"}
          </p>

          {!device.mapped && (
            <button onClick={() => renameDevice(device.friendly_name)}>
              Rename Device
            </button>
          )}

          <h3>Latest Payload</h3>

          <pre
            style={{
              background: "#f5f5f5",

              padding: "10px",

              overflow: "auto",
            }}
          >
            {JSON.stringify(device.sample, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

export default App;
