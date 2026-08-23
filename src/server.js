require("dotenv/config");
const express = require("express");
const cors = require("cors");
const { connectDB } = require("./db");

const authRoutes = require("./routes/auth");
const memberRoutes = require("./routes/members");
const serviceRoutes = require("./routes/services");
const attendanceRoutes = require("./routes/attendance");

const app = express();

// Comma-separated list of allowed frontend origins, e.g.
// FRONTEND_URL=https://your-church.netlify.app,http://localhost:3000
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000"||"https://churchcivic.netlify.app")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow no-origin requests (curl, server-to-server, health checks).
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/members", memberRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api", attendanceRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Centralized error handler — catches anything thrown/rejected in a route
// (Express 5 forwards rejected async handlers here automatically).
app.use((err, req, res, next) => {
  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Not allowed by CORS." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on our end." });
});

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`GraceTrack API listening on :${PORT}`));
});
