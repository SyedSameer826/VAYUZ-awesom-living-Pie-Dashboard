export const emptyDeviceForm = {
  device: "",
  ieee_address: "",
  type: "",
  resident: "",
};

export const deviceHeaders = [
  { fieldName: "device", headerName: "Device" },
  { fieldName: "ieee_address", headerName: "IEEE Address" },
  { fieldName: "type", headerName: "Type" },
  { fieldName: "status", headerName: "Status" },
  { fieldName: "action", headerName: "Action" },
];

export const sampleDevices = [
  {
    id: "sample-bathroom-motion",
    device: "bathroom_motion",
    ieee_address: "0x00158d0001a2b3c4",
    type: "motion",
    status: "mapped",
  },
  {
    id: "sample-contact",
    device: "Unnamed Device",
    ieee_address: "0x54ef4410008f2b91",
    type: "contact",
    status: "unmapped",
  },
];
