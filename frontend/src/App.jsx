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

  // Hub setup state: null = still checking, true = needs setup, false = already configured
  const [needsHubSetup, setNeedsHubSetup] = useState(null);

  const handleLogin = (email, userData) => {
    window.localStorage.setItem(AUTH_STORAGE_KEY, email);

    window.localStorage.setItem("token", JSON.stringify(userData?.data?.token));

    setSessionEmail(email);
    // Don't hard-redirect — let the hub-setup check run first.
  };

  const handleLogout = () => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);

    window.localStorage.removeItem("token");

    setSessionEmail("");
  };

  // After login, check whether the hub has been mapped to a home.
  useEffect(() => {
    if (!sessionEmail) {
      setNeedsHubSetup(null);
      return;
    }

    const checkSetup = async () => {
      try {
        const { configured } = await getHubSetup();
        setNeedsHubSetup(!configured);
      } catch {
        // If the check fails (backend unreachable), let the user through —
        // the heartbeat just won't fire until config exists.
        setNeedsHubSetup(false);
      }
    };

    checkSetup();
  }, [sessionEmail]);

  if (!sessionEmail) {
    return <SignIn onLogin={handleLogin} />;
  }

  // Still checking hub setup status — show nothing (fast check, <200ms).
  if (needsHubSetup === null) {
    return null;
  }

  // Hub not yet mapped — show the one-time home selection modal.
  if (needsHubSetup) {
    return (
      <PrimaryLayout userEmail={sessionEmail} onLogout={handleLogout}>
        <HomeSetupModal onComplete={() => setNeedsHubSetup(false)} />
      </PrimaryLayout>
    );
  }

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
