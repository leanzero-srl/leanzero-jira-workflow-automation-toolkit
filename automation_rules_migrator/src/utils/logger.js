/**
 * Logger utility for evidence and audit trails
 */

const winston = require("winston");
const path = require("path");

const EVIDENCE_LOG_FILE = "automation_migration_evidence.log";

/**
 * Configure comprehensive logging for evidence and audit trails
 * @returns {winston.Logger} Configured logger instance
 */
function setupEvidenceLogging() {
  const logger = winston.createLogger({
    level: "debug",
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
    ),
    transports: [
      // Console handler for user feedback
      new winston.transports.Console({
        level: "info",
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} - ${level} - ${message}`;
          }),
        ),
      }),
      // File handler for evidence (detailed logging)
      new winston.transports.File({
        filename: EVIDENCE_LOG_FILE,
        level: "debug",
        options: { flags: "a" },
        format: winston.format.combine(
          winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
          winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} - automation_migrator - ${level.toUpperCase()} - ${message}`;
          }),
        ),
      }),
    ],
  });

  return logger;
}

// Create and export singleton logger
const logger = setupEvidenceLogging();

/**
 * Log evidence for audit trails
 * @param {string} action - Action being performed
 * @param {Object} details - Details about the action
 */
function logEvidence(action, details) {
  const evidence = {
    timestamp: new Date().toISOString(),
    action,
    details,
  };
  logger.debug(`EVIDENCE: ${JSON.stringify(evidence)}`);
}

module.exports = { logger, EVIDENCE_LOG_FILE, logEvidence };
