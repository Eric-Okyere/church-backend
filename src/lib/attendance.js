const Member = require("../models/Member");
const Service = require("../models/Service");
const Attendance = require("../models/Attendance");

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

module.exports = { checkInByToken, checkInMemberManually, checkInVisitor, getActiveService };
