const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const taskRoutes = require('./routes/tasks');
const restockerRoutes = require('./routes/restocker');
const inspectorRoutes = require('./routes/inspector');
const anomalyRoutes = require('./routes/anomalies');
const reportRoutes = require('./routes/reports');
const { router: rectificationRoutes } = require('./routes/rectifications');

const { detectAndSave } = require('./utils/anomalyDetector');
const { processAllOverdueRectifications } = require('./routes/rectifications');

const app = express();
const PORT = process.env.PORT || 8142;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/', (req, res) => {
  res.json({
    name: '自助售货机补货管理系统',
    version: '1.0.0',
    description: 'Vending Machine Restock Management System',
    endpoints: {
      auth: '/api/auth',
      admin: '/api/admin',
      tasks: '/api/tasks',
      restocker: '/api/restocker',
      inspector: '/api/inspector',
      anomalies: '/api/anomalies',
      reports: '/api/reports',
      rectifications: '/api/rectifications'
    },
    defaultAccounts: {
      admin: { username: 'admin', password: 'admin123', role: '平台管理员' },
      restocker: { username: 'restocker', password: 'restock123', role: '补货员' },
      inspector: { username: 'inspector', password: 'inspect123', role: '督导' }
    }
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/restocker', restockerRoutes);
app.use('/api/inspector', inspectorRoutes);
app.use('/api/anomalies', anomalyRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/rectifications', rectificationRoutes);

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: '服务器内部错误',
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  自助售货机补货管理系统已启动`);
  console.log(`  服务地址: http://localhost:${PORT}`);
  console.log(`========================================\n`);
  console.log(`默认账号:`);
  console.log(`  管理员: admin / admin123`);
  console.log(`  补货员: restocker / restock123`);
  console.log(`  督导: inspector / inspect123\n`);

  setTimeout(() => {
    try {
      detectAndSave();
      console.log('[系统] 初始异常检测完成');
    } catch (e) {
      console.error('[系统] 初始异常检测失败:', e.message);
    }
    try {
      const overdueCount = processAllOverdueRectifications();
      if (overdueCount > 0) {
        console.log(`[系统] 初始逾期处理完成，更新 ${overdueCount} 条记录`);
      }
    } catch (e) {
      console.error('[系统] 初始逾期处理失败:', e.message);
    }
  }, 1000);

  setInterval(() => {
    try {
      detectAndSave();
    } catch (e) {
    }
  }, 5 * 60 * 1000);

  setInterval(() => {
    try {
      const count = processAllOverdueRectifications();
      if (count > 0) {
        console.log(`[系统] 定时逾期处理完成，更新 ${count} 条记录`);
      }
    } catch (e) {
    }
  }, 60 * 60 * 1000);
});

module.exports = app;
