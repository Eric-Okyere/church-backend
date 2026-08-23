const mongoose = require("mongoose");

let connectPromise = null;

function connectDB() {
  if (!process.env.MONGODB_URI) {
    throw new Error(
      "MONGODB_URI is not set. Point it at your MongoDB Atlas connection string — see .env"
    );
  }

  if (!connectPromise) {
    mongoose.set("strictQuery", true);
    connectPromise = mongoose.connect(process.env.MONGODB_URI);
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
