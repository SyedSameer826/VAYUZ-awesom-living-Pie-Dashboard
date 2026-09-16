#!/bin/bash
# Fix: Remove Resident dropdown from all forms EXCEPT GLK pairing
# GLK keeps Resident since it's a per-resident medical device
set -e

REPO="/home/pi/VAYUZ-awesom-living-Pie-Dashboard"
cd "$REPO"

echo "=== Fixing DeviceForm.jsx ==="
python3 -c "
import re
with open('frontend/src/pages/devices/DeviceForm.jsx', 'r') as f:
    content = f.read()
# Remove residents prop if present
content = content.replace('  residents,\n', '')
# Remove Resident dropdown
content = re.sub(r'\s*<label className=\"form-field\">\s*<span>Resident</span>.*?</label>', '', content, flags=re.DOTALL)
with open('frontend/src/pages/devices/DeviceForm.jsx', 'w') as f:
    f.write(content)
print('  DeviceForm.jsx - removed Resident dropdown')
"

echo "=== Fixing BpPairModal.jsx ==="
python3 -c "
import re
with open('frontend/src/pages/devices/BpPairModal.jsx', 'r') as f:
    content = f.read()

# Remove residents prop
content = content.replace('  residents,\n', '')

# Replace form state - no resident needed
content = content.replace(
    '  const [form, setForm] = useState({\n    resident: \"\",\n  });',
    '')

# Fix canPair - remove resident requirement
content = content.replace(
    'const canPair = selected && form.resident;',
    'const canPair = !!selected;'
)

# Remove resident from submit payload
content = content.replace('      resident: form.resident,\n', '')

# Remove the Resident dropdown block
content = re.sub(
    r'\s*{/\* 2\) Resident.*?</label>',
    '',
    content,
    flags=re.DOTALL
)

# Remove change handler since form is gone
content = content.replace(
    '  const change = (e) =>\n    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));',
    '')

# Fix instruction step 2
content = content.replace(
    'Select the device and choose a <b>Resident</b>.',
    'Select the device from the list below.'
)

with open('frontend/src/pages/devices/BpPairModal.jsx', 'w') as f:
    f.write(content)
print('  BpPairModal.jsx - removed Resident dropdown')
"

echo "=== Fixing CameraForm.jsx ==="
python3 -c "
import re
with open('frontend/src/pages/devices/CameraForm.jsx', 'r') as f:
    content = f.read()

# Remove the Resident dropdown block
content = re.sub(
    r'\s*<label className=\"form-field\">\s*<span>Resident</span>\s*<select name=\"resident\".*?</select>\s*</label>',
    '',
    content,
    flags=re.DOTALL
)

with open('frontend/src/pages/devices/CameraForm.jsx', 'w') as f:
    f.write(content)
print('  CameraForm.jsx - removed Resident dropdown')
"

echo "=== Fixing device constants ==="
sed -i '/^  resident: "",$/d' frontend/src/constants/device.js
echo "  device.js - removed resident from emptyDeviceForm"

echo "=== Fixing index.jsx ==="
python3 -c "
with open('frontend/src/pages/devices/index.jsx', 'r') as f:
    content = f.read()

# Remove resident from device edit form population
content = content.replace('      resident: device.resident || \"\",\n', '')

# Remove resident from handleSave (device form)
content = content.replace('          resident: form.resident,\n', '')

# Remove resident validation in handleSaveCamera
content = content.replace('    if (!cameraForm.resident) {\n      setError(\"Resident is required\");\n      return;\n    }\n\n', '')

# Remove resident from camera save payload
content = content.replace('        resident: cameraForm.resident,\n', '')

# Remove resident from camera form inits (openEditForm camera path + mapDiscoveredCamera)
# These set resident: '' in camera form objects
lines = content.split('\n')
new_lines = []
skip_count = 0
for line in lines:
    if skip_count > 0:
        skip_count -= 1
        continue
    # Only remove resident: '' lines inside camera form objects (not GLK)
    stripped = line.strip()
    if stripped == 'resident: \"\",' and 'setCameraForm' in '\n'.join(new_lines[-5:]):
        continue
    new_lines.append(line)
content = '\n'.join(new_lines)

# Remove residents prop from BpPairModal only (keep it for GlkPairModal)
# BpPairModal is the second occurrence of residents={residents}
# Find both occurrences and remove only the one inside BpPairModal block
import re
# Find BpPairModal block and remove residents prop from it
content = re.sub(
    r'(<BpPairModal\n(?:\s+\w+=\{[^}]*\}\n)*)\s+residents=\{residents\}\n',
    r'\1',
    content
)

with open('frontend/src/pages/devices/index.jsx', 'w') as f:
    f.write(content)
print('  index.jsx - removed resident from device/camera/BP forms (kept for GLK)')
"

echo "=== Fixing deviceService.js ==="
python3 -c "
with open('frontend/src/services/deviceService.js', 'r') as f:
    content = f.read()

# Remove resident from assignDeviceName only
content = content.replace('  resident,\n  home_id,', '  home_id,')
content = content.replace('    resident,\n    home_id,', '    home_id,')

# Remove resident from pairBp only (keep it in pairGlk)
content = content.replace(
    'export const pairBp = async ({ address, name, resident }) => {',
    'export const pairBp = async ({ address, name }) => {')
content = content.replace(
    '    body: JSON.stringify({ address, name, resident }),',
    '    body: JSON.stringify({ address, name }),')

with open('frontend/src/services/deviceService.js', 'w') as f:
    f.write(content)
print('  deviceService.js - removed resident from device/BP calls (kept for GLK)')
"

echo "=== Fixing backend server.js ==="
python3 -c "
with open('backend/server.js', 'r') as f:
    content = f.read()

# BP pair only - remove resident from required validation
# Keep GLK pair validation as-is (resident still required for GLK)
content = content.replace(
    'if (!address || !resident) {\n      return res.status(400).json({\n        error: \"address and resident are required\",\n      });',
    'if (!address) {\n      return res.status(400).json({\n        error: \"address is required\",\n      });'
)

with open('backend/server.js', 'w') as f:
    f.write(content)
print('  server.js - removed resident requirement from BP pair (kept for GLK)')
"

echo "=== Skipping GlkPairModal.jsx (Resident stays) ==="

echo ""
echo "=== Rebuilding frontend ==="
cd frontend
npx vite build
echo ""
echo "=== Restarting dashboard ==="
pm2 restart pi-dashboard
echo ""
echo "=== DONE! ==="
echo "Resident dropdown removed from: DeviceForm, CameraForm, BpPairModal"
echo "Resident dropdown KEPT in: GlkPairModal"
