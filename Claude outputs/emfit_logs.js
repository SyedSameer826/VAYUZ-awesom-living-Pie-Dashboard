import mongoose from 'mongoose';

const emfit_logs_schema = new mongoose.Schema(
  {
    device_id: {
      type: String,
      default: null,
    },
    serialnumber: {
      type: String,
      index: true,
    },
    date_occurred: {
      type: String,
    },
    in_bed: {
      type: Boolean,
    },
    restless: {
      type: Boolean,
    },
    fast_movement: {
      type: String,
    },
    sitting_in_bed: {
      type: String,
    },
    intention_to_leave_bed: {
      type: Boolean,
      default: false,
    },
    heart_rate: {
      type: String,
    },
    respiration_rate: {
      type: String,
    },
    activity: {
      type: Number,
    },
    ii_heart_beat: {
      type: String,
    },
    snoring: {
      type: Boolean,
      default: false,
    },
    breathing_disturbance: {
      type: String,
      default: null,
    },
    tossnturn: {
      type: Boolean,
      default: false,
    },
    turning_reminder: {
      type: String,
      default: null,
    },
    movement_in_room: {
      type: String,
      default: null,
    },
    may_have_fallen_from_bed: {
      type: String,
      default: null,
    },
    too_long_sitting: {
      type: String,
      default: null,
    },
    sleep_stage: {
      type: String,
      default: 'unknown',
    },
    too_long_staying_in_bed: {
      type: String,
      default: null,
    },
    // ── GLK Vital Tracker fields (v24 bridge) ──
    apnea_suspected: {
      type: Boolean,
      default: null,
    },
    life_abnormality: {
      type: Boolean,
      default: null,
    },
    battery_level: {
      type: Number,
      default: null,
    },
    signal_quality: {
      type: Number,
      default: null,
    },
    body_movement: {
      type: Number,
      default: null,
    },
    glk_status: {
      type: String,
      default: null,
    },
    out_of_bed: {
      type: Boolean,
      default: null,
    },
    glk_sleep_stage: {
      type: String,
      default: null,
    },
    data_type: {
      type: String,
      default: null,
    },
    // 30-second deduplication bucket: Math.floor(Date.now() / 30000)
    time_bucket: {
      type: Number,
    },
  },

  {
    timestamps: true,
  },
);

// Enforce one log per device per 30-second window
emfit_logs_schema.index({ serialnumber: 1, time_bucket: 1 }, { unique: true, sparse: true });

const emfit_logs = mongoose.model('emfit_logs', emfit_logs_schema);

export default emfit_logs;
