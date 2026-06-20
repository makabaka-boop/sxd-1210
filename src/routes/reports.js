const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { getDateString, daysBetween, getMachineInfo } = require('../utils/helpers');

const router = express.Router();
router.use(authMiddleware);

// 缺品高发机器
router.get('/stock-shortage-machines', (req, res) => {
  const { startDate, endDate, areaId, topN } = req.query;
  const topCount = parseInt(topN) || 10;

  let restockRecords = db.get('restockRecords').value();

  if (startDate) {
    restockRecords = restockRecords.filter(r => new Date(r.createdAt) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    restockRecords = restockRecords.filter(r => new Date(r.createdAt) <= end);
  }

  const machineStats = {};

  for (const record of restockRecords) {
    if (!record.items) continue;

    const hasShortage = record.items.some(item => (item.shortageQuantity || 0) > 0);
    if (!hasShortage) continue;

    if (!machineStats[record.machineId]) {
      machineStats[record.machineId] = {
        machineId: record.machineId,
        shortageCount: 0,
        totalTasks: 0,
        items: []
      };
    }

    machineStats[record.machineId].shortageCount++;
    for (const item of record.items) {
      if ((item.shortageQuantity || 0) > 0) {
        machineStats[record.machineId].items.push({
          productId: item.productId,
          productName: item.productName,
          shortageQuantity: item.shortageQuantity
        });
      }
    }
  }

  let result = Object.values(machineStats).map(stat => {
    const machineInfo = getMachineInfo(stat.machineId);
    return {
      ...stat,
      machineName: machineInfo ? machineInfo.name : stat.machineId,
      areaId: machineInfo ? machineInfo.areaId : null,
      areaName: machineInfo ? machineInfo.areaName : null,
      routeName: machineInfo ? machineInfo.routeName : null
    };
  });

  if (areaId) {
    result = result.filter(r => r.areaId === areaId);
  }

  result.sort((a, b) => b.shortageCount - a.shortageCount);
  result = result.slice(0, topCount);

  res.json(result);
});

// 温区异常分布
router.get('/temperature-abnormal-distribution', (req, res) => {
  const { startDate, endDate, areaId, zoneId } = req.query;

  let tempRecords = db.get('temperatureRecords').filter({ isAbnormal: true }).value();

  if (startDate) {
    tempRecords = tempRecords.filter(r => new Date(r.createdAt) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    tempRecords = tempRecords.filter(r => new Date(r.createdAt) <= end);
  }
  if (zoneId) {
    tempRecords = tempRecords.filter(r => r.zoneId === zoneId);
  }

  const byZone = {};
  const byMachine = {};
  const byArea = {};

  for (const record of tempRecords) {
    const zoneName = record.zoneName || '未知';
    byZone[zoneName] = (byZone[zoneName] || 0) + 1;

    if (!byMachine[record.machineId]) {
      const machineInfo = getMachineInfo(record.machineId);
      byMachine[record.machineId] = {
        machineId: record.machineId,
        machineName: machineInfo ? machineInfo.name : record.machineId,
        areaName: machineInfo ? machineInfo.areaName : null,
        count: 0,
        records: []
      };
    }
    byMachine[record.machineId].count++;
    byMachine[record.machineId].records.push({
      temperature: record.temperature,
      minTemp: record.minTemp,
      maxTemp: record.maxTemp,
      createdAt: record.createdAt
    });

    const machineInfo = getMachineInfo(record.machineId);
    if (machineInfo && machineInfo.areaName) {
      byArea[machineInfo.areaName] = (byArea[machineInfo.areaName] || 0) + 1;
    }
  }

  let machineList = Object.values(byMachine);
  if (areaId) {
    machineList = machineList.filter(m => {
      const mi = getMachineInfo(m.machineId);
      return mi && mi.areaId === areaId;
    });
  }
  machineList.sort((a, b) => b.count - a.count);

  res.json({
    byZone,
    byArea,
    byMachine: machineList.slice(0, 20),
    totalAbnormal: tempRecords.length
  });
});

// 路线完成率
router.get('/route-completion-rate', (req, res) => {
  const { startDate, endDate, routeId, restockerId } = req.query;

  let tasks = db.get('tasks').value();

  if (startDate) {
    tasks = tasks.filter(t => new Date(t.scheduledTime) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    tasks = tasks.filter(t => new Date(t.scheduledTime) <= end);
  }
  if (routeId) {
    tasks = tasks.filter(t => t.routeId === routeId);
  }
  if (restockerId) {
    tasks = tasks.filter(t => t.assigneeId === restockerId);
  }

  const routeStats = {};

  for (const task of tasks) {
    const rId = task.routeId || '未分配';
    if (!routeStats[rId]) {
      const route = db.get('routes').find({ id: rId }).value();
      const restocker = task.assigneeId ? db.get('users').find({ id: task.assigneeId }).value() : null;
      routeStats[rId] = {
        routeId: rId,
        routeName: route ? route.name : '未分配路线',
        restockerId: task.assigneeId || null,
        restockerName: restocker ? restocker.name : null,
        totalTasks: 0,
        completedTasks: 0,
        pendingTasks: 0,
        overdueTasks: 0,
        avgCompletionHours: [],
        statusBreakdown: {}
      };
    }

    routeStats[rId].totalTasks++;
    routeStats[rId].statusBreakdown[task.status] = (routeStats[rId].statusBreakdown[task.status] || 0) + 1;

    if (task.status === '已完成') {
      routeStats[rId].completedTasks++;
      if (task.scheduledTime && task.completedTime) {
        const hours = (new Date(task.completedTime) - new Date(task.scheduledTime)) / (1000 * 60 * 60);
        routeStats[rId].avgCompletionHours.push(hours);
      }
    } else if (['待补货', '补货中', '待抽检', '温区异常', '缺品预警'].includes(task.status)) {
      routeStats[rId].pendingTasks++;
      if (task.scheduledTime) {
        const hoursDiff = (new Date() - new Date(task.scheduledTime)) / (1000 * 60 * 60);
        if (hoursDiff > 8) {
          routeStats[rId].overdueTasks++;
        }
      }
    }
  }

  const result = Object.values(routeStats).map(stat => ({
    ...stat,
    completionRate: stat.totalTasks > 0 ? Number(((stat.completedTasks / stat.totalTasks) * 100).toFixed(2)) : 0,
    avgCompletionHours: stat.avgCompletionHours.length > 0
      ? Number((stat.avgCompletionHours.reduce((a, b) => a + b, 0) / stat.avgCompletionHours.length).toFixed(2))
      : null
  }));

  result.sort((a, b) => b.completionRate - a.completionRate);

  res.json({
    totalTasks: tasks.length,
    routes: result
  });
});

// 综合数据概览
router.get('/overview', (req, res) => {
  const { startDate, endDate } = req.query;

  let tasks = db.get('tasks').value();
  let restockRecords = db.get('restockRecords').value();
  let tempRecords = db.get('temperatureRecords').value();

  if (startDate) {
    tasks = tasks.filter(t => new Date(t.createdAt) >= new Date(startDate));
    restockRecords = restockRecords.filter(r => new Date(r.createdAt) >= new Date(startDate));
    tempRecords = tempRecords.filter(r => new Date(r.createdAt) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    tasks = tasks.filter(t => new Date(t.createdAt) <= end);
    restockRecords = restockRecords.filter(r => new Date(r.createdAt) <= end);
    tempRecords = tempRecords.filter(r => new Date(r.createdAt) <= end);
  }

  const statusBreakdown = {};
  for (const task of tasks) {
    statusBreakdown[task.status] = (statusBreakdown[task.status] || 0) + 1;
  }

  const totalProductsRestocked = restockRecords.reduce((sum, r) => {
    return sum + (r.items ? r.items.reduce((s, i) => s + (i.restockQuantity || 0), 0) : 0);
  }, 0);

  const totalShortage = restockRecords.reduce((sum, r) => {
    return sum + (r.items ? r.items.reduce((s, i) => s + (i.shortageQuantity || 0), 0) : 0);
  }, 0);

  const abnormalTempCount = tempRecords.filter(r => r.isAbnormal).length;

  const anomalies = db.get('anomalies').filter({ resolved: false }).value();

  const anomalyBreakdown = {};
  for (const a of anomalies) {
    anomalyBreakdown[a.type] = (anomalyBreakdown[a.type] || 0) + 1;
  }

  res.json({
    totalTasks: tasks.length,
    statusBreakdown,
    totalMachines: db.get('machines').value().length,
    totalRestockRecords: restockRecords.length,
    totalProductsRestocked,
    totalShortage,
    totalTempRecords: tempRecords.length,
    abnormalTempCount,
    tempAbnormalRate: tempRecords.length > 0
      ? Number(((abnormalTempCount / tempRecords.length) * 100).toFixed(2))
      : 0,
    unresolvedAnomalies: anomalies.length,
    anomalyBreakdown
  });
});

module.exports = router;
