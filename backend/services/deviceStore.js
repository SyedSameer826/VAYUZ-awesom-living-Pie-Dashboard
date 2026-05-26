export const upsertDevice = (device) => {
  const index = devices.findIndex(
    (d) => d.ieee_address === device.ieee_address,
  );

  // ========================================
  // UPDATE EXISTING DEVICE
  // ========================================

  if (index !== -1) {
    devices[index] = {
      ...devices[index],

      // only update live/device fields
      name: device.name,
      type: device.type,
    };
  } else {
    // ========================================
    // CREATE NEW DEVICE
    // ========================================

    devices.push({
      ...device,

      // default values only on first creation
      status: "unmapped",
      is_unassigned: true,
    });
  }

  saveDevices();

  return devices;
};
