import 'dart:async';

import 'package:awesom_living/app/di/injection.dart';
import 'package:awesom_living/core/services/auth_session_service.dart';
import 'package:awesom_living/core/services/socket_service/socket_service.dart';
import 'package:awesom_living/features/cp_plus_camera/presentation/controllers/cp_plus_camera_controller.dart';
import 'package:awesom_living/features/dashboard/presentation/cubit/device_listing/dashboard_health_data_cubit.dart';
import 'package:awesom_living/features/device/presentation/cubit/device_listing/device_listing_cubit.dart';
import 'package:awesom_living/features/motion_presence/presentation/controllers/room_presence_controller.dart';
import 'package:awesom_living/features/zigbee/presentation/controllers/door_window_sensor_socket_controller.dart';
import 'package:awesom_living/features/zigbee/presentation/controllers/emergency_button_socket_controller.dart';
import 'package:awesom_living/features/zigbee/presentation/controllers/motion_socket_controller.dart';
import 'package:awesom_living/features/home_listing/data/models/home_listing_response_model.dart';
import 'package:awesom_living/features/home_listing/presentation/cubit/fetch_home/home_listing_cubit.dart';
import 'package:awesom_living/features/home_listing/presentation/cubit/fetch_home/home_listing_state.dart';
import 'package:awesom_living/features/profile/domain/services/user_preferences_service.dart';
import 'package:awesom_living/features/profile/presentation/cubits/get_profile/get_profile_cubit.dart';
import 'package:awesom_living/features/profile/presentation/cubits/get_profile/get_profile_state.dart';
import 'package:awesom_living/features/resident/data/models/resident_listing_response_model.dart';
import 'package:awesom_living/features/resident/presentation/cubit/resident_listing/resident_listing_cubit.dart';
import 'package:awesom_living/features/resident/presentation/cubit/resident_listing/resident_listing_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

/// The app-scoped cubits and controllers the dashboard drives.
///
/// They are provided above the auth flow, so they outlive the dashboard screen
/// and guard their own closed/disposed state. That makes a captured set safe to
/// keep using across `await`s, unlike the [BuildContext] they came from.
class _DashboardDependencies {
  const _DashboardDependencies({
    required this.homes,
    required this.devices,
    required this.residents,
    required this.health,
    required this.profile,
    required this.cameras,
    required this.bathroom_socket,
    required this.emergency_socket,
    required this.door_sensor_socket,
    required this.room_presence,
  });

  final HomeListingCubit homes;
  final DeviceListingCubit devices;
  final ResidentListingCubit residents;
  final DashboardHealthDataCubit health;
  final GetProfileCubit profile;
  final CpPlusCameraController cameras;
  final BathroomSocketController bathroom_socket;
  final EmergencyButtonController emergency_socket;
  final DoorSensorSocketController door_sensor_socket;
  final RoomPresenceController room_presence;

  /// The current [HomeListingSuccessState], or `null` in any other state.
  HomeListingSuccessState? get homeSuccessState {
    final state = homes.state;
    return state is HomeListingSuccessState ? state : null;
  }

  /// The current [ResidentListingSuccessState], or `null` if the cubit is in
  /// any other state (initial, loading, failure).
  ResidentListingSuccessState? get residentSuccessState {
    final state = residents.state;
    return state is ResidentListingSuccessState ? state : null;
  }

  /// The home everything on the dashboard is scoped to, or `''` when the user
  /// has none — in which case the list calls fall back to being unscoped.
  String get selectedHomeId => homeSuccessState?.selectedHomeId ?? '';

  String get activeResidentId => residentSuccessState?.activeResident?.id ?? '';
}

/// Drives the dashboard's home-first load: a home is chosen, its devices and
/// residents follow, and the selected resident's GLK vitals come last.
class DashboardScreenController {
  final BuildContext context;

  DashboardScreenController(this.context);

  /// Resolves every provider this controller needs in one synchronous pass.
  ///
  /// Returns `null` once the dashboard element is gone (logout, tab teardown).
  /// Every sequence below resolves its dependencies up-front and never reads
  /// [context] again: a `context.read` on an unmounted element dereferences a
  /// null widget inside `Provider` and crashes the app.
  _DashboardDependencies? _resolveDependencies() {
    if (!context.mounted) return null;
    return _DashboardDependencies(
      homes: context.read<HomeListingCubit>(),
      devices: context.read<DeviceListingCubit>(),
      residents: context.read<ResidentListingCubit>(),
      health: context.read<DashboardHealthDataCubit>(),
      profile: context.read<GetProfileCubit>(),
      cameras: context.read<CpPlusCameraController>(),
      bathroom_socket: context.read<BathroomSocketController>(),
      emergency_socket: context.read<EmergencyButtonController>(),
      door_sensor_socket: context.read<DoorSensorSocketController>(),
      room_presence: context.read<RoomPresenceController>(),
    );
  }

  UserPreferencesService get _preferences => getIt<UserPreferencesService>();

  // ── Helpers ──────────────────────────────────────────────────────────────

  String todayFormatted() {
    final now = DateTime.now();
    return '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
  }

  // ── Initial Load ──────────────────────────────────────────────────────────

  /// Clears any state left over from a previous session.
  ///
  /// The dashboard-feeding cubits are app-scoped (provided above the auth
  /// flow), so they survive logout/login and would otherwise render the
  /// previous user's data until the new fetches complete. This runs
  /// synchronously before the first `await` in [fetchInitialData], so the
  /// first frame after login shows loading shimmers instead of stale data.
  void _resetStaleSessionState(_DashboardDependencies deps) {
    deps.health.reset();
    deps.profile.reset();
    deps.devices.reset();
    deps.residents.reset();
    deps.homes.reset();
    deps.cameras.reset();
  }

  /// Runs the load sequence the home-first dashboard is specified with:
  /// homes → (devices ‖ residents) → GLK vitals.
  ///
  /// The home and resident to restore come from the user's remembered
  /// selection; when it is absent (first login) or points at a record that no
  /// longer exists, each list falls back to its first entry.
  Future<void> fetchInitialData({
    required VoidCallback onSocketReady,
    required String? selectedFormattedDate,
  }) async {
    final deps = _resolveDependencies();
    if (deps == null) return;

    _resetStaleSessionState(deps);

    final preferences = _preferences;

    await deps.homes.fetchAllHomeListing(
      preferredHomeId: preferences.lastSelectedHomeId,
    );
    final homeId = deps.selectedHomeId;

    // Devices and residents are both home-scoped and independent of each
    // other, so they run together rather than one after the next.
    await Future.wait([
      deps.devices.fetchAllDevice(homeId: homeId),
      deps.residents.fetchAllResident(
        homeId: homeId,
        // An empty string means "no remembered resident": fall back to the
        // backend's is_selected flag, then to the first entry.
        preferredResidentId: preferences.lastSelectedResidentId ?? '',
      ),
    ]);

    final activeResident = deps.residentSuccessState?.activeResident;
    final residentId = activeResident?.id ?? '';
    final userId = activeResident?.creator?.id ?? '';

    // Records what the dashboard actually landed on, so a first-time user's
    // auto-selection survives to the next login. Both calls no-op when the
    // selection already matches, so a normal launch sends no request.
    if (homeId.isNotEmpty) preferences.saveSelectedHome(homeId);
    if (residentId.isNotEmpty) preferences.saveSelectedResident(residentId);

    if (userId.isNotEmpty) {
      final authToken = await getIt<AuthSessionService>().getActiveAuthToken();
      SocketService().connect(userId, authToken: authToken);
    }

    onSocketReady();

    await deps.health.fetchDashboardHealthData(
      residentId: residentId,
      formatedDate: selectedFormattedDate ?? todayFormatted(),
    );

    await deps.profile.getUserProfileData();

    // The profile is the authoritative copy of the selection. Adopting it here
    // keeps the local mirror in step with a change made on another device; it
    // does not re-scope the screen, which has already loaded.
    final profileData = deps.profile.state is GetProfileSuccessState
        ? (deps.profile.state as GetProfileSuccessState).userProfileData.data
        : null;
    await preferences.hydrate(
      homeId: profileData?.lastSelectedHome,
      residentId: profileData?.lastSelectedResident,
    );
  }

  // ── Home Changed ──────────────────────────────────────────────────────────

  /// Applies a home selection: saves the preference, reloads the home's device
  /// and resident lists, and re-scopes the vitals to the new home's first
  /// resident.
  Future<void> onHomeChanged(HomeData home) async {
    final homeId = home.id ?? '';
    if (homeId.isEmpty) return;

    final deps = _resolveDependencies();
    if (deps == null) return;

    deps.homes.selectHome(home);
    // Fire and forget, debounced: a failed save must not hold up — or undo —
    // the selection the user just made.
    _preferences.saveSelectedHome(homeId);

    await Future.wait([
      deps.devices.fetchAllDevice(homeId: homeId),
      // The remembered resident belongs to the previous home, so it is dropped
      // and the new home auto-selects its own first resident.
      deps.residents.fetchAllResident(homeId: homeId, preferredResidentId: ''),
    ]);

    await _reloadResidentScopedData(
      deps,
      residentId: deps.activeResidentId,
      selectedFormattedDate: null,
    );
  }

  // ── Resident Changed ──────────────────────────────────────────────────────

  /// Applies a resident selection.
  ///
  /// Only the GLK vitals change: the device list is home-scoped and stays as
  /// it is, so nothing above the picker is refetched.
  Future<void> onResidentChanged(
    Resident resident, {
    String? selectedFormattedDate,
  }) async {
    final residentId = resident.id ?? '';
    if (residentId.isEmpty) return;

    final deps = _resolveDependencies();
    if (deps == null) return;

    deps.residents.selectResident(resident);
    _preferences.saveSelectedResident(residentId);

    await _reloadResidentScopedData(
      deps,
      residentId: residentId,
      selectedFormattedDate: selectedFormattedDate,
    );
  }

  /// Refetches everything that follows from the selected resident.
  Future<void> _reloadResidentScopedData(
    _DashboardDependencies deps, {
    required String residentId,
    required String? selectedFormattedDate,
  }) async {
    // Not awaited: the CCTV card owns its own loading state, and re-resolving a
    // stream URL should not hold up the vitals.
    unawaited(
      deps.cameras.loadCameras(homeId: deps.selectedHomeId, forceRefresh: true),
    );

    await deps.health.fetchDashboardHealthData(
      residentId: residentId,
      formatedDate: selectedFormattedDate ?? todayFormatted(),
    );
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  /// Pull-to-refresh: replays every call the dashboard is built from, keeping
  /// the home and resident the user is currently on.
  Future<void> refreshDashboard({String? selectedFormattedDate}) async {
    final deps = _resolveDependencies();
    if (deps == null) return;

    await deps.homes.fetchAllHomeListing();
    final homeId = deps.selectedHomeId;

    await Future.wait([
      deps.devices.fetchAllDevice(homeId: homeId),
      deps.residents.fetchAllResident(homeId: homeId),
    ]);

    await _reloadResidentScopedData(
      deps,
      residentId: deps.activeResidentId,
      selectedFormattedDate: selectedFormattedDate,
    );

    await deps.profile.getUserProfileData();

    // Re-request socket snapshots so live cards refresh alongside REST data.
    deps.bathroom_socket.refresh();
    deps.emergency_socket.refresh();
    deps.door_sensor_socket.refresh();
    deps.room_presence.loadRoomState();
  }

  // ── Date Selected ─────────────────────────────────────────────────────────

  Future<String> onDateSelected(DateTime date) async {
    final formatted =
        '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';

    final deps = _resolveDependencies();
    if (deps == null) return formatted;

    await deps.health.fetchDashboardHealthData(
      residentId: deps.activeResidentId,
      formatedDate: formatted,
    );

    return formatted; // caller stores this in _selectedFormattedDate
  }
}
