import "./App.css";
import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import { PrimaryLayout } from "./components/layout/primary";

import { AUTH_STORAGE_KEY } from "./constants/auth";

import SignIn from "./pages/auth/sign-in";
import Devices from "./pages/devices";
import Pairing from "./pages/pairing";
import HomeSetupModal from "./pages/HomeSetupModal";
import { getHubSetup } from "./services/deviceService";

function App() {
  const [sessionEmail, setSessionEmail] = useState(() => {
    return window.localStorage.getItem(AUTH_STORAGE_KEY) || "";
  });

  // Hub setup state — only checked AFTER the user is logged in.
  const [hubConfigured, setHubConfigured] = useState(null); // null = loading

  const handleLogin = (email, userData) => {
    window.localStorage.setItem(AUTH_STORAGE_KEY, email);

    window.localStorage.setItem("token", JSON.stringify(userData?.data?.token));

    setSessionEmail(email);
  };

  const handleLogout = () => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);

    window.localStorage.removeItem("token");

    setSessionEmail("");
    setHubConfigured(null);
  };

  // Check hub setup status only when the user is logged in.
  useEffect(() => {
    if (!sessionEmail) return;

    getHubSetup()
      .then((data) => setHubConfigured(data.configured))
      .catch(() => {
        // If the hub/setup endpoint is unreachable (e.g. dev mode without
        // the backend running), skip the modal and go straight to devices.
        setHubConfigured(true);
      });
  }, [sessionEmail]);

  // 1) Not logged in → show Sign In page.
  if (!sessionEmail) {
    return <SignIn onLogin={handleLogin} />;
  }

  // 2) Logged in but hub setup status still loading → show nothing (brief flash).
  if (hubConfigured === null) {
    return null;
  }

  // 3) Logged in but hub not configured → show Home Setup modal.
  if (!hubConfigured) {
    return <HomeSetupModal onComplete={() => setHubConfigured(true)} />;
  }

  // 4) Logged in + hub configured → show the main dashboard.
  return (
    <PrimaryLayout userEmail={sessionEmail} onLogout={handleLogout}>
      <Routes>
        <Route path="/" element={<Navigate to="/devices" />} />

        <Route path="/devices" element={<Devices />} />

        <Route path="/pairing" element={<Pairing />} />
      </Routes>
    </PrimaryLayout>
  );
}

export default App;
