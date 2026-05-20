import "./App.css";
import { PrimaryLayout } from "./components/layout/primary";
import { AUTH_STORAGE_KEY } from "./constants/auth";
import SignIn from "./pages/auth/sign-in";
import Devices from "./pages/devices";
import { useState } from "react";

function App() {
  const [sessionEmail, setSessionEmail] = useState(() => {
    return window.localStorage.getItem(AUTH_STORAGE_KEY) || "";
  });
  //
  const handleLogin = (email, userData) => {
    window.localStorage.setItem(AUTH_STORAGE_KEY, email);
    window.localStorage.setItem("token", JSON.stringify(userData?.data?.token));
    setSessionEmail(email);
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
      <Devices />
    </PrimaryLayout>
  );
}

export default App;
