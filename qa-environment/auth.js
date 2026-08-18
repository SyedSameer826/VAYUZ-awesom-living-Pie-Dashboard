export const AUTH_STORAGE_KEY = "zigbee-dashboard-authenticated";
// Configurable via VITE_BACKEND_URL at build time; defaults to production.
export const BASE_URL =
  import.meta.env.VITE_BACKEND_URL || "https://awesomliving.com/api";
