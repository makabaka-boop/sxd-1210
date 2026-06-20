const express = require('express');
const db = require('../db');
const bcrypt = require('bcryptjs');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { generateId, getNowISO, getMachineInfo } = require('../utils/helpers');
const { getAllTimeLimits, ANOMALY_TYPES, RECTIFICATION_TYPES } = require('../utils/timeLimitUtils');

const router = express.Router();
router.use(authMiddleware, requireRole('admin'));

// 用户管理
router.get('/users', (req, res) => {
  const users = db.get('users')
    .map(u => ({ id: u.id, username: u.username, role: u.role, name: u.name, createdAt: u.createdAt }))
    .value();
  res.json(users);
});

router.post('/users', (req, res) => {
  const { username, password, role, name } = req.body;

  if (!username || !password || !role || !name) {
    return res.status(400).json({ error: '缺少必填字段' });
  }

  if (!['admin', 'restocker', 'inspector'].includes(role)) {
    return res.status(400).json({ error: '角色无效' });
  }

  const existing = db.get('users').find({ username }).value();
  if (existing) {
    return res.status(400).json({ error: '用户名已存在' });
  }

  const newUser = {
    id: generateId('user'),
    username,
    password: bcrypt.hashSync(password, 10),
    role,
    name,
    createdAt: getNowISO()
  };

  db.get('users').push(newUser).write();
  res.status(201).json({ id: newUser.id, username: newUser.username, role: newUser.role, name: newUser.name });
});

router.put('/users/:id', (req, res) => {
  const { id } = req.params;
  const { name, role, password } = req.body;

  const user = db.get('users').find({ id }).value();
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const updates = {};
  if (name) updates.name = name;
  if (role && ['admin', 'restocker', 'inspector'].includes(role)) updates.role = role;
  if (password) updates.password = bcrypt.hashSync(password, 10);

  db.get('users').find({ id }).assign(updates).write();
  res.json({ message: '更新成功' });
});

// 区域管理
router.get('/areas', (req, res) => {
  res.json(db.get('areas').value());
});

router.post('/areas', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: '区域名称必填' });

  const newArea = { id: generateId('area'), name, description: description || '' };
  db.get('areas').push(newArea).write();
  res.status(201).json(newArea);
});

router.put('/areas/:id', (req, res) => {
  const { id } = req.params;
  const { name, description } = req.body;

  const area = db.get('areas').find({ id }).value();
  if (!area) return res.status(404).json({ error: '区域不存在' });

  db.get('areas').find({ id }).assign({ name: name || area.name, description: description || area.description }).write();
  res.json({ message: '更新成功' });
});

router.delete('/areas/:id', (req, res) => {
  const { id } = req.params;
  const area = db.get('areas').find({ id }).value();
  if (!area) return res.status(404).json({ error: '区域不存在' });

  const machinesUsing = db.get('machines').filter({ areaId: id }).value().length;
  if (machinesUsing > 0) {
    return res.status(400).json({ error: '该区域下有机器，无法删除' });
  }

  db.get('areas').remove({ id }).write();
  res.json({ message: '删除成功' });
});

// 温区类型管理
router.get('/temperature-zones', (req, res) => {
  res.json(db.get('temperatureZones').value());
});

router.post('/temperature-zones', (req, res) => {
  const { name, minTemp, maxTemp } = req.body;
  if (!name || minTemp === undefined || maxTemp === undefined) {
    return res.status(400).json({ error: '名称和温度范围必填' });
  }

  const newTZ = { id: generateId('tz'), name, minTemp: Number(minTemp), maxTemp: Number(maxTemp) };
  db.get('temperatureZones').push(newTZ).write();
  res.status(201).json(newTZ);
});

router.put('/temperature-zones/:id', (req, res) => {
  const { id } = req.params;
  const tz = db.get('temperatureZones').find({ id }).value();
  if (!tz) return res.status(404).json({ error: '温区类型不存在' });

  const { name, minTemp, maxTemp } = req.body;
  db.get('temperatureZones').find({ id }).assign({
    name: name || tz.name,
    minTemp: minTemp !== undefined ? Number(minTemp) : tz.minTemp,
    maxTemp: maxTemp !== undefined ? Number(maxTemp) : tz.maxTemp
  }).write();
  res.json({ message: '更新成功' });
});

// 商品分组管理
router.get('/product-groups', (req, res) => {
  res.json(db.get('productGroups').value());
});

router.post('/product-groups', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: '分组名称必填' });

  const newPG = { id: generateId('pg'), name, description: description || '' };
  db.get('productGroups').push(newPG).write();
  res.status(201).json(newPG);
});

router.put('/product-groups/:id', (req, res) => {
  const { id } = req.params;
  const pg = db.get('productGroups').find({ id }).value();
  if (!pg) return res.status(404).json({ error: '分组不存在' });

  const { name, description } = req.body;
  db.get('productGroups').find({ id }).assign({ name: name || pg.name, description: description || pg.description }).write();
  res.json({ message: '更新成功' });
});

// 商品管理
router.get('/products', (req, res) => {
  const { groupId } = req.query;
  let products = db.get('products').value();

  if (groupId) {
    products = products.filter(p => p.groupId === groupId);
  }

  const productsWithGroup = products.map(p => {
    const group = db.get('productGroups').find({ id: p.groupId }).value();
    return { ...p, groupName: group ? group.name : null };
  });

  res.json(productsWithGroup);
});

router.post('/products', (req, res) => {
  const { name, groupId, shelfLifeDays } = req.body;
  if (!name || !groupId) return res.status(400).json({ error: '名称和分组必填' });

  const newProduct = {
    id: generateId('prod'),
    name,
    groupId,
    shelfLifeDays: Number(shelfLifeDays) || 180
  };
  db.get('products').push(newProduct).write();
  res.status(201).json(newProduct);
});

router.put('/products/:id', (req, res) => {
  const { id } = req.params;
  const product = db.get('products').find({ id }).value();
  if (!product) return res.status(404).json({ error: '商品不存在' });

  const { name, groupId, shelfLifeDays } = req.body;
  db.get('products').find({ id }).assign({
    name: name || product.name,
    groupId: groupId || product.groupId,
    shelfLifeDays: shelfLifeDays !== undefined ? Number(shelfLifeDays) : product.shelfLifeDays
  }).write();
  res.json({ message: '更新成功' });
});

// 路线管理
router.get('/routes', (req, res) => {
  const routes = db.get('routes').value().map(r => {
    const restocker = db.get('users').find({ id: r.restockerId }).value();
    return { ...r, restockerName: restocker ? restocker.name : null };
  });
  res.json(routes);
});

router.post('/routes', (req, res) => {
  const { name, description, restockerId } = req.body;
  if (!name) return res.status(400).json({ error: '路线名称必填' });

  const newRoute = {
    id: generateId('route'),
    name,
    description: description || '',
    restockerId: restockerId || null
  };
  db.get('routes').push(newRoute).write();
  res.status(201).json(newRoute);
});

router.put('/routes/:id', (req, res) => {
  const { id } = req.params;
  const route = db.get('routes').find({ id }).value();
  if (!route) return res.status(404).json({ error: '路线不存在' });

  const { name, description, restockerId } = req.body;
  db.get('routes').find({ id }).assign({
    name: name || route.name,
    description: description !== undefined ? description : route.description,
    restockerId: restockerId !== undefined ? restockerId : route.restockerId
  }).write();
  res.json({ message: '更新成功' });
});

// 机器管理
router.get('/machines', (req, res) => {
  const { areaId, routeId } = req.query;
  let machines = db.get('machines').value();

  if (areaId) machines = machines.filter(m => m.areaId === areaId);
  if (routeId) machines = machines.filter(m => m.routeId === routeId);

  const machinesWithInfo = machines.map(m => getMachineInfo(m.id));
  res.json(machinesWithInfo);
});

router.get('/machines/:id', (req, res) => {
  const { id } = req.params;
  const machine = getMachineInfo(id);
  if (!machine) return res.status(404).json({ error: '机器不存在' });
  res.json(machine);
});

router.post('/machines', (req, res) => {
  const { id, name, areaId, routeId, temperatureZoneId, inspectionCycleDays, threshold, status } = req.body;

  if (!id || !name || !areaId || !temperatureZoneId) {
    return res.status(400).json({ error: '机器编号、名称、区域、温区类型必填' });
  }

  const existing = db.get('machines').find({ id }).value();
  if (existing) return res.status(400).json({ error: '机器编号已存在' });

  const newMachine = {
    id,
    name,
    areaId,
    routeId: routeId || null,
    temperatureZoneId,
    inspectionCycleDays: Number(inspectionCycleDays) || 7,
    threshold: Number(threshold) || 20,
    status: status || 'active',
    createdAt: getNowISO()
  };
  db.get('machines').push(newMachine).write();
  res.status(201).json(getMachineInfo(id));
});

router.put('/machines/:id', (req, res) => {
  const { id } = req.params;
  const machine = db.get('machines').find({ id }).value();
  if (!machine) return res.status(404).json({ error: '机器不存在' });

  const { name, areaId, routeId, temperatureZoneId, inspectionCycleDays, threshold, status } = req.body;
  db.get('machines').find({ id }).assign({
    name: name || machine.name,
    areaId: areaId || machine.areaId,
    routeId: routeId !== undefined ? routeId : machine.routeId,
    temperatureZoneId: temperatureZoneId || machine.temperatureZoneId,
    inspectionCycleDays: inspectionCycleDays !== undefined ? Number(inspectionCycleDays) : machine.inspectionCycleDays,
    threshold: threshold !== undefined ? Number(threshold) : machine.threshold,
    status: status || machine.status
  }).write();
  res.json(getMachineInfo(id));
});

router.delete('/machines/:id', (req, res) => {
  const { id } = req.params;
  const machine = db.get('machines').find({ id }).value();
  if (!machine) return res.status(404).json({ error: '机器不存在' });

  db.get('machines').remove({ id }).write();
  res.json({ message: '删除成功' });
});

router.get('/rectification-time-limits/options', (req, res) => {
  res.json({
    anomalyTypes: Object.values(ANOMALY_TYPES),
    anomalySeverities: ['low', 'medium', 'high'],
    rectificationTypes: RECTIFICATION_TYPES,
    scopes: [
      { value: 'global', label: '全局默认' },
      { value: 'anomalyType', label: '按异常类型' },
      { value: 'anomalySeverity', label: '按异常严重程度' },
      { value: 'rectificationType', label: '按整改类型' }
    ]
  });
});

router.get('/rectification-time-limits', (req, res) => {
  const limits = getAllTimeLimits();
  res.json(limits);
});

router.post('/rectification-time-limits', (req, res) => {
  const { name, scope, scopeValue, rectifyHours, reviewHours, reopenRectifyHours, escalationHours, enabled } = req.body;

  if (!name || !scope || !scopeValue) {
    return res.status(400).json({ error: '名称、范围类型、范围值必填' });
  }

  const validScopes = ['global', 'anomalyType', 'anomalySeverity', 'rectificationType'];
  if (!validScopes.includes(scope)) {
    return res.status(400).json({ error: '无效的范围类型' });
  }

  if (rectifyHours === undefined || reviewHours === undefined) {
    return res.status(400).json({ error: '整改时限和复核时限必填' });
  }

  if (scope === 'global' && scopeValue === 'default') {
    const existingDefault = db.get('rectificationTimeLimits')
      .find({ scope: 'global', scopeValue: 'default' })
      .value();
    if (existingDefault) {
      return res.status(400).json({ error: '全局默认配置已存在，请修改而非新增' });
    }
  } else {
    const existing = db.get('rectificationTimeLimits')
      .find({ scope, scopeValue })
      .value();
    if (existing) {
      return res.status(400).json({ error: '该范围配置已存在，请修改而非新增' });
    }
  }

  const newLimit = {
    id: generateId('tl'),
    name,
    scope,
    scopeValue,
    rectifyHours: Number(rectifyHours),
    reviewHours: Number(reviewHours),
    reopenRectifyHours: Number(reopenRectifyHours) || Number(rectifyHours),
    escalationHours: Number(escalationHours) || Number(reviewHours),
    enabled: enabled !== undefined ? enabled : true,
    createdAt: getNowISO(),
    updatedAt: getNowISO()
  };

  db.get('rectificationTimeLimits').push(newLimit).write();
  res.status(201).json(newLimit);
});

router.put('/rectification-time-limits/:id', (req, res) => {
  const { id } = req.params;
  const { name, rectifyHours, reviewHours, reopenRectifyHours, escalationHours, enabled } = req.body;

  const limit = db.get('rectificationTimeLimits').find({ id }).value();
  if (!limit) return res.status(404).json({ error: '时限配置不存在' });

  const updates = { updatedAt: getNowISO() };
  if (name !== undefined) updates.name = name;
  if (rectifyHours !== undefined) updates.rectifyHours = Number(rectifyHours);
  if (reviewHours !== undefined) updates.reviewHours = Number(reviewHours);
  if (reopenRectifyHours !== undefined) updates.reopenRectifyHours = Number(reopenRectifyHours);
  if (escalationHours !== undefined) updates.escalationHours = Number(escalationHours);
  if (enabled !== undefined) updates.enabled = enabled;

  db.get('rectificationTimeLimits').find({ id }).assign(updates).write();
  res.json({ message: '更新成功', limit: db.get('rectificationTimeLimits').find({ id }).value() });
});

router.delete('/rectification-time-limits/:id', (req, res) => {
  const { id } = req.params;
  const limit = db.get('rectificationTimeLimits').find({ id }).value();
  if (!limit) return res.status(404).json({ error: '时限配置不存在' });

  if (limit.scope === 'global' && limit.scopeValue === 'default') {
    return res.status(400).json({ error: '全局默认配置不允许删除' });
  }

  db.get('rectificationTimeLimits').remove({ id }).write();
  res.json({ message: '删除成功' });
});

module.exports = router;
