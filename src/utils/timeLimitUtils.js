const db = require('../db');
const { ANOMALY_TYPES } = require('./anomalyDetector');

const RECTIFICATION_TYPES = ['待整改'];

function getAllTimeLimits() {
  return db.get('rectificationTimeLimits').value() || [];
}

function getEnabledTimeLimits() {
  return getAllTimeLimits().filter(tl => tl.enabled);
}

function matchTimeLimit({ anomalyType, anomalySeverity, rectificationType }) {
  const enabled = getEnabledTimeLimits();

  let matched = enabled.find(tl =>
    tl.scope === 'anomalyType' && anomalyType && tl.scopeValue === anomalyType
  );

  if (!matched) {
    matched = enabled.find(tl =>
      tl.scope === 'anomalySeverity' && anomalySeverity && tl.scopeValue === anomalySeverity
    );
  }

  if (!matched) {
    matched = enabled.find(tl =>
      tl.scope === 'rectificationType' && rectificationType && tl.scopeValue === rectificationType
    );
  }

  if (!matched) {
    matched = enabled.find(tl => tl.scope === 'global' && tl.scopeValue === 'default');
  }

  return matched || {
    rectifyHours: 48,
    reviewHours: 24,
    reopenRectifyHours: 24,
    escalationHours: 24
  };
}

function getInitialRiskLevel({ anomalySeverity }) {
  if (anomalySeverity === 'high') return 'high';
  if (anomalySeverity === 'medium') return 'medium';
  return 'low';
}

module.exports = {
  getAllTimeLimits,
  getEnabledTimeLimits,
  matchTimeLimit,
  getInitialRiskLevel,
  ANOMALY_TYPES,
  RECTIFICATION_TYPES
};
