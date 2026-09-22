import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { app } from '../app.js';
import { createServer as create_server } from 'http';
import { on_connection } from './index.js';
import socket_service from '../utils/socket.js'; // ✅ ADD THIS
import service from '../service/health_logs.js'; // ✅ ADD THIS
import hub_service from '../service/hub_service.js';
import { start_glk_bedstate_checker } from '../service/glk_bedstate_service.js';
import { start_altum_alert_poller } from '../service/altum_alert_poller.js';
import { start_tick_loop } from '../service/room_occupancy_service_v2.js';
const server = create_server(app);

// Create the Socket IO server on
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT'],
    allowedHeaders: '*',
    credentials: true,
  },
});

// Reject the handshake unless it carries a valid JWT, and pin the
// authenticated user id to the socket so handlers can't be told a
// different id by the client.
io.use((socket, next) => {
  try {
    const auth_header = socket.handshake.headers?.authorization;
    const token =
      socket.handshake.auth?.token || (auth_header ? auth_header.replace(/^Bearer\s+/i, '') : null);

    if (!token) {
      return next(new Error('Authentication required'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = String(decoded.id);
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
});

socket_service.set_io(io);
io.on('connection', on_connection);

// ✅ START BACKGROUND JOB ONCE
// DISABLED per Occupancy_Logic_Final_Spec Section 1 — legacy bathroom
// alert system retired. The v2 occupancy state machine (bathroom_watch)
// handles all alerts now via its own tick loop.
// service.start_bathroom_alert_checker();
start_tick_loop();
service.start_emfit_alert_checker();
service.start_contact_alert_checker();
service.start_room_alert_checker();
service.start_device_offline_checker();
service.start_camera_health_checker();
start_glk_bedstate_checker();
hub_service.start_hub_health_checker();
// Pulls AltumView (Eltum) fall/help/fire alerts into alert_log + push with
// no portal setup required. Deduped against the Alert Forwarding webhook.
// Guarded: this runs at module scope, so an unexpected throw here would stop
// the whole backend booting -- taking every other device down with it. A
// broken Altum poller must degrade to "no Altum alerts", nothing worse.
try {
  start_altum_alert_poller();
} catch (err) {
  console.error('[altum-poller] failed to start; continuing without it:', err.message);
}
export { server, io };
