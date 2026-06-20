const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { getNowISO } = require('../utils/helpers');
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
    const enrichedRects = relatedRects.map(r => enrichRectification(r));
    const latestRect = enrichedRects.length > 0
      ? enrichedRects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
      : null;

    return {
      ...a,
      rectificationCount: enrichedRects.length,
      rectificationStatus: latestRect ? latestRect.status : null,
      rectificationId: latestRect ? latestRect.id : null,
      rectifications: enrichedRects
    };
  });

  let result = enriched;
  if (rectificationStatus) {
    result = enriched.filter(a => a.rectificationStatus === rectificationStatus);
  }

  result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
      const machineRects = rectifications.filter(r => r.machineId === machineId);
      const latestRect = machineRects.length > 0
        ? machineRects.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
        : null;
      return {
        machineId,
        machineName: machine ? machine.name : machineId,
        count,
        rectificationCount: machineRects.length,
        rectificationStatus: latestRect ? latestRect.status : null
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const rectStats = {};
  for (const r of rectifications) {
    rectStats[r.status] = (rectStats[r.status] || 0) + 1;
  }

  res.json({
    total: anomalies.length,
    unresolved: unresolved.length,
    byType,
    bySeverity,
    topMachines,
    rectificationStats: rectStats
  });
});

module.exports = router;
