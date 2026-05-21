import "./App.css";
import { useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import { PrimaryLayout } from "./components/layout/primary";

import { AUTH_STORAGE_KEY } from "./constants/auth";

import SignIn from "./pages/auth/sign-in";
import Devices from "./pages/devices";
import Pairing from "./pages/pairing";
import { nav } from "framer-motion/client";

function App() {
  const [sessionEmail, setSessionEmail] = useState(() => {
    return window.localStorage.getItem(AUTH_STORAGE_KEY) || "";
  });

  const handleLogin = (email, userData) => {
    window.localStorage.setItem(AUTH_STORAGE_KEY, email);

    window.localStorage.setItem("token", JSON.stringify(userData?.data?.token));

    setSessionEmail(email);
    window.location.replace("/devices");
  };

  const handleLogout = () => {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);

    window.localStorage.removeItem("token");

    setSessionEmail("");
  };

  if (!sessionEmail) {
    return <SignIn onLogin={handleLogin} />;
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
