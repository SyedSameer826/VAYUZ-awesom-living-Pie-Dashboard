import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io();

function Pairing() {
  const [logs, setLogs] = useState([]);
  const [isPairing, setIsPairing] = useState(false);

  const startPairing = async () => {
    try {
      setIsPairing(true);

      await fetch("/api/zigbee/pair/start", {
        method: "POST",
      });

      setTimeout(() => {
        setIsPairing(false);
      }, 60000);
    } catch (error) {
      console.error(error);
      setIsPairing(false);
    }
  };

  useEffect(() => {
    socket.on("zigbee-log", (log) => {
      setLogs((prev) => [log, ...prev]);
    });

    return () => {
      socket.off("zigbee-log");
    };
  }, []);

  return (
    <div className="crud-page">
      <div className="crud-header">
        <h1>Zigbee Pairing</h1>

        <button
          className="submit-button"
          onClick={startPairing}
          disabled={isPairing}
        >
          {isPairing ? "Pairing Active" : "Start Pairing"}
        </button>
      </div>

      <div className="crud-card">
        <div className="crud-card-title">
          <h2>Live Logs</h2>
        </div>

        <div
          style={{
            background: "#111",
            color: "#0f0",
            padding: "16px",
            height: "500px",
            overflow: "auto",
            fontFamily: "monospace",
          }}
        >
          {logs.map((log, index) => (
            <div key={index}>
              [{log.topic}] {log.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default Pairing;
