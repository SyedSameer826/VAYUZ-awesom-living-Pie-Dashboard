import { useEffect, useState } from "react";
import { Button } from "../components/buttons";
import { getHomes, saveHubSetup } from "../services/deviceService";

const HomeSetupModal = ({ onComplete }) => {
  const [homes, setHomes] = useState([]);
  const [selectedHome, setSelectedHome] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadHomes = async () => {
      try {
        const data = await getHomes();
        setHomes(data);
        if (data.length === 1) {
          setSelectedHome(data[0]._id);
        }
      } catch {
        setError("Could not load homes. Please check your connection and try again.");
      } finally {
        setIsLoading(false);
      }
    };

    loadHomes();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!selectedHome) {
      setError("Please select a home");
      return;
    }

    setIsSaving(true);
    setError("");

    try {
      await saveHubSetup(selectedHome);
      onComplete();
    } catch (saveError) {
      setError(saveError.message || "Unable to save. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="device-form-modal">
      <div className="modal-backdrop">
        <div
          className="crud-form"
          style={{ display: "block", maxWidth: 440 }}
          onClick={(e) => e.stopPropagation()}
        >
          <h2>Setup Hub</h2>

          <p style={{ margin: "0 0 16px", color: "#555", fontSize: 14, lineHeight: 1.5 }}>
            Select the home this Pi hub belongs to. This links the hub to your
            home so the app can show its online status. You only need to do this
            once.
          </p>

          {error && (
            <p
              style={{
                color: "#dc2626",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {error}
            </p>
          )}

          {isLoading ? (
            <p style={{ color: "#555", margin: "0 0 16px" }}>
              Loading homes...
            </p>
          ) : homes.length === 0 ? (
            <p style={{ color: "#92400e", margin: "0 0 16px" }}>
              No homes found for your account. Please create a home in the app
              first, then refresh this page.
            </p>
          ) : (
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 16 }}>
                <label
                  htmlFor="home-select"
                  style={{
                    display: "block",
                    marginBottom: 6,
                    fontWeight: 500,
                    fontSize: 14,
                  }}
                >
                  Home
                </label>
                <select
                  id="home-select"
                  value={selectedHome}
                  onChange={(e) => {
                    setSelectedHome(e.target.value);
                    setError("");
                  }}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid #d1d5db",
                    fontSize: 14,
                    background: "#fff",
                    cursor: "pointer",
                  }}
                >
                  <option value="">-- Select a home --</option>
                  {homes.map((home) => (
                    <option key={home._id} value={home._id}>
                      {home.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-actions">
                <Button type="submit" disabled={isSaving || !selectedHome}>
                  {isSaving ? "Saving..." : "Submit"}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default HomeSetupModal;
