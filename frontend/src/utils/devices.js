export const getDeviceId = (device, index) => {
  return device.id || device.ieee_address || `device-${index}`;
};

export const mapDeviceRows = (devices) => {
  return devices.map((device, index) => ({
    id: getDeviceId(device, index),
    device: device.device || device.name || "Unnamed Device",
    ieee_address:
      device.ieee_address ||
      device.deviceNo ||
      device.sr_num ||
      device.client_id ||
      "-",
    type: device.type || "unknown",
    status: device.status === "mapped" ? "mapped" : "unmapped",
    local_ip: device.local_ip || "",
    stream_name: device.stream_name || "",
  }));
};
