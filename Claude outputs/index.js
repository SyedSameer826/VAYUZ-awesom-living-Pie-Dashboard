// import { auth_jwt_user } from '../middleware/auth_middleware.js';
import user from '../models/users.js';
import get_data from '../service/health_logs.js';
import { handle_get_bathroom_status } from '../service/room_occupancy_service_v2.js';
export const on_connection = (socket) => {
  // socket.userId is set from the verified JWT in the io.use() auth
  // middleware (server.js) — never trust a client-supplied id here.
  //
  // Join the user's room and persist socket_id immediately on connect,
  // rather than waiting for the client to emit 'active_app_user'. Relying
  // on that client event left a window where a socket was authenticated
  // and connected but never actually joined its room (e.g. the app
  // reconnects after being backgrounded without re-emitting the event) --
  // send_to_user() would then emit to an empty room and silently drop the
  // message, even though target_user.socket_id still read as truthy from
  // a stale prior session.
  if (socket.userId) {
    socket.join(socket.userId);
    user.findByIdAndUpdate(socket.userId, { socket_id: socket.id }).catch((err) => {
      console.error('[socket] failed to persist socket_id on connect:', err.message);
    });
  }

  // Kept for backward compatibility with app builds that still emit this --
  // now a harmless no-op re-join/re-save, not the only path to joining.
  socket.on('active_app_user', async () => {
    await user.findByIdAndUpdate(socket.userId, { socket_id: socket.id });
    socket.join(socket.userId);
  });
  socket.on('get_bathroom_status', async (data) => {
    const { device_name } = data;

    // v2 occupancy handler — emits bathroom_status for sensors tagged
    // with occupancy_group (uses the BathroomWatch state machine).
    if (socket.userId) {
      handle_get_bathroom_status(socket.userId, data);
    }

    // Legacy fallback — still serves untagged standalone motion sensors.
    const bathroom_data = await get_data.get_bathroom_data(device_name);
    socket.emit('bathroom_status', bathroom_data);
  });
  socket.on('get_switch_status', async (data) => {
    const { device_name } = data;

    const switch_data = await get_data.get_switch_data(device_name);

    socket.emit('switch_status', {
      device: device_name,
      action: switch_data?.last_action || null,
      time: switch_data?.last_seen?.toISOString?.() || null,
      is_active: switch_data?.is_active || false,
    });
  });
  socket.on('get_contact_status', async (data) => {
    const { device_name } = data;

    const contact_data = await get_data.get_contact_data(device_name);

    socket.emit('contact_status', {
      device: device_name,
      contact: contact_data?.contact ?? false,
      tamper: contact_data?.tamper ?? false,
      time: contact_data?.last_seen?.toISOString?.() || null,
      is_active: contact_data?.is_active || false,
    });
  });
  socket.on('disconnect', async () => {
    if (socket.userId) {
      await user.findByIdAndUpdate(socket.userId, { socket_id: null });
    }

    socket.broadcast.emit('user_logged_out');
  });
};
