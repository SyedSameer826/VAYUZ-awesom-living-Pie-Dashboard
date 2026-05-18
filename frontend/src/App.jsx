import { useEffect, useState } from 'react';

function App() {
  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [zigbeeName, setZigbeeName] = useState('');

  const fetchDevices = () => {
    fetch('http://192.168.1.50:4000/devices')
      .then((res) => res.json())
      .then((data) => setDevices(data));
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  const submitName = async () => {
    await fetch('http://192.168.1.50:4000/assign-name', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        zigbee_ieee: selectedDevice.ieee_address,
        zigbee_name: zigbeeName,
      }),
    });

    setSelectedDevice(null);
    setZigbeeName('');

    fetchDevices();
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>Zigbee Dashboard</h1>

      {devices.map((device, index) => (
        <div
          key={index}
          style={{
            border: '1px solid #ccc',
            padding: 15,
            marginBottom: 15,
            borderRadius: 10,
          }}
        >
          <h3>{device.name}</h3>

          <p>{device.ieee_address}</p>

          {device.is_unassigned && (
            <button
              onClick={() => setSelectedDevice(device)}
            >
              Add Name
            </button>
          )}
        </div>
      ))}

      {selectedDevice && (
        <div
          style={{
            border: '2px solid black',
            padding: 20,
            marginTop: 20,
          }}
        >
          <h2>Assign Device Name</h2>

          <div>
            <label>Zigbee IEEE</label>

            <input
              value={selectedDevice.ieee_address}
              disabled
              style={{
                width: '100%',
                marginBottom: 10,
              }}
            />
          </div>

          <div>
            <label>Zigbee Name</label>

            <input
              value={zigbeeName}
              onChange={(e) => setZigbeeName(e.target.value)}
              placeholder="Enter device name"
              style={{
                width: '100%',
                marginBottom: 10,
              }}
            />
          </div>

          <button onClick={submitName}>
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

export default App;