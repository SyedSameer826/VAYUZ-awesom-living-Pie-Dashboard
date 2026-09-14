# Pi Shutdown / Reboot — App Integration Guide

**Project:** Awesom Living  
**Builder:** VAYUZ Technologies, Noida  
**Date:** September 7, 2026  
**Status:** API ready & tested. App integration pending.  
**Target Build:** Production (`eas build --profile production`)

---

## Overview

The NRI family member can remotely shutdown or reboot the Raspberry Pi hub from the mobile app. The backend API is already built and tested. This document covers everything the Frontend dev needs to integrate the feature into the React Native app.

---

## 1. API Endpoints

**Base URL (Production):** `https://backend-awesomliving.onrender.com`

### Send Command

```
POST /api/hub/command
```

**Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "parent_id": "<parent_id>",
  "command": "shutdown" | "reboot"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Command queued",
  "command": "reboot",
  "expires_at": "2026-09-07T14:35:00.000Z"
}
```

**Error Responses:**
| Status | Body | Meaning |
|--------|------|---------|
| 401 | `{ "error": "Unauthorized" }` | JWT expired or missing |
| 404 | `{ "error": "Hub not found" }` | No hub registered for this parent |
| 409 | `{ "error": "Command already pending" }` | A shutdown/reboot is already queued |
| 500 | `{ "error": "Internal server error" }` | Backend issue |

### Check Hub Status

```
GET /api/hub/status/:parentId
```

**Response (200):**
```json
{
  "online": true,
  "last_heartbeat": "2026-09-07T14:30:12.000Z",
  "pending_command": null,
  "uptime_seconds": 86412
}
```

When a command is pending:
```json
{
  "online": true,
  "last_heartbeat": "2026-09-07T14:30:12.000Z",
  "pending_command": {
    "command": "reboot",
    "queued_at": "2026-09-07T14:30:00.000Z",
    "expires_at": "2026-09-07T14:35:00.000Z"
  },
  "uptime_seconds": 86412
}
```

---

## 2. How It Works (End-to-End Flow)

```
NRI taps "Reboot" in app
    ↓
App calls POST /api/hub/command { command: "reboot" }
    ↓
Backend stores command in DB with 5-minute expiry
    ↓
Pi heartbeat (every 30s) polls GET /api/hub/heartbeat
    ↓
Backend returns pending command in heartbeat response
    ↓
Pi executes: sudo reboot (via sudoers — no password needed)
    ↓
Pi goes offline → comes back online after ~60s
    ↓
App polls /api/hub/status/:parentId to detect Pi is back online
    ↓
App shows success confirmation
```

**Key behaviors:**
- Commands expire after **5 minutes** if the Pi doesn't pick them up (Pi is offline)
- Only **one command** can be pending at a time (409 if duplicate)
- Pi must be **online** for the command to execute (check `online` status before sending)
- After reboot, Pi takes **~60 seconds** to come back online
- After shutdown, Pi stays **offline** until someone physically powers it on

---

## 3. Screen Placement

### Where to Add

Add the shutdown/reboot controls to the **Devices Dashboard** screen or as a new **Hub Settings** section accessible from the **Profile** screen (bottom nav → Profile).

**Recommended:** Profile screen → "Hub Management" section — keeps destructive actions away from the main dashboard.

### Navigation Path

```
Bottom Nav → Profile → Hub Management → Pi Controls
```

### File to Create

```
src/screens/nri/HubManagementScreen.js
```

Register in `AppNavigator.js`:
```javascript
<Stack.Screen 
  name="HubManagement" 
  component={HubManagementScreen}
  options={{ title: 'Hub Management' }}
/>
```

Add navigation link in Profile screen:
```javascript
<TouchableOpacity onPress={() => navigation.navigate('HubManagement')}>
  <Text>Hub Management</Text>
</TouchableOpacity>
```

---

## 4. UI Specification

### Hub Management Screen Layout

```
┌─────────────────────────────────┐
│  ← Hub Management               │
├─────────────────────────────────┤
│                                  │
│  ┌────────────────────────────┐  │
│  │  Hub Status                │  │
│  │  ● Online   (green dot)   │  │
│  │  Last seen: 2 min ago     │  │
│  │  Uptime: 1 day, 0h 7m     │  │
│  └────────────────────────────┘  │
│                                  │
│  ┌────────────────────────────┐  │
│  │  🔄  Reboot Hub            │  │
│  │  Restarts the Pi. Takes    │  │
│  │  about 60 seconds.         │  │
│  │                            │  │
│  │  [ Reboot ]  (blue btn)   │  │
│  └────────────────────────────┘  │
│                                  │
│  ┌────────────────────────────┐  │
│  │  ⏻  Shutdown Hub           │  │
│  │  Turns off the Pi.         │  │
│  │  Requires physical access  │  │
│  │  to power back on.         │  │
│  │                            │  │
│  │  [ Shutdown ]  (red btn)   │  │
│  └────────────────────────────┘  │
│                                  │
└─────────────────────────────────┘
```

### Design Tokens (from Figma system)

| Element | Value |
|---------|-------|
| Card background | `#FFFFFF` |
| Card radius | `20px` |
| Card shadow | `0 2px 10px rgba(124,141,181,0.12)` |
| Card border | `1px solid #f5f5f5` |
| Reboot button | Background `#007AFF`, text `#FFFFFF`, radius `12px` |
| Shutdown button | Background `#EB5757`, text `#FFFFFF`, radius `12px` |
| Online dot | `#34C759` |
| Offline dot | `#EB5757` |
| Font | `Ek Mukta` |
| Section title | Weight `700`, size `16px`, color `#000` |
| Body text | Weight `400`, size `14px`, color `#828282` |

---

## 5. Implementation Steps

### Step 1 — Add API Functions in `apiService.js`

```javascript
// Pi Hub Commands
export const send_hub_command = async (parent_id, command) => {
  const response = await api.post('/api/hub/command', {
    parent_id,
    command,  // "shutdown" or "reboot"
  });
  return response.data;
};

export const get_hub_status = async (parent_id) => {
  const response = await api.get(`/api/hub/status/${parent_id}`);
  return response.data;
};
```

### Step 2 — Create HubManagementScreen.js

```javascript
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, Alert, ActivityIndicator,
  StyleSheet, ScrollView,
} from 'react-native';
import { send_hub_command, get_hub_status } from '../../services/apiService';
import { useAuth } from '../../context/AuthContext';

const HubManagementScreen = () => {
  const { user } = useAuth();
  const parent_id = user?.parent_id;

  const [hub_status, set_hub_status] = useState(null);
  const [loading, set_loading] = useState(true);
  const [command_loading, set_command_loading] = useState(null); // 'reboot' | 'shutdown' | null
  const [waiting_for_reboot, set_waiting_for_reboot] = useState(false);
  const poll_ref = useRef(null);

  // Fetch hub status on mount + every 30s
  useEffect(() => {
    fetch_status();
    const interval = setInterval(fetch_status, 30000);
    return () => {
      clearInterval(interval);
      if (poll_ref.current) clearInterval(poll_ref.current);
    };
  }, []);

  const fetch_status = async () => {
    try {
      const data = await get_hub_status(parent_id);
      set_hub_status(data);
      set_loading(false);

      // If we were waiting for reboot and Pi is back online
      if (waiting_for_reboot && data.online) {
        set_waiting_for_reboot(false);
        if (poll_ref.current) {
          clearInterval(poll_ref.current);
          poll_ref.current = null;
        }
        Alert.alert('Hub Online', 'The Pi has rebooted successfully.');
      }
    } catch (err) {
      set_loading(false);
    }
  };

  const handle_command = (command) => {
    const title = command === 'reboot' ? 'Reboot Hub' : 'Shutdown Hub';
    const message = command === 'reboot'
      ? 'The Pi will restart. All sensors will be offline for about 60 seconds. Continue?'
      : 'The Pi will turn off. You will need physical access to power it back on. Are you sure?';

    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: command === 'reboot' ? 'Reboot' : 'Shutdown',
        style: 'destructive',
        onPress: () => execute_command(command),
      },
    ]);
  };

  const execute_command = async (command) => {
    set_command_loading(command);
    try {
      await send_hub_command(parent_id, command);

      if (command === 'reboot') {
        set_waiting_for_reboot(true);
        // Poll every 10s to detect when Pi comes back
        poll_ref.current = setInterval(fetch_status, 10000);
        Alert.alert('Reboot Sent', 'The Pi is restarting. This screen will update when it comes back online.');
      } else {
        Alert.alert('Shutdown Sent', 'The Pi is shutting down. It will need to be powered on manually.');
      }
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) {
        Alert.alert('Command Pending', 'A command is already queued. Wait for it to complete or expire (5 minutes).');
      } else {
        Alert.alert('Error', 'Could not send command. Check your connection and try again.');
      }
    } finally {
      set_command_loading(null);
    }
  };

  const format_uptime = (seconds) => {
    if (!seconds) return '—';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const format_last_seen = (timestamp) => {
    if (!timestamp) return '—';
    const diff = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  const is_online = hub_status?.online ?? false;
  const has_pending = !!hub_status?.pending_command;

  return (
    <ScrollView style={styles.container}>
      {/* Hub Status Card */}
      <View style={styles.card}>
        <Text style={styles.card_title}>Hub Status</Text>
        <View style={styles.status_row}>
          <View style={[styles.dot, is_online ? styles.dot_online : styles.dot_offline]} />
          <Text style={styles.status_text}>
            {is_online ? 'Online' : 'Offline'}
          </Text>
        </View>
        <Text style={styles.detail_text}>
          Last seen: {format_last_seen(hub_status?.last_heartbeat)}
        </Text>
        <Text style={styles.detail_text}>
          Uptime: {format_uptime(hub_status?.uptime_seconds)}
        </Text>
        {has_pending && (
          <View style={styles.pending_badge}>
            <Text style={styles.pending_text}>
              Pending: {hub_status.pending_command.command}
            </Text>
          </View>
        )}
        {waiting_for_reboot && (
          <View style={styles.reboot_banner}>
            <ActivityIndicator size="small" color="#007AFF" />
            <Text style={styles.reboot_text}>Waiting for Pi to come back online...</Text>
          </View>
        )}
      </View>

      {/* Reboot Card */}
      <View style={styles.card}>
        <Text style={styles.card_title}>Reboot Hub</Text>
        <Text style={styles.detail_text}>
          Restarts the Pi. All sensors will reconnect automatically. Takes about 60 seconds.
        </Text>
        <TouchableOpacity
          style={[styles.btn_reboot, (!is_online || has_pending) && styles.btn_disabled]}
          onPress={() => handle_command('reboot')}
          disabled={!is_online || has_pending || command_loading !== null}
        >
          {command_loading === 'reboot' ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.btn_text}>Reboot</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Shutdown Card */}
      <View style={styles.card}>
        <Text style={styles.card_title}>Shutdown Hub</Text>
        <Text style={styles.detail_text}>
          Turns off the Pi completely. Someone at the home will need to physically unplug and replug the power cable to turn it back on.
        </Text>
        <TouchableOpacity
          style={[styles.btn_shutdown, (!is_online || has_pending) && styles.btn_disabled]}
          onPress={() => handle_command('shutdown')}
          disabled={!is_online || has_pending || command_loading !== null}
        >
          {command_loading === 'shutdown' ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <Text style={styles.btn_text}>Shutdown</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9F9F9',
    padding: 16,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#F5F5F5',
    shadowColor: '#7C8DB5',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 3,
  },
  card_title: {
    fontFamily: 'EkMukta-Bold',
    fontSize: 16,
    color: '#000',
    marginBottom: 8,
  },
  status_row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  dot_online: { backgroundColor: '#34C759' },
  dot_offline: { backgroundColor: '#EB5757' },
  status_text: {
    fontFamily: 'EkMukta-SemiBold',
    fontSize: 15,
    color: '#000',
  },
  detail_text: {
    fontFamily: 'EkMukta-Regular',
    fontSize: 14,
    color: '#828282',
    marginBottom: 4,
  },
  pending_badge: {
    marginTop: 8,
    backgroundColor: '#FFF3E0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  pending_text: {
    fontFamily: 'EkMukta-SemiBold',
    fontSize: 13,
    color: '#E65100',
  },
  reboot_banner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    backgroundColor: '#EBF8FF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reboot_text: {
    fontFamily: 'EkMukta-Regular',
    fontSize: 13,
    color: '#2B6CB0',
    marginLeft: 8,
  },
  btn_reboot: {
    marginTop: 12,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btn_shutdown: {
    marginTop: 12,
    backgroundColor: '#EB5757',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btn_disabled: {
    opacity: 0.4,
  },
  btn_text: {
    fontFamily: 'EkMukta-Bold',
    fontSize: 16,
    color: '#FFFFFF',
  },
});

export default HubManagementScreen;
```

### Step 3 — Register the Screen in AppNavigator.js

```javascript
import HubManagementScreen from '../screens/nri/HubManagementScreen';

// Inside your Stack.Navigator:
<Stack.Screen
  name="HubManagement"
  component={HubManagementScreen}
  options={{ title: 'Hub Management' }}
/>
```

### Step 4 — Add Navigation Link in Profile Screen

```javascript
<TouchableOpacity
  style={styles.menu_item}
  onPress={() => navigation.navigate('HubManagement')}
>
  <Text style={styles.menu_text}>Hub Management</Text>
  <Text style={styles.menu_arrow}>›</Text>
</TouchableOpacity>
```

---

## 6. Edge Cases & Error Handling

| Scenario | App Behavior |
|----------|-------------|
| Pi is offline | Buttons disabled (greyed out). Status shows "Offline" with red dot. |
| Command already pending | Show Alert: "A command is already queued. Wait for it to complete or expire (5 minutes)." |
| Network error | Show Alert: "Could not send command. Check your connection and try again." |
| After reboot sent | Show "Waiting for Pi to come back online..." banner with spinner. Poll every 10s. |
| Pi comes back online | Dismiss spinner, show success Alert. |
| After shutdown sent | Show info Alert. Status will switch to "Offline". No auto-recovery polling. |
| Command expires (5 min) | `pending_command` becomes `null` on next status poll. Buttons re-enable. |
| JWT expired | 401 triggers AuthContext logout flow (already handled globally in apiService). |

---

## 7. Confirmation Dialogs (Required)

Both actions need a confirmation dialog before executing. These are **destructive operations** — no undo.

**Reboot confirmation:**
> **Reboot Hub**  
> The Pi will restart. All sensors will be offline for about 60 seconds. Continue?  
> [Cancel]  [Reboot]

**Shutdown confirmation:**
> **Shutdown Hub**  
> The Pi will turn off. You will need physical access to power it back on. Are you sure?  
> [Cancel]  [Shutdown]

---

## 8. Testing Checklist

Use the **production build** (`eas build --profile production`).

| # | Test Case | Expected Result |
|---|-----------|-----------------|
| 1 | Open Hub Management when Pi is online | Green dot, "Online", uptime shown |
| 2 | Open Hub Management when Pi is offline | Red dot, "Offline", buttons disabled |
| 3 | Tap Reboot → Cancel | No API call, nothing happens |
| 4 | Tap Reboot → Confirm | API call, "Waiting..." banner appears, Pi restarts |
| 5 | Wait ~60s after reboot | Pi comes back online, success Alert shown |
| 6 | Tap Shutdown → Confirm | API call, Pi goes offline, status updates to Offline |
| 7 | Tap Reboot while command pending | 409 handled, Alert shown |
| 8 | Send command with no network | Error Alert shown |
| 9 | Command expires (wait 5 min without Pi picking up) | pending_command clears, buttons re-enable |
| 10 | JWT expired mid-session | Global auth handler logs user out |

### Test Credentials

```
Email:    arjun@awesomliving.com
Password: pilot2026
Pi SSH:   ssh pi@192.168.1.14 (password: raspberry)
Backend:  https://backend-awesomliving.onrender.com
```

---

## 9. Security Notes

- Pi executes shutdown/reboot via `sudoers` config — no password prompt needed
- Commands are **authenticated** (JWT required) and **scoped to parent_id**
- Commands **expire after 5 minutes** — stale commands are never executed
- Only **one pending command** at a time — prevents accidental double-sends
- Shutdown is irreversible remotely — warn the user clearly in the confirmation dialog

---

## 10. Files to Create / Modify

| Action | File | What to Do |
|--------|------|------------|
| **Create** | `src/screens/nri/HubManagementScreen.js` | New screen (code in Step 2 above) |
| **Modify** | `src/services/apiService.js` | Add `send_hub_command` and `get_hub_status` functions |
| **Modify** | `src/navigation/AppNavigator.js` | Register `HubManagement` screen |
| **Modify** | Profile screen (wherever it lives) | Add "Hub Management" navigation link |

---

*Awesom Living | VAYUZ Technologies, Noida | September 2026*
