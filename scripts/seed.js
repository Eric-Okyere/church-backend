/**
 * Seeds an initial admin user (and, unless SEED_MINIMAL=1, a handful of
 * sample members + a past service) so the API is usable immediately.
 *
 * Usage: npm run seed
 */
require("dotenv/config");
const bcrypt = require("bcryptjs");
const { connectDB } = require("../src/db");
const User = require("../src/models/User");
const Member = require("../src/models/Member");
const Service = require("../src/models/Service");
const Attendance = require("../src/models/Attendance");
const { newQrToken } = require("../src/lib/utils");

async function main() {
  await connectDB();

  const adminUsername = (process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "changeme123";
  const adminName = process.env.ADMIN_NAME || "Admin";

  const existing = await User.findOne({ username: adminUsername });
  if (!existing) {
    await User.create({
      name: adminName,
      username: adminUsername,
      passwordHash: await bcrypt.hash(adminPassword, 10),
      role: "admin",
    });
    console.log(`✓ Created admin user "${adminUsername}" (password: ${adminPassword})`);
  } else {
    console.log(`• Admin user "${adminUsername}" already exists — skipping.`);
  }

  if (process.env.SEED_MINIMAL === "1") {
    console.log("SEED_MINIMAL=1 set — skipping sample data.");
    process.exit(0);
  }

  const memberCount = await Member.countDocuments();
  if (memberCount > 0) {
    console.log("• Members already exist — skipping sample data.");
    process.exit(0);
  }

  const sampleNames = ["Ama Mensah", "Kwame Owusu", "Efua Boateng", "Kofi Asante", "Abena Darko", "Yaw Appiah"];
  const members = await Member.insertMany(
    sampleNames.map((name) => ({
      name,
      phone: `02${Math.floor(10000000 + Math.random() * 89999999)}`,
      qrToken: newQrToken(),
    }))
  );
  console.log(`✓ Added ${members.length} sample members`);

  const lastSunday = new Date();
  lastSunday.setDate(lastSunday.getDate() - ((lastSunday.getDay() + 7) % 7 || 7));
  const lastSundayIso = lastSunday.toISOString().slice(0, 10);

  const service = await Service.create({ name: "Sunday Service", date: lastSundayIso, status: "ended" });

  await Attendance.insertMany(
    members.slice(0, 4).map((m) => ({ serviceId: service.id, memberId: m.id, method: "qr" }))
  );
  console.log("✓ Added a sample past service with attendance");
  console.log("\nDone. Run `npm run dev` and sign in with the admin credentials above.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
