// Run this in MongoDB Compass shell (Open MongoDB Shell button)
// on the awesomeliving_qa database.
//
// It looks up each unique serialnumber in emfit_logs, finds the matching
// device in the devices collection, and bulk-updates all emfit_logs records
// for that serial with the device's _id.

use('awesomeliving_qa');

// Step 1: Get all unique serialnumbers from emfit_logs that have device_id: null
const serials = db.emfit_logs.distinct('serialnumber', { device_id: null });
print(`Found ${serials.length} unique serialnumber(s) with device_id: null`);

let total_updated = 0;

for (const sn of serials) {
  if (!sn) {
    print(`  Skipping null/empty serialnumber`);
    continue;
  }

  // Step 2: Find the matching device by sr_num + type Emfit
  const device = db.devices.findOne({ sr_num: sn, type: 'Emfit' });

  if (!device) {
    print(`  No Emfit device found for serialnumber: ${sn} — skipping`);
    continue;
  }

  // Step 3: Bulk update all emfit_logs with this serialnumber
  const result = db.emfit_logs.updateMany(
    { serialnumber: sn, device_id: null },
    { $set: { device_id: device._id.toString() } }
  );

  print(`  Updated ${result.modifiedCount} records for serialnumber: ${sn} → device_id: ${device._id}`);
  total_updated += result.modifiedCount;
}

print(`\nDone. Total records updated: ${total_updated}`);
