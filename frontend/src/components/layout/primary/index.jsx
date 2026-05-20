import { useState } from "react";
import { Header } from "../../header";
import { Sidebar } from "../../sidebars";

export const PrimaryLayout = ({ children, userEmail, onLogout }) => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="admin-shell">
      <Header
        collapsed={collapsed}
        onToggleSidebar={() => setCollapsed(!collapsed)}
      />

      <div className="admin-body">
        <Sidebar collapsed={collapsed} onLogout={onLogout} />

        <section className="page-body">{children}</section>
      </div>
    </div>
  );
};
