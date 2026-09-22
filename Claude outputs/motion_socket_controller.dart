import 'package:awesom_living/core/services/socket_service/features/motion_sensor_socket_methods.dart';
import 'package:awesom_living/core/services/socket_service/features/zigbee_device_socket_methods.dart';
import 'package:awesom_living/core/services/socket_service/socket_service.dart';
import 'package:awesom_living/features/zigbee/domain/motion_sensor_response_model.dart';
import 'package:awesom_living/features/zigbee/domain/zigbee_device_event_model.dart';
import 'package:flutter/material.dart';

/// Represents the lifecycle of socket data for the motion sensor.
enum BathroomDataState {
  /// [init] has not been called yet.
  idle,

  /// Socket connected, request sent — waiting for first server response.
  awaiting,

  /// At least one payload has been received and is ready to display.
  active,

  /// Socket could not connect or the connection was lost.
  disconnected,
}

class BathroomSocketController extends ChangeNotifier {
  late final MotionSensorSocketMethods _motionSocket;
  late final ZigbeeDeviceSocketMethods _zigbeeSocket;

  BathroomSocketController() {
    final socketService = SocketService();
    _motionSocket = MotionSensorSocketMethods(socketService);
    _zigbeeSocket = ZigbeeDeviceSocketMethods(socketService);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────

  BathroomDataState dataState = BathroomDataState.idle;

  bool get isConnected => dataState != BathroomDataState.disconnected;

  /// The freshest data available — prefers realtime, falls back to initial.
  BathroomData? get currentData => realtimeData ?? initialData;

  BathroomData? initialData;
  BathroomData? realtimeData;
  ZigbeeEvent? lastZigbeeEvent;

  bool _isInitialized = false;
  String? _deviceName;

  // ─────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────

  /// Initialises listeners and requests the first data snapshot.
  ///
  /// [deviceName] is the Zigbee device identifier (e.g. `"motion_sensor_1"`).
  ///
  /// Does NOT call [SocketService.connect] — the socket is connected once
  /// by [DashboardScreen] after the userId is known from the API.
  /// Safe to call multiple times — subsequent calls are no-ops.
  void init({required String deviceName}) {
    if (_isInitialized) return;
    _isInitialized = true;
    _deviceName = deviceName;

    // Register listeners first — socket.io buffers these safely before
    // the handshake completes, so no events will be missed.
    _motionSocket.listenInitial((data) {
      initialData = data;
      dataState = BathroomDataState.active;
      notifyListeners();
    });

    _motionSocket.listenRealtime((data) {
      realtimeData = data;
      dataState = BathroomDataState.active;
      notifyListeners();
    });

    _zigbeeSocket.listenRealtime((event) {
      lastZigbeeEvent = event;
      _handleZigbee(event);
      notifyListeners();
    });

    // Re-request snapshot after a socket reconnect so data stays fresh.
    // Uses the shared listener list (not the single onReconnected slot) so
    // other socket controllers can't clobber this hook.
    SocketService().addConnectionListener(_onReconnected);

    _requestSnapshot();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REFRESH — manual pull-to-refresh
  // ─────────────────────────────────────────────────────────────────────────

  /// Re-requests the current status snapshot.
  /// Only flips back to [BathroomDataState.awaiting] if no data yet —
  /// avoids clearing a live card on manual refresh.
  void refresh() {
    if (_deviceName == null) return;
    if (dataState != BathroomDataState.active) {
      dataState = BathroomDataState.awaiting;
      notifyListeners();
    }
    _motionSocket.requestStatus(_deviceName!);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DISPOSE
  // ─────────────────────────────────────────────────────────────────────────

  void disposeSocket() {
    _motionSocket.removeListeners();
    _zigbeeSocket.removeListeners();
    SocketService().removeConnectionListener(_onReconnected);
    _isInitialized = false;
    _deviceName = null;
    dataState = BathroomDataState.idle;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ─────────────────────────────────────────────────────────────────────────

  void _requestSnapshot() {
    if (_deviceName == null) return;

    if (SocketService().isConnected) {
      dataState = BathroomDataState.awaiting;
      notifyListeners();
      _motionSocket.requestStatus(_deviceName!);
    } else {
      dataState = BathroomDataState.disconnected;
      notifyListeners();
    }
  }

  void _onReconnected() {
    // Socket came back — re-request so data is not stale.
    _requestSnapshot();
  }

  void _handleZigbee(ZigbeeEvent event) {
    if (event.device == 'switch_1') {
      switch (event.action) {
        case 'single':
          debugPrint('Single Press');
          break;
        case 'double':
          debugPrint('Double Press');
          break;
        case 'long':
          debugPrint('Long Press');
          break;
      }
    }

    if (event.device == 'motion_sensor_1') {
      debugPrint('Motion: ${event.occupancy}');
    }
  }
}
