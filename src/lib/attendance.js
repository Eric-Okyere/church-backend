const Member = require("../models/Member");
const Service = require("../models/Service");
const Attendance = require("../models/Attendance");
const { distanceMeters } = require("./geo");

// The church's location and how far (in meters) a member's phone is allowed
// to be from it for the venue self-check-in to succeed. Required for
// checkInMemberAtVenue — everything else in this file works without them.
const CHURCH_LAT = Number(process.env.CHURCH_LATITUDE);
const CHURCH_LNG = Number(process.env.CHURCH_LONGITUDE);
const CHURCH_RADIUS_METERS = Number(process.env.CHURCH_CHECKIN_RADIUS_METERS) || 200;

function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

// Compares phone numbers by their last 8 digits rather than requiring an
// exact string match — tolerant of spaces/dashes and of a member typing
// "024..." while the record on file has "+233 24..." (or vice versa),
// which is the single biggest source of false "identity mismatch"
// rejections in practice. Still requires both numbers be at least 8 digits,
// which is enough entropy to not be reasonably guessable.
function phonesMatch(a, b) {
  const da = normalizePhone(a);
  const db = normalizePhone(b);
  const TAIL = 8;
  if (da.length < TAIL || db.length < TAIL) return false;
  return da.slice(-TAIL) === db.slice(-TAIL);
}

async function getActiveService() {
  return Service.findOne({ status: "active" });
}

// Shared by both check-in paths: catches the duplicate-key error from the
// partial unique index (serviceId + memberId) as a graceful "already
// checked in" rather than a 500, in case of a race between two near-
// simultaneous scans of the same member.
async function insertAttendance(doc) {
  try {
    await Attendance.create(doc);
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // duplicate — already checked in
    throw err;
  }
}

async function checkInByToken(qrToken) {
  const service = await getActiveService();
  if (!service) return { ok: false, reason: "no_active_service" };

  const member = await Member.findOne({ qrToken });
  if (!member) return { ok: false, reason: "invalid_token" };
  if (!member.active) return { ok: false, reason: "inactive_member" };

  const existing = await Attendance.findOne({ serviceId: service.id, memberId: member.id });
  if (existing) {
    return {
      ok: true,
      alreadyIn: true,
      memberName: member.name,
      serviceId: service.id,
      serviceName: service.name,
    };
  }

  const inserted = await insertAttendance({
    serviceId: service.id,
    memberId: member.id,
    method: "qr",
  });

  return {
    ok: true,
    alreadyIn: !inserted,
    memberName: member.name,
    serviceId: service.id,
    serviceName: service.name,
  };
}

async function checkInMemberManually(memberId, serviceId) {
  const service = await Service.findById(serviceId);
  if (!service) return { ok: false, reason: "no_active_service" };

  const member = await Member.findById(memberId);
  if (!member) return { ok: false, reason: "invalid_token" };

  const existing = await Attendance.findOne({ serviceId: service.id, memberId: member.id });
  if (existing) {
    return {
      ok: true,
      alreadyIn: true,
      memberName: member.name,
      serviceId: service.id,
      serviceName: service.name,
    };
  }

  const inserted = await insertAttendance({
    serviceId: service.id,
    memberId: member.id,
    method: "manual",
  });

  return {
    ok: true,
    alreadyIn: !inserted,
    memberName: member.name,
    serviceId: service.id,
    serviceName: service.name,
  };
}

async function checkInVisitor(serviceId, visitorName, visitorPhone) {
  await Attendance.create({
    serviceId,
    visitorName,
    visitorPhone: visitorPhone || null,
    method: "visitor",
  });
}

// The public "scan the poster on the wall" flow — no admin/usher involved.
// Two things stand in for the login a member doesn't have:
//   1. Their phone's GPS must place them within CHURCH_RADIUS_METERS of the
//      church (CHURCH_LATITUDE/CHURCH_LONGITUDE) — this is checked FIRST,
//      before touching the database at all, so someone outside the
//      premises can't even probe whether a name/phone combination is valid.
//   2. They must type the full phone number already on file for the member
//      they selected — proves it's actually them, not just someone tapping
//      a name off a public list.
// Both must pass, or the check-in is rejected with a specific reason the
// frontend turns into a clear message.
async function checkInMemberAtVenue(memberId, phone, lat, lng) {
  if (!Number.isFinite(CHURCH_LAT) || !Number.isFinite(CHURCH_LNG)) {
    // Admin hasn't set CHURCH_LATITUDE/CHURCH_LONGITUDE yet — fail closed
    // rather than silently skipping the location check.
    return { ok: false, reason: "not_configured" };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: "invalid_location" };
  }

  const distance = distanceMeters(CHURCH_LAT, CHURCH_LNG, lat, lng);
  if (distance > CHURCH_RADIUS_METERS) {
    return { ok: false, reason: "out_of_range" };
  }

  const service = await getActiveService();
  if (!service) return { ok: false, reason: "no_active_service" };

  const member = await Member.findById(memberId).catch(() => null);
  if (!member) return { ok: false, reason: "invalid_member" };
  if (!member.active) return { ok: false, reason: "inactive_member" };

  if (!phonesMatch(phone, member.phone)) {
    return { ok: false, reason: "identity_mismatch" };
  }

  const existing = await Attendance.findOne({ serviceId: service.id, memberId: member.id });
  if (existing) {
    return {
      ok: true,
      alreadyIn: true,
      memberName: member.name,
      serviceId: service.id,
      serviceName: service.name,
    };
  }

  const inserted = await insertAttendance({
    serviceId: service.id,
    memberId: member.id,
    method: "venue",
    location: { lat, lng },
  });

  return {
    ok: true,
    alreadyIn: !inserted,
    memberName: member.name,
    serviceId: service.id,
    serviceName: service.name,
  };
}

module.exports = {
  checkInByToken,
  checkInMemberManually,
  checkInVisitor,
  checkInMemberAtVenue,
  getActiveService,
};
