const mongoose = require("mongoose");

let connectPromise = null;

function connectDB() {
  if (!process.env.MONGODBLK_URI) {
    throw new Error(
      "MONGODBLK_URI is not set. Point it at your MongoDB Atlas connection string — see .env.example."
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