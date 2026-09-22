// Reset room_occupancy_states to clean vacant state for testing.
//
// Run inside the QA backend container:
//   docker exec -i awesomeliving-qa-backend node < reset_occupancy_state.js

const MONGO_URI =
  process.env.MONGO_URI ||
  'mongodb+srv://THIP:hIVOqtXoPf1KjwTr@cluster0.xzbjsd2.mongodb.net/awesomeliving_qa';

async function main() {
  let MongoClient;
  try {
    ({ MongoClient } = require('mongodb'));
  } catch {
    ({ MongoClient } = require('mongoose').mongo);
  }

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log('Connected to MongoDB');

  const db = client.db('awesomeliving_qa');

  // Delete all existing room_occupancy_states docs — fresh start
  const del_result = await db.collection('room_occupancy_states').deleteMany({});
  console.log('Deleted room_occupancy_states:', del_result.deletedCount, 'docs');

  // Also clear any room_occupancy_settings test_mode flags
  const settings_result = await db
    .collection('room_occupancy_settings')
    .updateMany({}, { $set: { test_mode: true } });
  console.log(
    'Set test_mode=true on room_occupancy_settings:',
    settings_result.modifiedCount,
    'docs',
  );

  // Verify devices have occupancy_group set
  const occ_devices = await db
    .collection('devices')
    .find(
      { occupancy_group: { $exists: true, $ne: null }, type: 'Zigbee', status: 'active' },
      { projection: { id: 1, sensor_role: 1, occupancy_group: 1, _id: 0 } },
    )
    .toArray();

  console.log('\n=== Device occupancy_group check ===');
  if (occ_devices.length > 0) {
    occ_devices.forEach((d) => console.log('  ', JSON.stringify(d)));
    console.log('✓', occ_devices.length, 'devices have occupancy_group set');
  } else {
    console.log('✗ NO devices have occupancy_group set!');
    console.log('  The new occupancy code will NOT receive events.');
    console.log('  Run setup_occupancy_devices_node.js to fix this.');
  }

  console.log('\n✓ Occupancy state reset complete — ready to test');
  await client.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
