const mongoose = require("mongoose");

// Some local networks/ISPs block the DNS TXT/SRV lookup a
// mongodb+srv:// connection string depends on, causing
// "querySrv ECONNREFUSED" / ETIMEOUT failures that have nothing to do
// with MongoDB Atlas itself. Pointing DNS lookups at public resolvers
// works around it. Harmless if the network was fine already. Lives here
// (not just in server.js) so every entry point — the server AND any
// standalone script like scripts/seed.js or scripts/seedPlatformAdmin.js
// — gets the same fix, since they all go through connectDB() below.
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);

let connectPromise = null;

function connectDB() {
  if (!process.env.MONGODBLK_URI) {
    throw new Error(
      "MONGODB_URI is not set. Point it at your MongoDB Atlas connection string — see .env.example."
    );
  }

  if (!connectPromise) {
    mongoose.set("strictQuery", true);
    connectPromise = mongoose.connect(process.env.MONGODBLK_URI);
    connectPromise
      .then(() => console.log("✓ Connected to MongoDB"))
      .catch((err) => {
        console.error("✗ MongoDB connection failed:", err.message);
        process.exit(1);
      });
  }

  return connectPromise;
}

module.exports = { connectDB };
