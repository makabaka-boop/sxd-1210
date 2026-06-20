const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { getNowISO, getMachineInfo } = require('../utils/helpers');
const { detectAndSave, runAllDetectors } = require('../utils/anomalyDetector');
const { enrichRectification } = require('./rectifications');

const router = express.Router();
router.use(authMiddleware);

// 手动触发异常检测
router.post('/detect', requireRole('admin'), (req, res) => {
  const anomalies = detectAndSave();
  res.json({
    message: '异常检测完成',
    detectedCount: anomalies.length,
    anomalies
  });
});

// 查询异常列表
router.get('/', (req, res) => {
  const { type, severity, resolved, machineId, startDate, endDate, rectificationStatus } = req.query;
  let anomalies = db.get('anomalies').value();

  if (type) anomalies = anomalies.filter(a => a.type === type);
  if (severity) anomalies = anomalies.filter(a => a.severity === severity);
  if (resolved !== undefined) anomalies = anomalies.filter(a => a.resolved === (resolved === 'true'));
  if (machineId) anomalies = anomalies.filter(a => a.machineId === machineId);
  if (startDate) {
    anomalies = anomalies.filter(a => new Date(a.createdAt) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    anomalies = anomalies.filter(a => new Date(a.createdAt) <= end);
  }

  const rectifications = db.get('rectifications').value();

  const enriched = anomalies.map(a => {
    let relatedRects = [];
    if (a.taskId) {
      relatedRects = rectifications.filter(r => r.taskId === a.taskId);
    }
    if (relatedRects.length === 0 && a.machineId) {
      relatedRects = rectifications.filter(r => r.machineId === a.machineId);
    }
    const enrichedRects = relatedRects.map(r => enrichRectification(r));
    const latestRect = enrichedRects.length > 0
      ? enrichedRects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
      : null;

    const unclosedRects = enrichedRects.filter(r => r.status !== '已完成');
    const hasOverdueRect = unclosedRects.some(r => r.isOverdue);
    const maxRiskRect = unclosedRects.length > 0
      ? unclosedRects.sort((a, b) => {
          const riskOrder = { critical: 4, high: 3, medium: 2, low: 1 };
          return riskOrder[b.riskLevel] - riskOrder[a.riskLevel];
        })[0]
      : null;

    let overallRectStatus = '无';
    if (latestRect) {
      if (latestRect.status === '已完成') {
        overallRectStatus = hasOverdueRect ? '逾期后闭环' : '已闭环';
      } else if (hasOverdueRect) {
        overallRectStatus = '整改逾期';
      } else {
        overallRectStatus = '整改中';
      }
    }

    return {
      ...a,
      rectificationCount: enrichedRects.length,
      rectificationStatus: latestRect ? latestRect.status : null,
      rectificationId: latestRect ? latestRect.id : null,
      rectifications: enrichedRects,
      latestRectification: latestRect,
      hasRectification: enrichedRects.length > 0,
      hasOverdueRectification: hasOverdueRect,
      highestRectRiskLevel: maxRiskRect ? maxRiskRect.riskLevel : null,
      highestRectRiskLevelText: maxRiskRect ? maxRiskRect.riskLevelText : null,
      unclosedRectCount: unclosedRects.length,
      overallRectStatus,
      overdueRectCount: unclosedRects.filter(r => r.isOverdue).length,
      maxEscalationCount: unclosedRects.length > 0
        ? Math.max(...unclosedRects.map(r => r.escalationCount || 0))
        : 0,
      responsibleRestockerId: latestRect ? latestRect.restockerId : null,
      responsibleRestockerName: latestRect ? latestRect.restockerName : null,
      routeId: latestRect ? latestRect.routeId : null,
      routeName: latestRect ? latestRect.routeName : null
    };
  });

  let result = enriched;
  if (rectificationStatus) {
    result = result.filter(a => a.rectificationStatus === rectificationStatus);
  }

  const { hasOverdue, riskLevel, minEscalation, unclosedOnly } = req.query;
  if (hasOverdue !== undefined) {
    result = result.filter(a => a.hasOverdueRectification === (hasOverdue === 'true'));
  }
  if (riskLevel) {
    result = result.filter(a => a.highestRectRiskLevel === riskLevel);
  }
  if (minEscalation) {
    const min = parseInt(minEscalation) || 0;
    result = result.filter(a => a.maxEscalationCount >= min);
  }
  if (unclosedOnly === 'true') {
    result = result.filter(a => a.unclosedRectCount > 0);
  }

  result.sort((a, b) => {
    const riskOrder = { critical: 4, high: 3, medium: 2, low: 1, null: 0 };
    const riskDiff = riskOrder[b.highestRectRiskLevel] - riskOrder[a.highestRectRiskLevel];
    if (riskDiff !== 0) return riskDiff;
    if (b.hasOverdueRectification !== a.hasOverdueRectification) {
      return b.hasOverdueRectification ? 1 : -1;
    }
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  res.json(result);
});

// 标记异常为已解决
router.put('/:id/resolve', requireRole('admin', 'inspector'), (req, res) => {
  const { id } = req.params;
  const { resolveNote } = req.body;

  const anomaly = db.get('anomalies').find({ id }).value();
  if (!anomaly) {
    return res.status(404).json({ error: '异常记录不存在' });
  }

  db.get('anomalies')
    .find({ id })
    .assign({
      resolved: true,
      resolvedBy: req.user.id,
      resolvedByName: req.user.name,
      resolvedAt: getNowISO(),
      resolveNote: resolveNote || ''
    })
    .write();

  res.json({ message: '异常已标记为解决' });
});

// 获取异常统计概览
router.get('/summary', (req, res) => {
  const anomalies = db.get('anomalies').value();
  const rectifications = db.get('rectifications').value();
  const enrichedRects = rectifications.map(r => enrichRectification(r));
  const unresolved = anomalies.filter(a => !a.resolved);

  const byType = {};
  const bySeverity = {};
  const byMachine = {};

  for (const a of anomalies) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
    byMachine[a.machineId] = (byMachine[a.machineId] || 0) + 1;
  }

  const topMachines = Object.entries(byMachine)
    .map(([machineId, count]) => {
      const machine = db.get('machines').find({ id: machineId }).value();
      const machineRects = enrichedRects.filter(r => r.machineId === machineId);
      const unclosedRects = machineRects.filter(r => r.status !== '已完成');
      const latestRect = machineRects.length > 0
        ? machineRects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
        : null;
      const overdueCount = unclosedRects.filter(r => r.isOverdue).length;
      const maxRiskRect = unclosedRects.length > 0
        ? unclosedRects.sort((a, b) => {
            const riskOrder = { critical: 4, high: 3, medium: 2, low: 1 };
            return riskOrder[b.riskLevel] - riskOrder[a.riskLevel];
          })[0]
        : null;
      const machineInfo = getMachineInfo ? getMachineInfo(machineId) : null;
      return {
        machineId,
        machineName: machine ? machine.name : machineId,
        areaName: machineInfo ? machineInfo.areaName : null,
        routeName: machineInfo ? machineInfo.routeName : null,
        count,
        rectificationCount: machineRects.length,
        rectificationStatus: latestRect ? latestRect.status : null,
        unclosedRectCount: unclosedRects.length,
        overdueRectCount: overdueCount,
        highestRiskLevel: maxRiskRect ? maxRiskRect.riskLevel : null,
        highestRiskLevelText: maxRiskRect ? maxRiskRect.riskLevelText : null,
        hasOverdue: overdueCount > 0,
        restockerName: machineInfo ? machineInfo.restockerName : null
      };
    })
    .sort((a, b) => {
      if (b.overdueRectCount !== a.overdueRectCount) return b.overdueRectCount - a.overdueRectCount;
      return b.count - a.count;
    })
    .slice(0, 10);

  const rectStats = {};
  const overdueStats = {
    totalOverdue: 0,
    pendingOverdue: 0,
    reviewOverdue: 0,
    reopenOverdue: 0,
    riskBreakdown: { critical: 0, high: 0, medium: 0, low: 0 },
    byReason: {}
  };
  for (const r of enrichedRects) {
    rectStats[r.status] = (rectStats[r.status] || 0) + 1;
    if (r.isOverdue) {
      overdueStats.totalOverdue++;
      if (r.status === '待整改' || r.status === '整改中') overdueStats.pendingOverdue++;
      if (r.status === '待复核') overdueStats.reviewOverdue++;
      if (r.status === '复核不通过') overdueStats.reopenOverdue++;
      if (r.riskLevel) {
        overdueStats.riskBreakdown[r.riskLevel] = (overdueStats.riskBreakdown[r.riskLevel] || 0) + 1;
      }
      if (r.overdueReason) {
        overdueStats.byReason[r.overdueReason] = (overdueStats.byReason[r.overdueReason] || 0) + 1;
      }
    }
  }

  const longUnclosedAnomalies = unresolved.filter(a => {
    const relatedRects = enrichedRects.filter(r =>
      (r.taskId === a.taskId || r.machineId === a.machineId) && r.status !== '已完成'
    );
    return relatedRects.some(r => r.isOverdue && (r.escalationCount || 0) >= 2);
  }).length;

  const restockerOverdueStats = {};
  for (const r of enrichedRects) {
    if (!r.isOverdue || r.status === '已完成' || !r.restockerId) continue;
    if (!restockerOverdueStats[r.restockerId]) {
      restockerOverdueStats[r.restockerId] = {
        restockerId: r.restockerId,
        restockerName: r.restockerName,
        overdueCount: 0,
        totalCount: 0,
        maxRiskLevel: 'low'
      };
    }
    restockerOverdueStats[r.restockerId].overdueCount++;
    const riskOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    if (riskOrder[r.riskLevel] > riskOrder[restockerOverdueStats[r.restockerId].maxRiskLevel]) {
      restockerOverdueStats[r.restockerId].maxRiskLevel = r.riskLevel;
    }
  }
  for (const r of enrichedRects) {
    if (!r.restockerId) continue;
    if (restockerOverdueStats[r.restockerId]) {
      restockerOverdueStats[r.restockerId].totalCount++;
    }
  }

  const topOverdueRestockers = Object.values(restockerOverdueStats)
    .map(rs => ({
      ...rs,
      overdueRate: rs.totalCount > 0 ? Number(((rs.overdueCount / rs.totalCount) * 100).toFixed(2)) : 0
    }))
    .sort((a, b) => b.overdueCount - a.overdueCount)
    .slice(0, 10);

  const routeOverdueStats = {};
  for (const r of enrichedRects) {
    if (!r.isOverdue || r.status === '已完成') continue;
    const rId = r.routeId || '未分配';
    if (!routeOverdueStats[rId]) {
      routeOverdueStats[rId] = {
        routeId: rId,
        routeName: r.routeName || '未分配路线',
        overdueCount: 0,
        totalCount: 0
      };
    }
    routeOverdueStats[rId].overdueCount++;
  }
  for (const r of enrichedRects) {
    const rId = r.routeId || '未分配';
    if (routeOverdueStats[rId]) {
      routeOverdueStats[rId].totalCount++;
    }
  }

  const topOverdueRoutes = Object.values(routeOverdueStats)
    .map(rs => ({
      ...rs,
      overdueRate: rs.totalCount > 0 ? Number(((rs.overdueCount / rs.totalCount) * 100).toFixed(2)) : 0
    }))
    .sort((a, b) => b.overdueCount - a.overdueCount)
    .slice(0, 10);

  res.json({
    total: anomalies.length,
    unresolved: unresolved.length,
    byType,
    bySeverity,
    topMachines,
    rectificationStats: rectStats,
    overdueStats: {
      ...overdueStats,
      overdueRate: enrichedRects.length > 0
        ? Number(((overdueStats.totalOverdue / enrichedRects.filter(r => r.status !== '已完成').length) * 100).toFixed(2))
        : 0
    },
    longUnclosedAnomalies,
    longUnclosedRate: unresolved.length > 0
      ? Number(((longUnclosedAnomalies / unresolved.length) * 100).toFixed(2))
      : 0,
    topOverdueRestockers,
    topOverdueRoutes
  });
});

module.exports = router;
