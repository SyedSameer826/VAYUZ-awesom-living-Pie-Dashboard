import express from 'express';
import * as hub_controller from '../controllers/hub_controller.js';
import { auth_jwt_user } from '../middleware/auth_middleware.js';

const router = express.Router();

// Optional shared-secret gate for the Pi heartbeat. If HUB_SECRET_KEY is unset
// on the backend, the endpoint is open (works out of the box); set the same
// value on the backend and the Pi (x-hub-secret header) to lock it down.
const hub_auth = (req, res, next) => {
  const required = process.env.HUB_SECRET_KEY;
  if (!required) return next();
  if (req.headers['x-hub-secret'] !== required) {
    return res.status(401).json({ success: false, message: 'unauthorized' });
  }
  next();
};

router.post('/heartbeat', hub_auth, hub_controller.heartbeat);
router.post('/sync-room-state', hub_auth, hub_controller.sync_room_state);
router.get('/status/:resident', hub_controller.get_status);

// App -> backend: queue a shutdown or reboot for the home's Pi hub.
// Body: { home_id, command: "shutdown" | "reboot" }
// The Pi picks it up on its next heartbeat (~30s).
router.post('/command', auth_jwt_user, hub_controller.send_command);

export default router;
