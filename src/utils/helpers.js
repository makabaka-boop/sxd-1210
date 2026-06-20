const uuid = require('uuid');
const db = require('../db');

function generateId(prefix) {
  return `${prefix}_${uuid.v4().slice(0, 8)}`;
}

function getNowISO() {
  return new Date().toISOString();
}

function getDateString(date) {
  const d = date || new Date();
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diff = Math.abs(d2 - d1);
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function getMachineInfo(machineId) {
  const machine = db.get('machines').find({ id: machineId }).value();
  if (!machine) return null;

  const area = db.get('areas').find({ id: machine.areaId }).value();
  const route = db.get('routes').find({ id: machine.routeId }).value();
  const tempZone = db.get('temperatureZones').find({ id: machine.temperatureZoneId }).value();
  const restocker = route ? db.get('users').find({ id: route.restockerId }).value() : null;

  return {
    ...machine,
    areaName: area ? area.name : null,
    routeName: route ? route.name : null,
    temperatureZoneName: tempZone ? tempZone.name : null,
    minTemp: tempZone ? tempZone.minTemp : null,
    maxTemp: tempZone ? tempZone.maxTemp : null,
    restockerId: route ? route.restockerId : null,
    restockerName: restocker ? restocker.name : null
  };
}

module.exports = {
  generateId,
  getNowISO,
  getDateString,
  addDays,
  daysBetween,
  getMachineInfo
};
