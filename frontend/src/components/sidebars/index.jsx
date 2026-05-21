import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { sidebarLinks } from "../../constants/navigation";

import { LuLogOut } from "react-icons/lu";

import { iconSize } from "../../utils";
import { Button } from "../buttons";
import { NavLink } from "react-router-dom";
export const Sidebar = ({
  collapsed,
  mobileSidebarOpen,
  setMobileSidebarOpen,
  onLogout,
}) => {
  const navigate = useNavigate();

  const [signOutModalOpen, setSignOutModalOpen] = useState(false);

  const handleLogout = () => {
    onLogout();
    navigate("/login");
  };

  return (
    <>
      <aside
        className={`admin-sidebar ${collapsed ? "collapsed" : ""} ${mobileSidebarOpen ? "mobile-open" : ""}`}
        aria-label="Sidebar navigation"
      >
        {/* Sidebar Items */}
        <div className="flex flex-col gap-2 flex-1">
          {sidebarLinks.map((link) => (
            <NavLink
              key={link.label}
              to={link.url}
              title={link.label}
              className={({ isActive }) =>
                isActive ? "device-nav-item active" : "device-nav-item"
              }
              onClick={() => {
                if (window.innerWidth < 768) {
                  setMobileSidebarOpen(false);
                }
              }}
            >
              <svg viewBox="0 0 24 24">
                <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h4A2.5 2.5 0 0 1 13 6.5v4a2.5 2.5 0 0 1-2.5 2.5h-4A2.5 2.5 0 0 1 4 10.5v-4Zm2.5-.75a.75.75 0 0 0-.75.75v4c0 .41.34.75.75.75h4c.41 0 .75-.34.75-.75v-4a.75.75 0 0 0-.75-.75h-4ZM15 5h5v2h-5V5Zm0 4h5v2h-5V9ZM4 17h16v2H4v-2Zm0-3h16v2H4v-2Z" />
              </svg>

              {!collapsed && <span>{link.label}</span>}
            </NavLink>
          ))}
        </div>

        {/* Logout Footer */}
        <div className="sidebar-footer">
          <button
            onClick={() => {
              setMobileSidebarOpen(false);
              setSignOutModalOpen(true);
            }}
            className="logout-btn"
          >
            <LuLogOut size={iconSize} />

            {!collapsed && <span>Logout</span>}
          </button>
        </div>
      </aside>

      {/* Logout Modal */}
      <AnimatePresence>
        {signOutModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSignOutModalOpen(false)}
            className="logout-modal-overlay"
          >
            <motion.div
              initial={{ scale: 0.8, y: 80 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.8, y: 80 }}
              transition={{ duration: 0.25 }}
              onClick={(e) => e.stopPropagation()}
              className="logout-modal"
            >
              <div className="logout-modal-content">
                <div className="flex items-center justify-center text-base md:text-xl dark:text-white">
                  <div>Are you sure you want to signout?</div>
                </div>

                <div className="logout-modal-actions">
                  <Button onClick={handleLogout} mainPrimary={true}>
                    Sign Out
                  </Button>

                  <Button
                    onClick={() => setSignOutModalOpen(false)}
                    outLine={true}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
