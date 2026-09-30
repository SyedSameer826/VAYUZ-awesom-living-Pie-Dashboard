import express from 'express';
import * as device_controller from '../controllers/device_controller.js';
import { auth_jwt_user } from '../middleware/auth_middleware.js';
import {
  auth_header_validator,
  device_id_mobile_param_validator,
  validate,
  resident_id_param_validator,
  serial_number_body_validator,
  firmware_version_body_validator,
  device_id_param_validator,
} from '../helper/validator.js';
import { track_authenticated_activity } from '../middleware/activity.middleware.js';
import upload, { upload_memory } from '../middleware/upload.js';
const router = express.Router();
router.get(
  '/list',
  validate([auth_header_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.get_device_liting,
);
router.post(
  '/',
  validate([auth_header_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.create_device,
);
router.delete(
  '/:device',
  validate([auth_header_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.delete_device,
);
router.put(
  '/:serial_no',
  validate([auth_header_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.is_device_already_mapped_to_resident,
);
router.get(
  '/:serial_no',
  validate([auth_header_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.is_device_online,
);

router.post(
  '/create-token/:device',
  validate([auth_header_validator, device_id_mobile_param_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.create_token,
);

router.post(
  '/:device_id/signin',
  validate([auth_header_validator, device_id_mobile_param_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.signin_altum_device,
);
router.post(
  '/update-device-mapping/:device_id',
  validate([
    auth_header_validator,
    device_id_mobile_param_validator,
    serial_number_body_validator,
    firmware_version_body_validator,
  ]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.update_device_mapping,
);
router.post(
  '/:device_id/setup',
  validate([auth_header_validator, device_id_mobile_param_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.create_altum_setup,
);
router.get('/:device_id/preview', auth_jwt_user, device_controller.get_preview_image);

router.post('/:device_id/calibrate', auth_jwt_user, device_controller.calibrate_camera);

// Recovery for a setup run that failed partway: deletes the half-created Altum
// camera/room (an orphaned room is found by its `<sr_num>_Room` name, since a
// failed setup leaves no local trace of it) and resets the device so setup can
// be retried. See service/altum_setup_recovery_service.js.
router.post(
  '/:device_id/setup/rollback',
  validate([auth_header_validator, device_id_mobile_param_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.rollback_device_setup,
);

// Calibration health check + repair. Calibration itself creates nothing, so
// there is nothing to delete; this verifies the camera still exists in Altum
// and re-syncs a missing/stale camera_id, which is what actually blocks it.
router.post(
  '/:device_id/calibration/verify',
  validate([auth_header_validator, device_id_mobile_param_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.verify_device_calibration,
);

router.post('/:device_id/save-background', auth_jwt_user, device_controller.save_background);
// routes/device.routes.js

router.get('/:device_id/status', auth_jwt_user, device_controller.get_camera_status);

router.get('/:device_id/background-url', auth_jwt_user, device_controller.get_background_url);

router.get('/:device_id/stream-token', auth_jwt_user, device_controller.get_stream_token);

router.get('/:device_id/mqtt', auth_jwt_user, device_controller.get_mqtt_credentials);

router.get('/:device_id/group-info', auth_jwt_user, device_controller.get_group_info);
// ======================================================
// ROUTES
// ======================================================

// router.get('/person-groups', auth_jwt_user, device_controller.get_person_groups);
router.get('/:device_id/person-groups', auth_jwt_user, device_controller.get_person_groups);
router.post('/:device_id/person-groups', auth_jwt_user, device_controller.create_person_group);

router.patch(
  '/:device_id/person-groups/:group_id',
  auth_jwt_user,
  device_controller.update_person_group,
);

router.delete(
  '/:device_id/person-groups/:group_id',
  auth_jwt_user,
  device_controller.delete_person_group,
);

router.get('/:device_id/people', auth_jwt_user, device_controller.get_people);

router.post(
  '/:device_id/people',
  auth_jwt_user,
  upload_memory.single('face_image'),
  device_controller.create_person,
);

router.patch(
  '/:device_id/people/:person_id/group',
  auth_jwt_user,
  device_controller.assign_person_group,
);

router.post(
  '/:device_id/people/:person_id/face',
  auth_jwt_user,
  upload_memory.single('image'),
  device_controller.upload_person_face,
);

router.delete('/:device_id/people/:person_id', auth_jwt_user, device_controller.delete_person);
// GET /devices/:device_id/alerts
router.get('/:device_id/alerts', auth_jwt_user, device_controller.get_alerts);

// GET /devices/:device_id/alerts/:alert_id
router.get('/:device_id/alerts/:alert_id', auth_jwt_user, device_controller.get_alert_by_id);

// PATCH /devices/:device_id/alerts/all — must come BEFORE /:alert_id so
// Express doesn't treat "all" as a Mongo ObjectId.
router.patch('/:device_id/alerts/all', auth_jwt_user, device_controller.resolve_all_alerts);

// PATCH /devices/:device_id/alerts/:alert_id
router.patch('/:device_id/alerts/:alert_id', auth_jwt_user, device_controller.resolve_alert);
// GET alert settings
router.get(
  '/:device_id/cameras/:camera_id/alert-settings',
  auth_jwt_user,
  device_controller.get_alert_settings,
);
router.get('/:device_id/alert-analytics', auth_jwt_user, device_controller.get_alert_analytics);
// PATCH alert settings
router.patch(
  '/:device_id/cameras/:camera_id/alert-settings',
  auth_jwt_user,
  device_controller.update_alert_settings,
);
// CP Plus stream URL (no credentials, no RTSP exposed)
router.get(
  '/:device/watch',
  validate([device_id_param_validator]),
  auth_jwt_user,
  track_authenticated_activity,
  device_controller.watch_cpplus,
);

// ── Contact (door/window) alert monitoring window ─────────────────────────────
// GET  /api/user/devices/:device_id/contact-settings  → fetch current window
// PATCH /api/user/devices/:device_id/contact-settings → set/update window
router.get(
  '/:device_id/contact-settings',
  auth_jwt_user,
  device_controller.get_contact_alert_settings,
);
router.patch(
  '/:device_id/contact-settings',
  auth_jwt_user,
  device_controller.update_contact_alert_settings,
);

// ── Motion + Presence no-motion alert settings ────────────────────────────────
// GET  /api/user/devices/:device_id/no-motion-settings  → fetch config for presence sensor
// PATCH /api/user/devices/:device_id/no-motion-settings → set/update config
// GET  /api/user/devices/:device_id/room-state          → current combined room state
// PATCH /api/user/devices/:device_id/no-motion-threshold → set only the initial alert time
router.patch(
  '/:device_id/no-motion-threshold',
  auth_jwt_user,
  device_controller.set_no_motion_threshold,
);
router.get(
  '/:device_id/no-motion-settings',
  auth_jwt_user,
  device_controller.get_no_motion_settings,
);
router.patch(
  '/:device_id/no-motion-settings',
  auth_jwt_user,
  device_controller.update_no_motion_settings,
);
router.get('/:device_id/room-state', auth_jwt_user, device_controller.get_device_room_state);

// ── Occupancy v4 endpoints ─────────────────────────────────────────────────
router.get('/:device_id/room-state-v4', auth_jwt_user, device_controller.get_v4_room_state_handler);
router.post('/:device_id/acknowledge-v4', auth_jwt_user, device_controller.acknowledge_v4_alert_handler);
router.post('/:device_id/away-v4', auth_jwt_user, device_controller.set_v4_away_handler);

// GET /api/user/devices/:device_id/no-motion-alerts
// Returns latest 10 no-motion alert logs for a presence device. ?limit=N to override (max 50).
router.get(
  '/:device_id/no-motion-alerts',
  auth_jwt_user,
  device_controller.get_no_motion_alert_history,
);

export default router;
