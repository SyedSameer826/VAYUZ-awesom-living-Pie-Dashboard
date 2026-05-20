import { LuAlignJustify, LuPanelLeftClose, LuUser } from "react-icons/lu";
import { iconSize } from "../../utils";
export const Header = ({ collapsed, userEmail, onLogout, onToggleSidebar }) => {
  return (
    <header className="admin-header">
      <div className="admin-brand">
        <img src="/icons/ALlogo.png" alt="Awesome Living" />

        {/* <button
          type="button"
          aria-label="Toggle sidebar"
          onClick={onToggleSidebar}
        >
          <span></span>
          <span></span>
          <span></span>
        </button> */}
        <button
          onClick={onToggleSidebar}
          className="flex items-center justify-center"
        >
          {!collapsed ? (
            <LuPanelLeftClose
              className="text-black dark:text-white"
              size={iconSize}
            />
          ) : (
            <LuAlignJustify
              className="text-black dark:text-white"
              size={iconSize}
            />
          )}
        </button>
      </div>

      {/* <div className="admin-user">
        <button
          className="profile-button"
          type="button"
          onClick={onLogout}
          title="Logout"
        >
          <div className="avatar">
            <svg viewBox="0 0 24 24">
              <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z" />
            </svg>
          </div>

          <span>Admin</span>
        </button>
      </div> */}
    </header>
  );
};
