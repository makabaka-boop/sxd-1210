const db = require('../db');
const { generateId, getNowISO, getDateString, daysBetween, getMachineInfo } = require('./helpers');

const TASK_STATUS = {
  PENDING_RESTOCK: '待补货',
  RESTOCKING: '补货中',
  PENDING_INSPECTION: '待抽检',
  TEMP_ABNORMAL: '温区异常',
  STOCK_SHORTAGE: '缺品预警',
  COMPLETED: '已完成',
  SUSPENDED: '暂停运营'
};

const ANOMALY_TYPES = {
  CONSECUTIVE_SHORTAGE: '连续缺品',
  TEMP_ABNORMAL: '温区读数异常',
  EXPIRED_OMISSION: '临期处理遗漏',
  TASK_TIMEOUT: '路线任务超时',
  INSPECTION_MISSING: '督导抽检缺失'
};

function detectConsecutiveShortage() {
  const anomalies = [];
  const machines = db.get('machines').value();

  for (const machine of machines) {
    const recentRecords = db.get('restockRecords')
      .filter({ machineId: machine.id })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .take(3)
      .value();

    if (recentRecords.length >= 3) {
      const allShortage = recentRecords.every(r =>
        r.items && r.items.some(item => (item.shortageQuantity || 0) > 0)
      );

      if (allShortage) {
        anomalies.push({
          machineId: machine.id,
          machineName: machine.name,
          type: ANOMALY_TYPES.CONSECUTIVE_SHORTAGE,
          description: `机器 ${machine.name} 连续3次记录存在缺品`,
          severity: 'high',
          detectedAt: getNowISO()
        });
      }
    }
  }
  return anomalies;
}

function detectTemperatureAbnormal() {
  const anomalies = [];
  const machines = db.get('machines').value();

  for (const machine of machines) {
    const machineInfo = getMachineInfo(machine.id);
    if (!machineInfo) continue;

    const latestTemp = db.get('temperatureRecords')
      .filter({ machineId: machine.id })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .first()
      .value();

    if (latestTemp && machineInfo.minTemp !== null && machineInfo.maxTemp !== null) {
      if (latestTemp.temperature < machineInfo.minTemp || latestTemp.temperature > machineInfo.maxTemp) {
        anomalies.push({
          machineId: machine.id,
          machineName: machine.name,
          type: ANOMALY_TYPES.TEMP_ABNORMAL,
          description: `机器 ${machine.name} 温度 ${latestTemp.temperature}°C 超出范围 [${machineInfo.minTemp}, ${machineInfo.maxTemp}]°C`,
          severity: 'high',
          detectedAt: getNowISO(),
          detail: {
            temperature: latestTemp.temperature,
            minTemp: machineInfo.minTemp,
            maxTemp: machineInfo.maxTemp
          }
        });
      }
    }
  }
  return anomalies;
}

function detectExpiredOmission() {
  const anomalies = [];
  const today = getDateString();

  const pendingTasks = db.get('tasks')
    .filter(t => ['待补货', '补货中', '待抽检'].includes(t.status))
    .value();

  for (const task of pendingTasks) {
    const products = db.get('products').value();
    const machineInfo = getMachineInfo(task.machineId);

    const restockRecords = db.get('restockRecords')
      .filter({ taskId: task.id })
      .value();

    const expiredRemovals = db.get('expiredRemovals')
      .filter({ taskId: task.id })
      .value();

    const shortShelfProducts = products.filter(p => p.shelfLifeDays <= 60);

    if (shortShelfProducts.length > 0 && expiredRemovals.length === 0 && restockRecords.length > 0) {
      anomalies.push({
        machineId: task.machineId,
        machineName: machineInfo ? machineInfo.name : task.machineId,
        taskId: task.id,
        type: ANOMALY_TYPES.EXPIRED_OMISSION,
        description: `任务 ${task.id} 存在短保质期商品但未记录临期移出`,
        severity: 'medium',
        detectedAt: getNowISO()
      });
    }
  }
  return anomalies;
}

function detectTaskTimeout() {
  const anomalies = [];
  const now = new Date();

  const pendingTasks = db.get('tasks')
    .filter(t => ['待补货', '补货中'].includes(t.status))
    .value();

  for (const task of pendingTasks) {
    if (task.scheduledTime) {
      const scheduled = new Date(task.scheduledTime);
      const hoursDiff = (now - scheduled) / (1000 * 60 * 60);

      if (hoursDiff > 8) {
        const machineInfo = getMachineInfo(task.machineId);
        anomalies.push({
          machineId: task.machineId,
          machineName: machineInfo ? machineInfo.name : task.machineId,
          taskId: task.id,
          type: ANOMALY_TYPES.TASK_TIMEOUT,
          description: `任务 ${task.id} 超时 ${Math.floor(hoursDiff)} 小时未完成`,
          severity: 'medium',
          detectedAt: getNowISO(),
          detail: { hoursOverdue: Math.floor(hoursDiff) }
        });
      }
    }
  }
  return anomalies;
}

function detectInspectionMissing() {
  const anomalies = [];
  const now = new Date();

  const completedTasks = db.get('tasks')
    .filter(t => t.status === '已完成' && !t.inspected)
    .value();

  for (const task of completedTasks) {
    if (task.completedAt) {
      const completed = new Date(task.completedAt);
      const daysDiff = daysBetween(completed, now);

      if (daysDiff >= 2) {
        const machineInfo = getMachineInfo(task.machineId);
        anomalies.push({
          machineId: task.machineId,
          machineName: machineInfo ? machineInfo.name : task.machineId,
          taskId: task.id,
          type: ANOMALY_TYPES.INSPECTION_MISSING,
          description: `任务 ${task.id} 完成已 ${daysDiff} 天未进行督导抽检`,
          severity: 'medium',
          detectedAt: getNowISO(),
          detail: { daysSinceCompleted: daysDiff }
        });
      }
    }
  }

  return anomalies;
}

function runAllDetectors() {
  const allAnomalies = [];

  allAnomalies.push(...detectConsecutiveShortage());
  allAnomalies.push(...detectTemperatureAbnormal());
  allAnomalies.push(...detectExpiredOmission());
  allAnomalies.push(...detectTaskTimeout());
  allAnomalies.push(...detectInspectionMissing());

  return allAnomalies;
}

function saveAnomalies(anomalies) {
  const existingAnomalies = db.get('anomalies').value();
  const today = getDateString();

  for (const anomaly of anomalies) {
    const isDuplicate = existingAnomalies.some(ea =>
      ea.type === anomaly.type &&
      ea.machineId === anomaly.machineId &&
      ea.taskId === anomaly.taskId &&
      getDateString(ea.detectedAt) === today
    );

    if (!isDuplicate) {
      db.get('anomalies')
        .push({
          id: generateId('anomaly'),
          ...anomaly,
          resolved: false,
          createdAt: getNowISO()
        })
        .write();
    }
  }
}

function detectAndSave() {
  const anomalies = runAllDetectors();
  saveAnomalies(anomalies);
  return anomalies;
}

module.exports = {
  TASK_STATUS,
  ANOMALY_TYPES,
  detectConsecutiveShortage,
  detectTemperatureAbnormal,
  detectExpiredOmission,
  detectTaskTimeout,
  detectInspectionMissing,
  runAllDetectors,
  saveAnomalies,
  detectAndSave
};
