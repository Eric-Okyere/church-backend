/**
 * Creates (or updates the password/name of) the single platform-admin
 * login — a cross-church operator account, distinct from any church's own
 * role:"admin". There's deliberately no signup form for this; it only ever
 * exists via this script.
 *
 * Usage:
 *   PLATFORM_ADMIN_USERNAME=... PLATFORM_ADMIN_PASSWORD=... [PLATFORM_ADMIN_NAME=...] npm run seed:platform-admin
 */
require("dotenv/config");
const bcrypt = require("bcryptjs");
const { connectDB } = require("../src/db");
const User = require("../src/models/User");

async function main() {
  await connectDB();

  const username = (process.env.PLATFORM_ADMIN_USERNAME || "").trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || "";
  const name = process.env.PLATFORM_ADMIN_NAME || "Platform Admin";

  if (!username || !password) {
    console.error("Set PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD and re-run.");
    process.exit(1);
  }

  const existing = await User.findOne({ username });
  if (existing && !existing.isPlatformAdmin) {
    console.error(
      `✗ "${username}" already exists as a regular church user — refusing to overwrite it. Choose a different PLATFORM_ADMIN_USERNAME.`
    );
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  if (existing) {
    existing.name = name;
    existing.passwordHash = passwordHash;
    await existing.save();
    console.log(`✓ Updated platform admin "${username}".`);
  } else {
    await User.create({
      name,
      username,
      passwordHash,
      isPlatformAdmin: true,
      churchId: null,
    });
    console.log(`✓ Created platform admin "${username}".`);
  }

  console.log("Sign in at /login with these credentials — you'll be redirected to /platform.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
