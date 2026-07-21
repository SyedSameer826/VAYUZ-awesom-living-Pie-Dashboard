const API_BASE_URL = "/api/";
// Main backend (EC2). Overridable at build time via VITE_BACKEND_URL.
const REMOTE_BACKEND =
  "http://51.20.102.125" || import.meta.env.VITE_BACKEND_URL;

const getAuthHeaders = () => {
  const token = JSON.parse(window.localStorage.getItem("token"));

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
};

export const getDeviceDetails = async () => {
  const response = await fetch(`${API_BASE_URL}devices`, {
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error("Unable to load devices");
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
};

export const getResidents = async ({ last_id = "", limit = 100 } = {}) => {
  const query = new URLSearchParams();

  if (last_id) {
    query.append("last_id", last_id);
  }

  query.append("limit", limit);

  const response = await fetch(
    `${REMOTE_BACKEND}/api/user/resident/get_all_residents?${query.toString()}`,
    {
      method: "GET",
      headers: getAuthHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error("Unable to load residents");
  }

  const data = await response.json();
  return Array.isArray(data?.data?.data)
    ? data.data.data
    : Array.isArray(data)
      ? data
      : [];
};

export const assignDeviceName = async ({
  zigbee_ieee,
  zigbee_name,
  zigbee_type,
  resident,
}) => {
  const response = await fetch(`${API_BASE_URL}assign-name`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      zigbee_ieee,
      zigbee_name,
      zigbee_type,
      resident,
    }),
  });

  if (!response.ok) {
    throw new Error("Unable to save device");
  }

  return response.json();
};
export const assignCamera = async ({
  stream_name,
  local_ip,
  rtsp_url,
  resident,
  room,
}) => {
  const response = await fetch(`${API_BASE_URL}assign-camera`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      stream_name,
      local_ip,
      rtsp_url,
      resident,
      room,
    }),
  });

  if (!response.ok) {
    throw new Error("Unable to map camera");
  }

  return response.json();
};

export const scanCameras = async () => {
  const response = await fetch(`${API_BASE_URL}camera/pair/scan`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Camera scan failed");
  }

  return response.json();
};

// Turn on DHCP for a camera stuck on a static 192.168.1.x address (the Pi can
// reach it even when the laptop can't). After this, the camera reboots onto the
// main network and a Rescan will pick it up with a normal IP.
export const enableCameraDhcp = async ({ ip, password }) => {
  const response = await fetch(`${API_BASE_URL}camera/enable-dhcp`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ ip, password }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Unable to enable DHCP on the camera");
  }

  return data;
};

// Open a camera that's on an unreachable subnet (192.168.1.x) through the Pi.
// The Pi stands up a reverse proxy and returns a URL the laptop CAN reach; we
// open it in a new tab so the user can configure the camera (e.g. turn DHCP on).
export const openCameraSetup = async ({ ip }) => {
  const response = await fetch(`${API_BASE_URL}camera/open-setup`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ ip }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Unable to open the camera setup page");
  }

  return data;
};

// Scan (over BLE) for GLK sleep monitors in provisioning mode ("LZ-OTA <serial>").
export const scanGlk = async () => {
  const response = await fetch(`${API_BASE_URL}glk/scan`, {
    method: "POST",
    headers: getAuthHeaders(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "GLK scan failed");
  }
  return data; // { success, devices: [{ name, serial, address }] }
};

// Provision a GLK device onto the home WiFi + this Pi, then map it to a resident.
export const pairGlk = async ({
  address,
  serial,
  ssid,
  password,
  resident,
  room,
}) => {
  const response = await fetch(`${API_BASE_URL}glk/pair`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ address, serial, ssid, password, resident, room }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "GLK pairing failed");
  }
  return data;
};

export const deleteDevice = async (ieee_address) => {
  const response = await fetch(`${API_BASE_URL}devices/${ieee_address}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error("Unable to delete device");
  }

  return response.json();
};
