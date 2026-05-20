const API_BASE_URL = "http://192.168.1.50:4000";

const getAuthHeaders = () => {
  const token = JSON.parse(window.localStorage.getItem("token"));

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
};

export const getDeviceDetails = async () => {
  const response = await fetch(`${API_BASE_URL}/devices`, {
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
    `https://backend-awesomliving.onrender.com/api/user/resident/get_all_residents?${query.toString()}`,
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
  const response = await fetch(`${API_BASE_URL}/assign-name`, {
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
