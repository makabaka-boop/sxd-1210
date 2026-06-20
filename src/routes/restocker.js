const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { generateId, getNowISO, getMachineInfo } = require('../utils/helpers');
const { detectAndSave } = require('../utils/anomalyDetector');

const router = express.Router();
router.use(authMiddleware, requireRole('restocker', 'admin'));

// 补货员查看自己的任务
router.get('/my-tasks', (req, res) => {
  const { status } = req.query;
  let tasks = db.get('tasks')
    .filter(t => t.assigneeId === req.user.id || req.user.role === 'admin')
    .value();

  if (status) {
    tasks = tasks.filter(t => t.status === status);
  }

  const enriched = tasks.map(t => {
    const machineInfo = getMachineInfo(t.machineId);
    return {
      ...t,
      machineName: machineInfo ? machineInfo.name : null,
      areaName: machineInfo ? machineInfo.areaName : null
    };
  }).sort((a, b) => new Date(b.scheduledTime) - new Date(a.scheduledTime));

  res.json(enriched);
});

// 记录到达
router.post('/tasks/:id/arrive', (req, res) => {
  const { id } = req.params;
  const { photoUrl } = req.body;

  const task = db.get('tasks').find({ id }).value();
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  if (req.user.role === 'restocker' && task.assigneeId && task.assigneeId !== req.user.id) {
    return res.status(403).json({ error: '无权限操作此任务' });
  }

  if (!['待补货', '缺品预警', '整改中'].includes(task.status)) {
    return res.status(400).json({ error: '当前任务状态不允许执行到达操作' });
  }

  db.get('tasks')
    .find({ id })
    .assign({
      status: '补货中',
      arrivedTime: getNowISO(),
      arrivePhotoUrl: photoUrl || null
    })
    .write();

  setTimeout(() => detectAndSave(), 100);

  res.json({
    message: '到达记录成功',
    task: db.get('tasks').find({ id }).value()
  });
});

// 记录补货
router.post('/tasks/:id/restock', (req, res) => {
  const { id } = req.params;
  const { items, note, photoUrl } = req.body;

  const task = db.get('tasks').find({ id }).value();
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  if (req.user.role === 'restocker' && task.assigneeId && task.assigneeId !== req.user.id) {
    return res.status(403).json({ error: '无权限操作此任务' });
  }

  if (task.status !== '补货中' && task.status !== '整改中') {
    return res.status(400).json({ error: '请先执行到达操作' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '请填写补货明细' });
  }

  const validatedItems = items.map(item => {
    const product = db.get('products').find({ id: item.productId }).value();
    return {
      productId: item.productId,
      productName: product ? product.name : item.productId,
      restockQuantity: Number(item.restockQuantity) || 0,
      shortageQuantity: Number(item.shortageQuantity) || 0,
      shortageReason: item.shortageReason || ''
    };
  });

  const hasShortage = validatedItems.some(i => i.shortageQuantity > 0);

  const record = {
    id: generateId('restock'),
    taskId: id,
    machineId: task.machineId,
    items: validatedItems,
    note: note || '',
    photoUrl: photoUrl || null,
    operatorId: req.user.id,
    createdAt: getNowISO()
  };

  db.get('restockRecords').push(record).write();

  if (hasShortage) {
    db.get('tasks').find({ id }).assign({ status: '缺品预警' }).write();
  }

  setTimeout(() => detectAndSave(), 100);

  res.status(201).json(record);
});

// 记录临期商品移出
router.post('/tasks/:id/expired-removal', (req, res) => {
  const { id } = req.params;
  const { items, note, photoUrl } = req.body;

  const task = db.get('tasks').find({ id }).value();
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  if (req.user.role === 'restocker' && task.assigneeId && task.assigneeId !== req.user.id) {
    return res.status(403).json({ error: '无权限操作此任务' });
  }

  if (!['补货中', '缺品预警', '整改中'].includes(task.status)) {
    return res.status(400).json({ error: '当前任务状态不允许此操作' });
  }

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '请填写移出明细' });
  }

  const validatedItems = items.map(item => {
    const product = db.get('products').find({ id: item.productId }).value();
    return {
      productId: item.productId,
      productName: product ? product.name : item.productId,
      quantity: Number(item.quantity) || 0,
      expiryDate: item.expiryDate || '',
      reason: item.reason || '临期'
    };
  });

  const removal = {
    id: generateId('expired'),
    taskId: id,
    machineId: task.machineId,
    items: validatedItems,
    note: note || '',
    photoUrl: photoUrl || null,
    operatorId: req.user.id,
    createdAt: getNowISO()
  };

  db.get('expiredRemovals').push(removal).write();

  setTimeout(() => detectAndSave(), 100);

  res.status(201).json(removal);
});

// 记录温区点检
router.post('/tasks/:id/temperature', (req, res) => {
  const { id } = req.params;
  const { temperature, zoneId, note, photoUrl } = req.body;

  const task = db.get('tasks').find({ id }).value();
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  if (req.user.role === 'restocker' && task.assigneeId && task.assigneeId !== req.user.id) {
    return res.status(403).json({ error: '无权限操作此任务' });
  }

  if (!['补货中', '缺品预警', '整改中'].includes(task.status)) {
    return res.status(400).json({ error: '当前任务状态不允许此操作' });
  }

  if (temperature === undefined || temperature === null) {
    return res.status(400).json({ error: '温度读数必填' });
  }

  const machine = getMachineInfo(task.machineId);
  const temp = Number(temperature);
  let isAbnormal = false;

  if (machine && machine.minTemp !== null && machine.maxTemp !== null) {
    isAbnormal = temp < machine.minTemp || temp > machine.maxTemp;
  }

  const record = {
    id: generateId('temp'),
    taskId: id,
    machineId: task.machineId,
    temperature: temp,
    zoneId: zoneId || (machine ? machine.temperatureZoneId : null),
    zoneName: machine ? machine.temperatureZoneName : null,
    isAbnormal,
    minTemp: machine ? machine.minTemp : null,
    maxTemp: machine ? machine.maxTemp : null,
    note: note || '',
    photoUrl: photoUrl || null,
    operatorId: req.user.id,
    createdAt: getNowISO()
  };

  db.get('temperatureRecords').push(record).write();

  if (isAbnormal) {
    db.get('tasks').find({ id }).assign({ status: '温区异常' }).write();
  }

  setTimeout(() => detectAndSave(), 100);

  res.status(201).json(record);
});

// 提交任务完成（等待抽检）
router.post('/tasks/:id/complete', (req, res) => {
  const { id } = req.params;
  const { finalNote, photoUrl } = req.body;

  const task = db.get('tasks').find({ id }).value();
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  if (req.user.role === 'restocker' && task.assigneeId && task.assigneeId !== req.user.id) {
    return res.status(403).json({ error: '无权限操作此任务' });
  }

  if (!['补货中', '缺品预警', '温区异常', '整改中'].includes(task.status)) {
    return res.status(400).json({ error: '当前任务状态不允许提交完成' });
  }

  const tempRecords = db.get('temperatureRecords').filter({ taskId: id }).value();
  if (tempRecords.length === 0) {
    return res.status(400).json({ error: '请先完成温区点检' });
  }

  db.get('tasks')
    .find({ id })
    .assign({
      status: '待抽检',
      completedTime: getNowISO(),
      finalNote: finalNote || '',
      completePhotoUrl: photoUrl || null
    })
    .write();

  setTimeout(() => detectAndSave(), 100);

  res.json({
    message: '任务已提交，等待督导抽检',
    task: db.get('tasks').find({ id }).value()
  });
});

// 查看机器的历史记录
router.get('/machines/:machineId/history', (req, res) => {
  const { machineId } = req.params;
  const { limit } = req.query;

  const machine = db.get('machines').find({ id: machineId }).value();
  if (!machine) {
    return res.status(404).json({ error: '机器不存在' });
  }

  const maxCount = parseInt(limit) || 20;
  const tasks = db.get('tasks')
    .filter({ machineId })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .take(maxCount)
    .value();

  const enrichedTasks = tasks.map(t => {
    const restockRecords = db.get('restockRecords').filter({ taskId: t.id }).value();
    const tempRecords = db.get('temperatureRecords').filter({ taskId: t.id }).value();
    const expiredRemovals = db.get('expiredRemovals').filter({ taskId: t.id }).value();
    const inspections = db.get('inspections').filter({ taskId: t.id }).value();

    return {
      ...t,
      restockRecords,
      tempRecords,
      expiredRemovals,
      inspections
    };
  });

  res.json(enrichedTasks);
});

module.exports = router;
