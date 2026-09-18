export const emptyDeviceForm = {
  device: "",
  ieee_address: "",
  type: "",
  paired_motion_ieee: "",
  paired_window_ieee: "",
  occupancy_group: "",
  sensor_role: "",
  paired_motion_role: "",
  paired_window_role: "",
};

export const sensorRoleOptions = [
  { value: "", label: "None" },
  { value: "threshold_motion", label: "Threshold Motion (curtain/doorway PIR)" },
  { value: "room_motion", label: "Room Motion (in-room PIR)" },
  { value: "occupancy_door", label: "Occupancy Door (contact sensor)" },
];

export const deviceHeaders = [
  { fieldName: "device", headerName: "Device" },
  { fieldName: "ieee_address", headerName: "IEEE Address" },
  { fieldName: "type", headerName: "Type" },
  { fieldName: "status", headerName: "Status" },
  { fieldName: "action", headerName: "Action" },
];

// export const sampleDevices = [
//   {
//     id: "sample-bathroom-motion",
//     device: "bathroom_motion",
//     ieee_address: "0x00158d0001a2b3c4",
//     type: "motion",
//     status: "mapped",
//   },
//   {
//     id: "sample-contact",
//     device: "Unnamed Device",
//     ieee_address: "0x54ef4410008f2b91",
//     type: "contact",
//     status: "unmapped",
//   },
// ];
