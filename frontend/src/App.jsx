import { useEffect, useState } from 'react';

function App() {
  const [devices, setDevices] = useState([]);

  useEffect(() => {
    fetch('http://192.168.1.50:4000/devices')
      .then((res) => res.json())
      .then((data) => setDevices(data));
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h1>Zigbee Dashboard</h1>

      {devices.map((device, index) => (
        <div
          key={index}
          style={{
            border: '1px solid #ccc',
            marginBottom: 10,
            padding: 10,
            borderRadius: 8,
          }}
        >
          <h3>{device.name}</h3>

          <p>{device.ieee_address}</p>
        </div>
      ))}
    </div>
  );
}

export default App;