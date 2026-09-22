// Node.js version of setup_occupancy_devices.js
// Uses mongodb native driver (available via mongoose in the backend container)
//
// Run inside the QA backend container:
//   docker exec -i awesomeliving-qa-backend node < setup_occupancy_devices_node.js

const MONGO_URI =
  process.env.MONGO_URI ||
  'mongodb+srv://THIP:hIVOqtXoPf1KjwTr@cluster0.xzbjsd2.mongodb.net/awesomeliving_qa';

async function main() {
  let MongoClient;
  try {
    // Try native mongodb driver first
    ({ MongoClient } = require('mongodb'));
  } catch {
    // Fall back to mongoose's bundled driver
    ({ MongoClient } = require('mongoose').mongo);
  }

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log('Connected to MongoDB');

  const db = client.db('awesomeliving_qa');
  const devices = db.collection('devices');

  // 1. Motion Sensor Master → room_motion
  const master = await devices.updateOne(
    { id: 'Motion Sensor Master', type: 'Zigbee', status: 'active' },
    {
      $set: {
        sensor_role: 'room_motion',
        occupancy_group: 'Washroom',
        room: 'Washroom',
      },
    },
  );
  console.log('Motion Sensor Master (room_motion):', JSON.stringify(master));

  // 2. Curtain Sensor → threshold_motion
  const curtain = await devices.updateOne(
    { id: 'motion_2 Sensor Master', type: 'Zigbee', status: 'active' },
    {
      $set: {
        sensor_role: 'threshold_motion',
        occupancy_group: 'Washroom',
      },
    },
  );
  console.log('motion_2 Sensor Master (threshold_motion):', JSON.stringify(curtain));

  // 3. Door/Window Sensor → occupancy_door
  const door = await devices.updateOne(
    { id: 'window Sensor Master', type: 'Zigbee', status: 'active' },
    {
      $set: {
        sensor_role: 'occupancy_door',
        occupancy_group: 'Washroom',
      },
    },
  );
  console.log('window Sensor Master (occupancy_door):', JSON.stringify(door));

  // Verify
  console.log('\n=== Verification ===');
  const results = await devices
    .find(
      { occupancy_group: 'Washroom', type: 'Zigbee', status: 'active' },
      { projection: { id: 1, ieee: 1, sensor_role: 1, occupancy_group: 1, room: 1, _id: 0 } },
    )
    .toArray();

  console.log('Devices in Washroom occupancy group:');
  results.forEach((d) => console.log('  ', JSON.stringify(d)));

  if (results.length === 3) {
    console.log('\n✓ All 3 devices configured correctly');
  } else {
    console.log(
      '\n✗ Expected 3 devices, found ' + results.length + '. Check device names / status.',
    );
  }

  await client.close();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
