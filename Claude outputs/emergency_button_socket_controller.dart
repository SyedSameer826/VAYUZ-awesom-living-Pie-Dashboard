import 'dart:async';

import 'package:awesom_living/core/design_system/extensions/app_semantic_colors.dart';
import 'package:awesom_living/core/design_system/extensions/theme_context_extensions.dart';
import 'package:awesom_living/core/services/socket_service/features/emergency_button_socket_methods.dart';
import 'package:awesom_living/core/services/socket_service/models/switch_socket_event_model.dart';
import 'package:awesom_living/core/services/socket_service/socket_service.dart';
import 'package:awesom_living/core/services/sound/alert_sound_service.dart';
import 'package:awesom_living/features/zigbee/presentation/utils/event_time_format.dart';
import 'package:flutter/material.dart';

// ─────────────────────────────────────────────────────────────────────────────
// PRESS TYPE
// ─────────────────────────────────────────────────────────────────────────────

enum EmergencyPressType { single, doubleTap, hold }

extension EmergencyPressTypeX on EmergencyPressType {
  String get label {
    switch (this) {
      case EmergencyPressType.single:
        return 'Alert sent';
      case EmergencyPressType.doubleTap:
        return 'SOS activated';
      case EmergencyPressType.hold:
        return 'Emergency call triggered';
    }
  }

  String get subtitle {
    switch (this) {
      case EmergencyPressType.single:
        return 'Caregiver has been notified.';
      case EmergencyPressType.doubleTap:
        return 'Emergency team alerted immediately.';
      case EmergencyPressType.hold:
        return 'Emergency services are being contacted.';
    }
  }

  /// Press-type accent resolved from the active theme.
  Color color(BuildContext context) {
    switch (this) {
      case EmergencyPressType.single:
        return context.semanticColors.warning;
      case EmergencyPressType.doubleTap:
        return context.colorScheme.error;
      case EmergencyPressType.hold:
        // The escalation tier has no semantic token; purple keeps it visually
        // distinct from the SOS red and is brightened for dark backgrounds.
        return context.theme.brightness == Brightness.dark
            ? const Color(0xFFCE93D8)
            : const Color(0xFF7B1FA2);
    }
  }

  IconData get icon {
    switch (this) {
      case EmergencyPressType.single:
        return Icons.notifications_active_rounded;
      case EmergencyPressType.doubleTap:
        return Icons.warning_amber_rounded;
      case EmergencyPressType.hold:
        return Icons.local_hospital_rounded;
    }
  }

  /// Tone played when the press arrives live.
  ///
  /// A single press only notifies the caregiver, so it gets the normal tone.
  /// Both the double press (SOS) and the hold (emergency call) escalate to
  /// emergency services, so both get the urgent one.
  AlertTone get tone {
    switch (this) {
      case EmergencyPressType.single:
        return AlertTone.normal;
      case EmergencyPressType.doubleTap:
      case EmergencyPressType.hold:
        return AlertTone.emergency;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

class EmergencyButtonController extends ChangeNotifier {
  late final EmergencyButtonSocketMethods _emergencySocket;

  final AlertSoundService _sounds = AlertSoundService();

  EmergencyButtonController() {
    _emergencySocket = EmergencyButtonSocketMethods(SocketService());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────

  bool _isInitialized = false;
  String? _deviceName;

  /// Identifies the last press that sounded, so one physical press produces one
  /// tone no matter how many times the server re-delivers the event.
  String? _sonifiedPressKey;

  String? lastAction;
  DateTime? lastTime;
  EmergencyPressType? lastPressType;
  bool isAlertActive = false;

  /// Server-side press total for the current month, or `null` before any event
  /// has carried it.
  int? clickCountThisMonth;

  // ─────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────

  /// Initialises listeners and requests the last button-press snapshot.
  ///
  /// [deviceName] is the Zigbee device identifier (e.g. `"switch_1"`).
  ///
  /// Does NOT call [SocketService.connect] — the socket is connected once
  /// by [DashboardScreen] after the userId is known from the API.
  /// Safe to call multiple times — subsequent calls are no-ops.
  void init({required String deviceName}) {
    if (_isInitialized) return;
    _isInitialized = true;
    _deviceName = deviceName;

    _emergencySocket.listenInitial((event) {
      _applyEvent(event);
      notifyListeners();
    });

    _emergencySocket.listenRealtime((event) {
      _applyEvent(event);
      isAlertActive = true;
      _playToneOnce(event);
      notifyListeners();
    });

    // Re-request snapshot after a socket reconnect so last state is restored.
    // Uses the shared listener list (not the single onReconnected slot) so
    // other socket controllers can't clobber this hook.
    SocketService().addConnectionListener(_onReconnected);

    _requestSnapshot();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REFRESH — manual pull-to-refresh
  // ─────────────────────────────────────────────────────────────────────────

  /// Re-requests the current snapshot from the server.
  void refresh() {
    _requestSnapshot();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DISMISS ALERT
  // Hides the banner only — lastPressType is preserved so the
  // card keeps showing the last alert colour/state.
  // ─────────────────────────────────────────────────────────────────────────

  void dismissAlert() {
    isAlertActive = false;
    unawaited(_sounds.stop());
    notifyListeners();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RESET STATE
  // Full reset — hides the banner AND clears lastPressType so the card
  // returns to its default standby appearance.
  // Called by the banner's dismiss (✕) button.
  // ─────────────────────────────────────────────────────────────────────────

  void resetState() {
    isAlertActive = false;
    lastPressType = null;
    lastAction = null;
    // The emergency tone runs for seconds; closing the banner must silence it.
    // _sonifiedPressKey is deliberately kept so a re-delivered event for the
    // press the user just dismissed cannot start the tone again.
    unawaited(_sounds.stop());
    notifyListeners();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DISPOSE
  // ─────────────────────────────────────────────────────────────────────────

  void disposeSocket() {
    _emergencySocket.removeListeners();
    SocketService().removeConnectionListener(_onReconnected);
    _isInitialized = false;
    _deviceName = null;
    _sonifiedPressKey = null;
    clickCountThisMonth = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ─────────────────────────────────────────────────────────────────────────

  void _requestSnapshot() {
    if (_deviceName == null) return;

    if (SocketService().isConnected) {
      _emergencySocket.requestStatus(_deviceName!);
    }
    // If not connected, onReconnected will trigger _requestSnapshot again
    // once the socket handshake completes.
  }

  void _onReconnected() {
    _requestSnapshot();
  }

  /// Copies the fields shared by the snapshot and realtime events into state.
  ///
  /// [clickCountThisMonth] is only overwritten when the event carries it, so a
  /// payload that omits the field leaves the last known total on screen rather
  /// than blanking it.
  void _applyEvent(SwitchSocketEventModel event) {
    lastAction = event.action;
    lastTime = event.time;
    lastPressType = _parsePressType(event.action);
    if (event.clickCountThisMonth != null) {
      clickCountThisMonth = event.clickCountThisMonth;
    }
  }

  /// Sounds the press tone at most once per physical press.
  ///
  /// `switch_update` can be re-delivered for a press that already sounded — a
  /// socket reconnect re-attaches the listener, and `SocketService.on` appends
  /// handlers rather than replacing them. Keying on the press itself, rather
  /// than on a time window, makes a repeat delivery silent however late it
  /// arrives.
  ///
  /// `listenInitial` never calls this: it replays the last press on every
  /// dashboard open, which must stay silent.
  void _playToneOnce(SwitchSocketEventModel event) {
    final tone = _parsePressType(event.action)?.tone;
    if (tone == null) return;

    final key =
        '${event.device}|${event.action}|${event.time?.toIso8601String()}';
    if (key == _sonifiedPressKey) return;
    _sonifiedPressKey = key;

    unawaited(_sounds.play(tone));
  }

  EmergencyPressType? _parsePressType(String? action) {
    switch (action) {
      case 'single':
        return EmergencyPressType.single;
      case 'double':
        return EmergencyPressType.doubleTap;
      case 'hold':
      case 'long':
        return EmergencyPressType.hold;
      default:
        return null;
    }
  }

  String get formattedLastTime {
    final time = lastTime;
    return time == null ? kNoEventTimeLabel : formatEventTime(time);
  }
}
