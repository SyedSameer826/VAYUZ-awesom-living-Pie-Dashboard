import mongoose from 'mongoose';

const { Schema } = mongoose;

const device_schema = new Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['Eltum', 'Emfit', 'Zigbee', 'CpPlus', 'BpMonitor'],
      trim: true,
    },
    resident: {
      type: Schema.Types.ObjectId,
      ref: 'residents',
      default: null,
    },
    home: {
      type: Schema.Types.ObjectId,
      ref: 'homes',
      default: null,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    // Position of this device within its resident's same-type "section"
    // (e.g. among the resident's Zigbee sensors, or among their CpPlus
    // cameras), lowest first — scoped by (resident, type), not global. Set
    // via the sort-devices API; devices without an explicit order fall back
    // to insertion order (see the sort_order + _id compound sort at read time).
    sort_order: {
      type: Number,
      default: 0,
    },
  },
  { discriminatorKey: 'type', timestamps: true },
);

device_schema.index({ resident: 1 });
device_schema.index({ resident: 1, status: 1 });
device_schema.index({ type: 1, status: 1 });
device_schema.index({ resident: 1, type: 1, sort_order: 1 });
device_schema.index({ home: 1, status: 1 });
device_schema.index({ home: 1, type: 1, sort_order: 1 });

const Device = mongoose.model('devices', device_schema);

Device.discriminator(
  'Eltum',
  new Schema({
    camera_id: String,
    firmware_version: String,
    sr_num: String,
    grant_type: { type: String, default: 'client_credentials' },
    scope: {
      type: String,
      default:
        'camera:write room:write alert:write person:write user:write group:write invitation:write person_info:write',
    },
    client_id: String,
    client_secret: String,
    device_status: {
      type: String,
      enum: [
        'ADMIN_MAPPED',
        'USER_SIGNIN_IN_PROGRESS',
        'USER_SIGNIN_DONE',
        'CALIBRATION_IN_PROGRESS',
        'CALIBRATION_DONE',
        'STREAMING_IN_PROGRESS',
        'STREAMING_DONE',
        'ACTIVE',
      ],
      default: 'ADMIN_MAPPED',
    },
    altum_token: String,
    token_updated_at: Date,
    // High-water mark for service/altum_alert_poller.js: the timestamp of
    // the newest AltumView alert already turned into an alert_log + push
    // for this device. Null means "never polled" -- the poller then sets a
    // baseline from current history WITHOUT notifying, so switching the
    // poller on can't replay old falls as fresh emergencies.
    alert_poll_watermark: { type: Date, default: null },
  }),
);

Device.discriminator(
  'Emfit',
  new Schema({
    sr_num: String,
  }),
);

Device.discriminator(
  'Zigbee',
  new Schema({
    id: String,
    ieee: String,
    sensor_type: String,
    room: { type: String, default: 'bathroom' },
    paired_motion_ieee: { type: String, default: null },
    paired_window_ieee: { type: String, default: null },
    occupancy_group: { type: String, default: null, trim: true },
    sensor_role: {
      type: String,
      enum: [null, 'threshold_motion', 'room_motion', 'occupancy_door', 'doorway', 'inside'],
      default: null,
    },
  }),
);

Device.discriminator(
  'CpPlus',
  new Schema({
    stream_name: String,
    local_ip: String,
    camera_last_seen: Date,
    room: { type: String, default: 'living_room' },
    // Which Pi hub manages this camera — links to hub_status.hub_id so the
    // backend can resolve the correct go2rtc tunnel URL per camera.
    hub_id: { type: String, default: null, trim: true },
    // Full RTSP URL stored for re-provisioning: if go2rtc restarts, the Pi
    // can re-register every assigned camera's stream from this field.
    rtsp_url: { type: String, default: null },
  }),
);

Device.discriminator(
  'BpMonitor',
  new Schema({
    mac_address: { type: String, required: true, trim: true },
    sr_num: String,
  }),
);

export default Device;
