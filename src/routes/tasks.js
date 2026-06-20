const express = require('express');
const db = require('../db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { generateId, getNowISO, getDateString, getMachineInfo } = require('../utils/helpers');
const { detectAndSave, TASK_STATUS } = require('../utils/anomalyDetector');
const { enrichRectification } = require('./rectifications');

const router = express.Router();
router.use(authMiddleware);

const VALID_STATUSES = ['待补货', '补货中', '待抽检', '温区异常', '缺品预警', '已完成', '暂停运营', '整改中', '整改待复核'];
const VALID_WINDOWS = ['早班', '中班', '晚班'];

function enrichTask(task) {
  const machineInfo = getMachineInfo(task.machineId);
  const restocker = task.assigneeId ? db.get('users').find({ id: task.assigneeId }).value() : null;
  const route = task.routeId ? db.get('routes').find({ id: task.routeId }).value() : null;

  return {
    ...task,
    machineName: machineInfo ? machineInfo.name : null,
    areaId: machineInfo ? machineInfo.areaId : null,
    areaName: machineInfo ? machineInfo.areaName : null,
    routeName: route ? route.name : null,
    assigneeName: restocker ? restocker.name : null,
    temperatureZoneId: machineInfo ? machineInfo.temperatureZoneId : null,
    temperatureZoneName: machineInfo ? machineInfo.temperatureZoneName : null
  };
}

// 生成补货任务
router.post('/generate', requireRole('admin', 'restocker'), (req, res) => {
  const { machineId, scheduledTime, window, note } = req.body;

  if (!machineId) {
    return res.status(400).json({ error: '机器编号必填' });
  }

  const machine = db.get('machines').find({ id: machineId }).value();
  if (!machine) {
    return res.status(404).json({ error: '机器不存在' });
  }

  const taskWindow = window || '早班';
  if (!VALID_WINDOWS.includes(taskWindow)) {
    return res.status(400).json({ error: '补货窗口无效，可选：早班、中班、晚班' });
  }

  const scheduled = scheduledTime || getNowISO();
  const scheduledDate = getDateString(new Date(scheduled));

  const duplicateTask = db.get('tasks')
    .find(t =>
      t.machineId === machineId &&
      t.window === taskWindow &&
      getDateString(new Date(t.scheduledTime)) === scheduledDate
    )
    .value();

  if (duplicateTask) {
    return res.status(400).json({
      error: '该机器当日同一补货窗口已存在任务',
      existingTaskId: duplicateTask.id
    });
  }

  const route = db.get('routes').find({ id: machine.routeId }).value();

  const newTask = {
    id: generateId('task'),
    machineId,
    routeId: machine.routeId || null,
    assigneeId: route ? route.restockerId : null,
    status: '待补货',
    window: taskWindow,
    scheduledTime: scheduled,
    arrivedTime: null,
    completedTime: null,
    inspected: false,
    note: note || '',
    createdBy: req.user.id,
    createdAt: getNowISO()
  };

  db.get('tasks').push(newTask).write();

  setTimeout(() => detectAndSave(), 100);

  res.status(201).json(enrichTask(newTask));
});

// 批量生成任务
router.post('/generate-batch', requireRole('admin'), (req, res) => {
  const { machineIds, scheduledTime, window, routeId, areaId } = req.body;
  const taskWindow = window || '早班';

  if (!VALID_WINDOWS.includes(taskWindow)) {
    return res.status(400).json({ error: '补货窗口无效' });
  }

  let targetMachineIds = machineIds || [];

  if (!targetMachineIds.length && (routeId || areaId)) {
    let machines = db.get('machines').value();
    if (routeId) machines = machines.filter(m => m.routeId === routeId);
    if (areaId) machines = machines.filter(m => m.areaId === areaId);
    targetMachineIds = machines.map(m => m.id);
  }

  if (!targetMachineIds.length) {
    return res.status(400).json({ error: '未指定任何机器' });
  }

  const scheduled = scheduledTime || getNowISO();
  const scheduledDate = getDateString(new Date(scheduled));
  const createdTasks = [];
  const skippedMachines = [];

  for (const machineId of targetMachineIds) {
    const machine = db.get('machines').find({ id: machineId }).value();
    if (!machine) {
      skippedMachines.push({ machineId, reason: '机器不存在' });
      continue;
    }

    const duplicateTask = db.get('tasks')
      .find(t =>
        t.machineId === machineId &&
        t.window === taskWindow &&
        getDateString(new Date(t.scheduledTime)) === scheduledDate
      )
      .value();

    if (duplicateTask) {
      skippedMachines.push({ machineId, reason: '当日同窗口任务已存在' });
      continue;
    }

    const route = db.get('routes').find({ id: machine.routeId }).value();

    const newTask = {
      id: generateId('task'),
      machineId,
      routeId: machine.routeId || null,
      assigneeId: route ? route.restockerId : null,
      status: '待补货',
      window: taskWindow,
      scheduledTime: scheduled,
      arrivedTime: null,
      completedTime: null,
      inspected: false,
      note: '',
      createdBy: req.user.id,
      createdAt: getNowISO()
    };

    db.get('tasks').push(newTask).write();
    createdTasks.push(enrichTask(newTask));
  }

  setTimeout(() => detectAndSave(), 100);

  res.json({
    createdCount: createdTasks.length,
    skippedCount: skippedMachines.length,
    createdTasks,
    skippedMachines
  });
});

// 查询任务列表
router.get('/', (req, res) => {
  const {
    areaId, machineId, groupId, restockerId, status,
    startDate, endDate, window, page, pageSize
  } = req.query;

  let tasks = db.get('tasks').value();

  if (machineId) tasks = tasks.filter(t => t.machineId === machineId);
  if (status) tasks = tasks.filter(t => t.status === status);
  if (window) tasks = tasks.filter(t => t.window === window);
  if (restockerId) tasks = tasks.filter(t => t.assigneeId === restockerId);

  if (startDate) {
    tasks = tasks.filter(t => new Date(t.scheduledTime) >= new Date(startDate));
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    tasks = tasks.filter(t => new Date(t.scheduledTime) <= end);
  }

  let enrichedTasks = tasks.map(t => enrichTask(t));

  if (areaId) {
    enrichedTasks = enrichedTasks.filter(t => t.areaId === areaId);
  }

  if (groupId) {
    enrichedTasks = enrichedTasks.filter(t => {
      const restockRecords = db.get('restockRecords').filter({ taskId: t.id }).value();
      if (restockRecords.length === 0) return false;
      return restockRecords.some(r =>
        r.items && r.items.some(item => {
          const product = db.get('products').find({ id: item.productId }).value();
          return product && product.groupId === groupId;
        })
      );
    });
  }

  enrichedTasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const currentPage = parseInt(page) || 1;
  const size = parseInt(pageSize) || 50;
  const total = enrichedTasks.length;
  const totalPages = Math.ceil(total / size);
  const paginatedTasks = enrichedTasks.slice((currentPage - 1) * size, currentPage * size);

  res.json({
    total,
    totalPages,
    currentPage,
    pageSize: size,
    data: paginatedTasks
  });
});

// 获取单个任务详情
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const task = db.get('tasks').find({ id }).value();

  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  const enriched = enrichTask(task);
  const restockRecords = db.get('restockRecords').filter({ taskId: id }).value();
  const temperatureRecords = db.get('temperatureRecords').filter({ taskId: id }).value();
  const expiredRemovals = db.get('expiredRemovals').filter({ taskId: id }).value();
  const inspections = db.get('inspections').filter({ taskId: id }).value();
  const rectifications = db.get('rectifications').filter({ taskId: id }).value();
  const enrichedRectifications = rectifications.map(r => enrichRectification(r));

  res.json({
    ...enriched,
    restockRecords,
    temperatureRecords,
    expiredRemovals,
    inspections,
    rectifications: enrichedRectifications
  });
});

// 更新任务状态
router.put('/:id/status', requireRole('admin', 'restocker', 'inspector'), (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body;

  const task = db.get('tasks').find({ id }).value();
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: '状态值无效' });
  }

  if (req.user.role === 'restocker' && task.assigneeId && task.assigneeId !== req.user.id) {
    return res.status(403).json({ error: '无权限操作此任务' });
  }

  const updates = {};
  if (status) updates.status = status;
  if (note !== undefined) updates.note = note;

  db.get('tasks').find({ id }).assign(updates).write();

  setTimeout(() => detectAndSave(), 100);

  res.json(enrichTask(db.get('tasks').find({ id }).value()));
});

// 删除任务
router.delete('/:id', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const task = db.get('tasks').find({ id }).value();
  if (!task) {
    return res.status(404).json({ error: '任务不存在' });
  }

  db.get('tasks').remove({ id }).write();
  res.json({ message: '删除成功' });
});

module.exports = router;
