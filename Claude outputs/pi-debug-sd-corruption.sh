#!/bin/bash
# ============================================================================
# pi-debug-sd-corruption.sh — Deep diagnostic for SD corruption on Pi
# Run via SSH while Pi is still up: bash pi-debug-sd-corruption.sh
# Saves full report to ~/sd-debug-report.txt
# ============================================================================

REPORT="$HOME/sd-debug-report.txt"
echo "=== SD Corruption Debug Report ===" > "$REPORT"
echo "Date: $(date)" >> "$REPORT"
echo "Uptime: $(uptime)" >> "$REPORT"
echo "" >> "$REPORT"

section() { echo ""; echo "━━━ $1 ━━━"; echo "" >> "$REPORT"; echo "━━━ $1 ━━━" >> "$REPORT"; }

# ── 1. Pi model + kernel version ──
section "1. HARDWARE & OS"
cat /proc/cpuinfo | grep -E "^(Hardware|Revision|Model)" | tee -a "$REPORT"
uname -a | tee -a "$REPORT"
cat /etc/os-release | grep PRETTY_NAME | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 2. Power supply / under-voltage history ──
section "2. POWER SUPPLY STATUS"
echo "Current throttle state:" | tee -a "$REPORT"
vcgencmd get_throttled 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Decode:" | tee -a "$REPORT"
THROTTLED=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)
if [ "$THROTTLED" = "0x0" ]; then
  echo "  ALL CLEAR - no power issues detected" | tee -a "$REPORT"
else
  # Bit decode
  T=$((THROTTLED))
  [ $((T & 0x1)) -ne 0 ]     && echo "  BIT 0: Under-voltage RIGHT NOW" | tee -a "$REPORT"
  [ $((T & 0x2)) -ne 0 ]     && echo "  BIT 1: ARM frequency capped RIGHT NOW" | tee -a "$REPORT"
  [ $((T & 0x4)) -ne 0 ]     && echo "  BIT 2: Currently throttled" | tee -a "$REPORT"
  [ $((T & 0x8)) -ne 0 ]     && echo "  BIT 3: Soft temp limit active" | tee -a "$REPORT"
  [ $((T & 0x10000)) -ne 0 ] && echo "  BIT 16: Under-voltage HAS OCCURRED since boot" | tee -a "$REPORT"
  [ $((T & 0x20000)) -ne 0 ] && echo "  BIT 17: ARM freq cap HAS OCCURRED since boot" | tee -a "$REPORT"
  [ $((T & 0x40000)) -ne 0 ] && echo "  BIT 18: Throttling HAS OCCURRED since boot" | tee -a "$REPORT"
  [ $((T & 0x80000)) -ne 0 ] && echo "  BIT 19: Soft temp limit HAS OCCURRED since boot" | tee -a "$REPORT"
fi
echo "" | tee -a "$REPORT"
echo "Voltage now:" | tee -a "$REPORT"
vcgencmd measure_volts core 2>/dev/null | tee -a "$REPORT"
echo "Temperature:" | tee -a "$REPORT"
vcgencmd measure_temp 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 3. WiFi driver / firmware state ──
section "3. WIFI DRIVER STATE"
echo "WiFi interface:" | tee -a "$REPORT"
iw dev wlan0 info 2>/dev/null | tee -a "$REPORT" || echo "  wlan0 not found" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "WiFi power management:" | tee -a "$REPORT"
iwconfig wlan0 2>/dev/null | grep -i "power" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "WiFi link quality:" | tee -a "$REPORT"
iwconfig wlan0 2>/dev/null | grep -E "Signal|Bit Rate|Link" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "brcmfmac driver info:" | tee -a "$REPORT"
modinfo brcmfmac 2>/dev/null | grep -E "^(version|filename|description)" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 4. CRITICAL: brcmfmac errors in kernel log ──
section "4. BRCMFMAC / WIFI KERNEL ERRORS (dmesg)"
echo "--- brcmfmac errors ---" | tee -a "$REPORT"
dmesg | grep -iE "brcmf|brcmfmac|firmware.*(halt|crash)|sdio.*(error|fail|timeout)" | tail -50 | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "--- kernel oops/panic/bug ---" | tee -a "$REPORT"
dmesg | grep -iE "oops|panic|bug:|call trace|null pointer|kernel fault|segfault" | tail -20 | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 5. CRITICAL: Previous boot kernel logs (if journald has them) ──
section "5. PREVIOUS BOOT LOGS (journalctl -b -1)"
echo "--- brcmfmac/mmc from previous boot ---" | tee -a "$REPORT"
journalctl -b -1 -k --no-pager 2>/dev/null | grep -iE "brcmf|mmc|sdio|panic|oops|bug:|call trace|corrupt|read.only|ext4.*error" | tail -50 | tee -a "$REPORT"
if [ $? -ne 0 ]; then
  echo "  (Previous boot logs not available - journald may not persist across reboots)" | tee -a "$REPORT"
fi
echo "" | tee -a "$REPORT"

# ── 6. SD card / filesystem health ──
section "6. SD CARD & FILESYSTEM"
echo "SD card device:" | tee -a "$REPORT"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,STATE 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Filesystem mount options:" | tee -a "$REPORT"
mount | grep -E "^/dev/mmc" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Filesystem errors (ext4):" | tee -a "$REPORT"
dmesg | grep -iE "ext4.*(error|warning|corrupt|read.only|abort|remount)" | tail -20 | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Disk I/O errors:" | tee -a "$REPORT"
dmesg | grep -iE "mmc0.*error|mmcblk0.*error|I/O error|blk_update_request" | tail -20 | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "SD card CID (manufacturer info):" | tee -a "$REPORT"
cat /sys/block/mmcblk0/device/cid 2>/dev/null | tee -a "$REPORT"
cat /sys/block/mmcblk0/device/name 2>/dev/null | tee -a "$REPORT"
cat /sys/block/mmcblk0/device/manfid 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Filesystem usage:" | tee -a "$REPORT"
df -h / /boot /boot/firmware 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 7. MMC controller state ──
section "7. MMC CONTROLLERS (SD card vs WiFi SDIO)"
echo "MMC devices:" | tee -a "$REPORT"
ls -la /sys/bus/mmc/devices/ 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
for d in /sys/bus/mmc/devices/mmc*; do
  if [ -d "$d" ]; then
    echo "Device: $(basename $d)" | tee -a "$REPORT"
    echo "  Type: $(cat $d/type 2>/dev/null)" | tee -a "$REPORT"
    echo "  Name: $(cat $d/name 2>/dev/null)" | tee -a "$REPORT"
    echo "  Driver: $(basename $(readlink $d/driver 2>/dev/null) 2>/dev/null)" | tee -a "$REPORT"
  fi
done
echo "" | tee -a "$REPORT"

# ── 8. kernel panic settings ──
section "8. KERNEL PANIC / OOPS SETTINGS"
echo "panic_on_oops: $(cat /proc/sys/kernel/panic_on_oops)" | tee -a "$REPORT"
echo "panic (reboot delay): $(cat /proc/sys/kernel/panic)" | tee -a "$REPORT"
echo "hung_task_panic: $(cat /proc/sys/kernel/hung_task_panic 2>/dev/null || echo 'N/A')" | tee -a "$REPORT"
echo "softlockup_panic: $(cat /proc/sys/kernel/softlockup_panic 2>/dev/null || echo 'N/A')" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 9. Journald persistence check ──
section "9. JOURNALD CONFIG"
echo "Storage setting:" | tee -a "$REPORT"
grep -E "^Storage" /etc/systemd/journald.conf 2>/dev/null | tee -a "$REPORT" || echo "  (default - volatile on Pi)" | tee -a "$REPORT"
echo "Journal on disk:" | tee -a "$REPORT"
ls -la /var/log/journal/ 2>/dev/null | tee -a "$REPORT" || echo "  /var/log/journal/ does not exist (volatile journal)" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 10. Write amplification / swap / tmpfs ──
section "10. WRITE PRESSURE ON SD CARD"
echo "Swap:" | tee -a "$REPORT"
swapon --show 2>/dev/null | tee -a "$REPORT"
free -h | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "tmpfs mounts:" | tee -a "$REPORT"
mount | grep tmpfs | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Disk write stats since boot (mmcblk0):" | tee -a "$REPORT"
cat /sys/block/mmcblk0/stat 2>/dev/null | tee -a "$REPORT"
# field 7 = sectors written, field 10 = time in ms doing I/O
echo "  (fields: reads_completed reads_merged sectors_read ms_reading writes_completed writes_merged sectors_written ms_writing ios_in_progress ms_io weighted_ms_io)" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Top write-heavy processes (if iotop available):" | tee -a "$REPORT"
which iotop &>/dev/null && sudo iotop -bo -n 3 -d 2 2>/dev/null | head -30 | tee -a "$REPORT" || echo "  iotop not installed (apt-get install iotop)" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 11. NetworkManager / wpa_supplicant state ──
section "11. NETWORK MANAGER STATE"
echo "NM status:" | tee -a "$REPORT"
nmcli general status 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "NM connections:" | tee -a "$REPORT"
nmcli -t con show --active 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Recent NM events:" | tee -a "$REPORT"
journalctl -u NetworkManager --no-pager -n 30 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 12. Watchdog status ──
section "12. WATCHDOG"
echo "Watchdog device:" | tee -a "$REPORT"
ls -la /dev/watchdog* 2>/dev/null | tee -a "$REPORT" || echo "  No watchdog device" | tee -a "$REPORT"
echo "Watchdog service:" | tee -a "$REPORT"
systemctl is-active watchdog 2>/dev/null | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

# ── 13. Recent reboots / crash evidence ──
section "13. REBOOT HISTORY"
echo "Last 10 boots:" | tee -a "$REPORT"
last reboot | head -10 | tee -a "$REPORT"
echo "" | tee -a "$REPORT"
echo "Boot count (journalctl):" | tee -a "$REPORT"
journalctl --list-boots 2>/dev/null | tee -a "$REPORT" || echo "  (not available)" | tee -a "$REPORT"
echo "" | tee -a "$REPORT"

echo "━━━ END OF REPORT ━━━" | tee -a "$REPORT"
echo ""
echo "Full report saved to: $REPORT"
echo "To share: cat $REPORT"
