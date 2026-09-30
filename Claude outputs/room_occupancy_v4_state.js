import mongoose from 'mongoose';

// Per-room occupancy state for v4 two-sensor state machine
// (doorway PIR + inside PIR, no door/window contact sensor).
//
// Keyed by (resident, occupancy_group) — one document per physical room
// that has v4 occupancy configured.
//
// The actual state machine logic lives in occupancyStateMachine.cjs (pure,
// no I/O). This model stores the machine's snapshot so it survives restarts.
const schema = new mongoose.Schema(
  {
    resident: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'residents',
      required: true,
    },
    // Identifier that ties the 2 sensors together (e.g. "Washroom").
    // Matches device.occupancy_group on each member device.
    occupancy_group: { type: String, required: true, trim: true },

    // Human-readable label for this room (used in alerts/push copy).
    room_label: { type: String, default: 'Room', trim: true },

    // v4 state machine version tag — always 4.
    version: { type: Number, default: 4 },

    // Current state (matches occupancyStateMachine STATES enum).
    state: {
      type: String,
      enum: [
        'VACANT', 'TENTATIVE', 'OCCUPIED', 'EXIT_PENDING',
        'CHECKING', 'ALERTED', 'AWAY', 'DEGRADED',
      ],
      default: 'VACANT',
    },

    // The full snapshot blob from sm.snapshot() — opaque to Mongo,
    // interpreted only by the state machine's restore() method.
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    // Whether test mode is active for this room.
    test_mode: { type: Boolean, default: false },

    // Per-room threshold overrides (spec 4). Null = use DEFAULTS.
    config_overrides: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

schema.index({ resident: 1, occupancy_group: 1 }, { unique: true });
schema.index({ state: 1 }); // cron queries non-vacant rooms

export default mongoose.model('room_occupancy_v4_state', schema);
