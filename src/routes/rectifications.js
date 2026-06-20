const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { generateId, getNowISO, getMachineInfo } = require('../utils/helpers');
const { detectAndSave } = require('../utils/anomalyDetector');

const router = express.Router();
router.use(authMiddleware);

const RECTIFICATION_STATUSES = ['待整改', '整改中', '待复核', '已完成', '复核不通过'];
const REVIEW_CONCLUSIONS = ['通过', '不通过'];

function enrichRectification(rect) {
  const machineInfo = getMachineInfo(rect.machineId);
  const restocker = rect.restockerId ? db.get('users').find({ id: rect.restockerId }).value() : null;
  const inspector = rect.inspectorId ? db.get('users').find({ id: rect.inspectorId }).value() : null;
  const reviewer = rect.reviewedBy ? db.get('users').find({ id: rect.reviewedBy }).value() : null;
  const task = rect.taskId ? db.get('tasks').find({ id: rect.taskId }).value() : null;
  const inspection = rect.inspectionId ? db.get('inspections').find({ id: rect.inspectionId }).value() : null;

  return {
    ...rect,
    machineName: machineInfo ? machineInfo.name : null,
    areaId: machineInfo ? machineInfo.areaId : null,
    areaName: machineInfo ? machineInfo.areaName : null,
    routeId: machineInfo ? machineInfo.routeId : null,
    routeName: machineInfo ? machineInfo.routeName : null,
    restockerName: restocker ? restocker.name : null,
    inspectorName: inspector ? inspector.name : null,
    reviewerName: reviewer ? reviewer.name : null,
    taskStatus: task ? task.status : null,
    inspectionConclusion: inspection ? inspection.conclusion : null,
    rectificationDuration: rect.submittedAt && rect.createdAt
      ? Math.round((new Date(rect.submittedAt) - new Date(rect.createdAt)) / (1000 * 60 * 60))
      : null
  };
}

function createRectification(taskId, inspectionId, inspectorId) {
  const task = db.get('tasks').find({ id: taskId }).value();
  if (!task) return null;

  const inspection = db.get('inspections').find({ id: inspectionId }).value();
  const machineInfo = getMachineInfo(task.machineId);

  const rectification = {
    id: generateId('rect'),
    taskId,
    machineId: task.machineId,
    restockerId: task.assigneeId,
    inspectorId,
    inspectionId,
    status: '待整改',
    rectificationType: inspection ? inspection.conclusion : '待整改',
    rectificationSuggestion: inspection ? inspection.rectificationSuggestion : '',
    submittedDescription: '',
    submittedPhotos: [],
    submittedRestockItems: [],
    submittedTempRecords: [],
    submittedAt: null,
    reviewConclusion: null,
    reviewNote: '',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: getNowISO()
  };

  db.get('rectifications').push(rectification).write();

  db.get('tasks')
    .find({ id: taskId })
    .assign({ status: '整改中', rectificationId: rectification.id })
    .write();

  return rectification;
}

router.get('/my-pending', requireRole('restocker', 'admin'), (req, res) => {
  let rectifications = db.get('rectifications')
    .filter(r =>
      (r.status === '待整改' || r.status === '整改中' || r.status === '复核不通过') &&
      (r.restockerId === req.user.id || req.user.role === 'admin')
    )
    .value();

  const enriched = rectifications.map(r => enrichRectification(r))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(enriched);
});

router.get('/my-completed', requireRole('restocker', 'admin'), (req, res) => {
  const { startDate, endDate } = req.query;
  let rectifications = db.get('rectifications')
    .filter(r =>
      r.status !== '待整改' && r.status !== '整改中' &&
      (r.restockerId === req.user.id || req.user.role === 'admin')
    )
    .value();

  if (startDate) {
    rectifications = rectifications.filter(r => new Date(r.createdAt) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    rectifications = rectifications.filter(r => new Date(r.createdAt) <= end);
  }

  const enriched = rectifications.map(r => enrichRectification(r))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(enriched);
});

router.get('/pending-review', requireRole('inspector', 'admin'), (req, res) => {
  let rectifications = db.get('rectifications')
    .filter(r => r.status === '待复核')
    .value();

  if (req.user.role === 'inspector') {
    rectifications = rectifications.filter(r => r.inspectorId === req.user.id);
  }

  const enriched = rectifications.map(r => enrichRectification(r))
    .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

  res.json(enriched);
});

router.get('/reviewed', requireRole('inspector', 'admin'), (req, res) => {
  const { startDate, endDate, conclusion } = req.query;
  let rectifications = db.get('rectifications')
    .filter(r => r.status === '已完成' || r.status === '复核不通过')
    .value();

  if (req.user.role === 'inspector') {
    rectifications = rectifications.filter(r => r.inspectorId === req.user.id);
  }
  if (conclusion) {
    rectifications = rectifications.filter(r => r.reviewConclusion === conclusion);
  }
  if (startDate) {
    rectifications = rectifications.filter(r => new Date(r.createdAt) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    rectifications = rectifications.filter(r => new Date(r.createdAt) <= end);
  }

  const enriched = rectifications.map(r => enrichRectification(r))
    .sort((a, b) => new Date(b.reviewedAt || b.createdAt) - new Date(a.reviewedAt || a.createdAt));

  res.json(enriched);
});

router.get('/', requireRole('admin'), (req, res) => {
  const {
    areaId, routeId, machineId, restockerId, status,
    startDate, endDate, rectificationType, page, pageSize
  } = req.query;

  let rectifications = db.get('rectifications').value();

  if (machineId) rectifications = rectifications.filter(r => r.machineId === machineId);
  if (restockerId) rectifications = rectifications.filter(r => r.restockerId === restockerId);
  if (status) rectifications = rectifications.filter(r => r.status === status);
  if (rectificationType) rectifications = rectifications.filter(r => r.rectificationType === rectificationType);

  if (startDate) {
    rectifications = rectifications.filter(r => new Date(r.createdAt) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    rectifications = rectifications.filter(r => new Date(r.createdAt) <= end);
  }

  let enriched = rectifications.map(r => enrichRectification(r));

  if (areaId) {
    enriched = enriched.filter(r => r.areaId === areaId);
  }
  if (routeId) {
    enriched = enriched.filter(r => r.routeId === routeId);
  }

  enriched.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const currentPage = parseInt(page) || 1;
  const size = parseInt(pageSize) || 50;
  const total = enriched.length;
  const totalPages = Math.ceil(total / size);
  const paginated = enriched.slice((currentPage - 1) * size, currentPage * size);

  res.json({
    total,
    totalPages,
    currentPage,
    pageSize: size,
    data: paginated
  });
});

router.get('/:id', (req, res) => {
  const { id } = req.params;
  const rect = db.get('rectifications').find({ id }).value();

  if (!rect) {
    return res.status(404).json({ error: '整改记录不存在' });
  }

  if (req.user.role === 'restocker' && rect.restockerId !== req.user.id) {
    return res.status(403).json({ error: '无权限查看此整改记录' });
  }
  if (req.user.role === 'inspector' && rect.inspectorId !== req.user.id) {
    return res.status(403).json({ error: '无权限查看此整改记录' });
  }

  const enriched = enrichRectification(rect);
  const task = rect.taskId ? db.get('tasks').find({ id: rect.taskId }).value() : null;
  const inspection = rect.inspectionId ? db.get('inspections').find({ id: rect.inspectionId }).value() : null;

  const restockRecords = task ? db.get('restockRecords').filter({ taskId: task.id }).value() : [];
  const tempRecords = task ? db.get('temperatureRecords').filter({ taskId: task.id }).value() : [];
  const expiredRemovals = task ? db.get('expiredRemovals').filter({ taskId: task.id }).value() : [];

  res.json({
    ...enriched,
    task,
    inspection,
    originalRestockRecords: restockRecords,
    originalTempRecords: tempRecords,
    originalExpiredRemovals: expiredRemovals
  });
});

router.post('/:id/start', requireRole('restocker', 'admin'), (req, res) => {
  const { id } = req.params;
  const rect = db.get('rectifications').find({ id }).value();

  if (!rect) {
    return res.status(404).json({ error: '整改记录不存在' });
  }

  if (req.user.role === 'restocker' && rect.restockerId !== req.user.id) {
    return res.status(403).json({ error: '无权限操作此整改记录' });
  }

  if (rect.status !== '待整改' && rect.status !== '复核不通过') {
    return res.status(400).json({ error: '当前状态不允许开始整改' });
  }

  db.get('rectifications')
    .find({ id })
    .assign({ status: '整改中' })
    .write();

  res.json({
    message: '已开始整改',
    rectification: enrichRectification(db.get('rectifications').find({ id }).value())
  });
});

router.post('/:id/submit', requireRole('restocker', 'admin'), (req, res) => {
  const { id } = req.params;
  const { description, photos, restockItems, tempRecords } = req.body;

  const rect = db.get('rectifications').find({ id }).value();
  if (!rect) {
    return res.status(404).json({ error: '整改记录不存在' });
  }

  if (req.user.role === 'restocker' && rect.restockerId !== req.user.id) {
    return res.status(403).json({ error: '无权限操作此整改记录' });
  }

  if (rect.status !== '整改中') {
    return res.status(400).json({ error: '请先开始整改' });
  }

  if (!description || !description.trim()) {
    return res.status(400).json({ error: '请填写整改说明' });
  }

  if (!tempRecords || !Array.isArray(tempRecords) || tempRecords.length === 0) {
    return res.status(400).json({ error: '请提交温区复测记录' });
  }

  const validatedRestockItems = restockItems && Array.isArray(restockItems)
    ? restockItems.map(item => {
        const product = db.get('products').find({ id: item.productId }).value();
        return {
          productId: item.productId,
          productName: product ? product.name : item.productId,
          restockQuantity: Number(item.restockQuantity) || 0,
          shortageQuantity: Number(item.shortageQuantity) || 0,
          shortageReason: item.shortageReason || ''
        };
      })
    : [];

  const validatedTempRecords = tempRecords.map(record => {
    const machineInfo = getMachineInfo(rect.machineId);
    const temp = Number(record.temperature);
    let isAbnormal = false;

    if (machineInfo && machineInfo.minTemp !== null && machineInfo.maxTemp !== null) {
      isAbnormal = temp < machineInfo.minTemp || temp > machineInfo.maxTemp;
    }

    return {
      id: generateId('rect_temp'),
      temperature: temp,
      zoneId: record.zoneId || (machineInfo ? machineInfo.temperatureZoneId : null),
      zoneName: machineInfo ? machineInfo.temperatureZoneName : null,
      isAbnormal,
      minTemp: machineInfo ? machineInfo.minTemp : null,
      maxTemp: machineInfo ? machineInfo.maxTemp : null,
      note: record.note || '',
      photoUrl: record.photoUrl || null,
      measuredAt: getNowISO()
    };
  });

  if (validatedTempRecords.some(t => t.isAbnormal)) {
    return res.status(400).json({
      error: '温区复测存在异常，请确保温度在正常范围内后再提交',
      abnormalRecords: validatedTempRecords.filter(t => t.isAbnormal)
    });
  }

  db.get('rectifications')
    .find({ id })
    .assign({
      status: '待复核',
      submittedDescription: description,
      submittedPhotos: Array.isArray(photos) ? photos : [],
      submittedRestockItems: validatedRestockItems,
      submittedTempRecords: validatedTempRecords,
      submittedAt: getNowISO()
    })
    .write();

  db.get('tasks')
    .find({ id: rect.taskId })
    .assign({ status: '整改待复核' })
    .write();

  res.json({
    message: '整改已提交，等待复核',
    rectification: enrichRectification(db.get('rectifications').find({ id }).value())
  });
});

router.post('/:id/review', requireRole('inspector', 'admin'), (req, res) => {
  const { id } = req.params;
  const { conclusion, note } = req.body;

  const rect = db.get('rectifications').find({ id }).value();
  if (!rect) {
    return res.status(404).json({ error: '整改记录不存在' });
  }

  if (req.user.role === 'inspector' && rect.inspectorId !== req.user.id) {
    return res.status(403).json({ error: '无权限复核此整改记录' });
  }

  if (rect.status !== '待复核') {
    return res.status(400).json({ error: '当前状态不允许复核' });
  }

  if (!conclusion || !REVIEW_CONCLUSIONS.includes(conclusion)) {
    return res.status(400).json({ error: '请选择有效的复核结论（通过/不通过）' });
  }

  const updates = {
    reviewConclusion: conclusion,
    reviewNote: note || '',
    reviewedBy: req.user.id,
    reviewedAt: getNowISO()
  };

  if (conclusion === '通过') {
    updates.status = '已完成';

    db.get('tasks')
      .find({ id: rect.taskId })
      .assign({ status: '已完成', rectificationCompleted: true })
      .write();
  } else {
    updates.status = '复核不通过';

    db.get('tasks')
      .find({ id: rect.taskId })
      .assign({ status: '整改中' })
      .write();
  }

  db.get('rectifications')
    .find({ id })
    .assign(updates)
    .write();

  setTimeout(() => detectAndSave(), 100);

  res.json({
    message: conclusion === '通过' ? '复核通过，任务已完成' : '复核不通过，请重新整改',
    rectification: enrichRectification(db.get('rectifications').find({ id }).value())
  });
});

module.exports = { router, createRectification, enrichRectification };
