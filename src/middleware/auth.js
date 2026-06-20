const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = 'vending-machine-secret-key-2024';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.get('users').find({ id: decoded.id }).value();

    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }

    req.user = { id: user.id, username: user.username, role: user.role, name: user.name };
    next();
  } catch (error) {
    return res.status(401).json({ error: '令牌无效或已过期' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: '未认证' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole, generateToken, JWT_SECRET };
