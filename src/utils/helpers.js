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

function addHours(dateStr, hours) {
  const d = new Date(dateStr);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

function hoursBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diff = d2 - d1;
  return Math.round(diff / (1000 * 60 * 60) * 100) / 100;
}

function getRemainingTime(deadlineStr, nowStr) {
  const now = nowStr ? new Date(nowStr) : new Date();
  const deadline = new Date(deadlineStr);
  const diffMs = deadline - now;
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;

  let remainingText = '';
  let isOverdue = diffMs <= 0;

  if (isOverdue) {
    const absHours = Math.abs(diffHours);
    if (absHours >= 24) {
      const days = Math.floor(absHours / 24);
      const hours = Math.round(absHours % 24);
      remainingText = `逾期${days}天${hours > 0 ? hours + '小时' : ''}`;
    } else {
      remainingText = `逾期${Math.round(absHours)}小时`;
    }
  } else {
    if (diffHours >= 24) {
      const days = Math.floor(diffDays);
      const hours = Math.round(diffHours % 24);
      remainingText = `剩余${days}天${hours > 0 ? hours + '小时' : ''}`;
    } else if (diffHours >= 1) {
      remainingText = `剩余${Math.round(diffHours)}小时`;
    } else {
      const minutes = Math.round(diffMs / (1000 * 60));
      remainingText = `剩余${minutes}分钟`;
    }
  }

  let urgencyLevel = 'normal';
  if (isOverdue) {
    urgencyLevel = 'overdue';
  } else if (diffHours <= 4) {
    urgencyLevel = 'critical';
  } else if (diffHours <= 24) {
    urgencyLevel = 'warning';
  }

  return {
    remainingHours: Math.round(diffHours * 100) / 100,
    remainingDays: Math.round(diffDays * 100) / 100,
    remainingText,
    isOverdue,
    urgencyLevel
  };
}

function escalateRiskLevel(currentLevel) {
  const levels = ['low', 'medium', 'high', 'critical'];
  const currentIndex = levels.indexOf(currentLevel);
  if (currentIndex === -1) return 'medium';
  return levels[Math.min(currentIndex + 1, levels.length - 1)];
}

function getOverdueReason(rect) {
  const now = new Date();
  if (rect.status === '待整改' || rect.status === '整改中') {
    if (rect.deadline && new Date(rect.deadline) <= now) {
      return '整改超时未提交';
    }
  }
  if (rect.status === '待复核') {
    if (rect.reviewDeadline && new Date(rect.reviewDeadline) <= now) {
      return '复核超时未处理';
    }
  }
  if (rect.status === '复核不通过') {
    if (rect.reopenDeadline && new Date(rect.reopenDeadline) <= now) {
      return '复核不通过后重新整改超时';
    }
  }
  return rect.overdueReason || '';
}

module.exports = {
  generateId,
  getNowISO,
  getDateString,
  addDays,
  addHours,
  daysBetween,
  hoursBetween,
  getMachineInfo,
  getRemainingTime,
  escalateRiskLevel,
  getOverdueReason
};
