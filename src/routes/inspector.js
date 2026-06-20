const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { generateId, getNowISO, getMachineInfo } = require('../utils/helpers');
const { detectAndSave } = require('../utils/anomalyDetector');
const { createRectification } = require('./rectifications');

const router = express.Router();
router.use(authMiddleware, requireRole('inspector', 'admin'));

// 督导查看待抽检任务
router.get('/pending-tasks', (req, res) => {
  let tasks = db.get('tasks')
    .filter(t => t.status === '待抽检')
    .value();

  const enriched = tasks.map(t => {
    const machineInfo = getMachineInfo(t.machineId);
    const restockRecords = db.get('restockRecords').filter({ taskId: t.id }).value();
    const tempRecords = db.get('temperatureRecords').filter({ taskId: t.id }).value();
    const expiredRemovals = db.get('expiredRemovals').filter({ taskId: t.id }).value();

    return {
      ...t,
      machineName: machineInfo ? machineInfo.name : null,
      areaName: machineInfo ? machineInfo.areaName : null,
      routeName: machineInfo ? machineInfo.routeName : null,
      restockerName: machineInfo ? machineInfo.restockerName : null,
      restockRecords,
      tempRecords,
      expiredRemovals
    };
  }).sort((a, b) => new Date(b.completedTime) - new Date(a.completedTime));

  res.json(enriched);
});

// 提交抽检结论
router.post('/tasks/:id/inspect', (req, res) => {
  const { id } = req.params;
  const {
    conclusion,
    rectificationSuggestion,
    score,
    temperatureCheckPassed,
    expiredCheckPassed,
    stockCheckPassed,
    photoUrl,
    note
  } = req.body;

  const task = db.get('tasks').find({ id }).value();
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  if (task.status !== '待抽检') {
    return res.status(400).json({ error: '当前任务状态不允许抽检' });
  }

  if (!conclusion || !['合格', '不合格', '待整改'].includes(conclusion)) {
    return res.status(400).json({ error: '请选择有效的抽检结论（合格/不合格/待整改）' });
  }

  const inspection = {
    id: generateId('inspect'),
    taskId: id,
    machineId: task.machineId,
    conclusion,
    rectificationSuggestion: rectificationSuggestion || '',
    score: score !== undefined ? Number(score) : null,
    temperatureCheckPassed: temperatureCheckPassed !== undefined ? temperatureCheckPassed : null,
    expiredCheckPassed: expiredCheckPassed !== undefined ? expiredCheckPassed : null,
    stockCheckPassed: stockCheckPassed !== undefined ? stockCheckPassed : null,
    photoUrl: photoUrl || null,
    note: note || '',
    inspectorId: req.user.id,
    inspectorName: req.user.name,
    createdAt: getNowISO()
  };

  db.get('inspections').push(inspection).write();

  let rectification = null;
  let newStatus = '已完成';

  if (conclusion === '待整改' || conclusion === '不合格') {
    rectification = createRectification(id, inspection.id, req.user.id);
    newStatus = '整改中';
  }

  db.get('tasks')
    .find({ id })
    .assign({
      status: newStatus,
      inspected: true,
      inspectedAt: getNowISO(),
      inspectionConclusion: conclusion,
      inspectionScore: score !== undefined ? Number(score) : null,
      rectificationId: rectification ? rectification.id : null
    })
    .write();

  setTimeout(() => detectAndSave(), 100);

  res.status(201).json({
    message: rectification ? '抽检记录已提交，已自动生成整改记录' : '抽检记录已提交',
    inspection,
    rectification,
    task: db.get('tasks').find({ id }).value()
  });
});

// 督导查看已抽检任务
router.get('/completed-inspections', (req, res) => {
  const { startDate, endDate, conclusion, inspectorId } = req.query;
  let inspections = db.get('inspections').value();

  if (inspectorId) {
    inspections = inspections.filter(i => i.inspectorId === inspectorId);
  }
  if (conclusion) {
    inspections = inspections.filter(i => i.conclusion === conclusion);
  }
  if (startDate) {
    inspections = inspections.filter(i => new Date(i.createdAt) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    inspections = inspections.filter(i => new Date(i.createdAt) <= end);
  }

  const enriched = inspections.map(i => {
    const machineInfo = getMachineInfo(i.machineId);
    const task = db.get('tasks').find({ id: i.taskId }).value();
    return {
      ...i,
      machineName: machineInfo ? machineInfo.name : null,
      areaName: machineInfo ? machineInfo.areaName : null,
      taskStatus: task ? task.status : null
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(enriched);
});

module.exports = router;
