import { useState } from "react";
import { Header } from "../../header";
import { Sidebar } from "../../sidebars";

export const PrimaryLayout = ({ children, userEmail, onLogout }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  return (
    <div className="admin-shell">
      <Header
        collapsed={collapsed}
        onToggleSidebar={() => {
          if (window.innerWidth <= 768) {
            setMobileSidebarOpen((prev) => !prev);
          } else {
            setCollapsed((prev) => !prev);
          }
        }}
      />

      <div className="admin-body">
        <Sidebar
          collapsed={collapsed}
          mobileSidebarOpen={mobileSidebarOpen}
          setMobileSidebarOpen={setMobileSidebarOpen}
          onLogout={onLogout}
        />

        <section className="page-body">{children}</section>
      </div>
    </div>
  );
};
