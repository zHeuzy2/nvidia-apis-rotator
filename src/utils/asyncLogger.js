/**
 * Async Logger - Reduces blocking console.log overhead
 * Batches logging and writes asynchronously to improve performance
 */

const logLevels = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

class AsyncLogger {
  constructor(options = {}) {
    this.logQueue = [];
    this.isProcessing = false;
    this.batchSize = options.batchSize || 10;
    this.flushInterval = options.flushInterval || 100; // ms
    this.minLogLevel = logLevels[options.level?.toUpperCase()] || logLevels.INFO;
    this.useColors = options.useColors !== false;
    
    // Start periodic flush
    setInterval(() => this.flush(), this.flushInterval);
    
    // Process queue on exit
    this.setupGracefulShutdown();
  }

  log(level, message, data) {
    if (logLevels[level] < this.minLogLevel) return;
    
    this.logQueue.push({
      level,
      message,
      data,
      timestamp: new Date().toISOString()
    });

    if (this.logQueue.length >= this.batchSize) {
      this.flush();
    }
  }

  flush() {
    if (this.isProcessing || this.logQueue.length === 0) return;
    
    this.isProcessing = true;
    const logsToFlush = this.logQueue.splice(0);
    
    // Write synchronously but in batch to reduce overall blocking
    setImmediate(() => {
      try {
        for (const log of logsToFlush) {
          this.writeToConsole(log);
        }
      } catch (err) {
        // Silent failure to avoid infinite loops
      } finally {
        this.isProcessing = false;
      }
    });
  }

  writeToConsole(log) {
    const prefix = this.formatPrefix(log.level, log.timestamp);
    const msg = `${prefix} ${log.message}`;
    
    if (log.data) {
      console.log(msg, log.data);
    } else {
      console.log(msg);
    }
  }

  formatPrefix(level, timestamp) {
    const colorCode = this.useColors ? this.getLevelColor(level) : '';
    const resetCode = this.useColors ? '\x1b[0m' : '';
    return `\x1b[90m[${timestamp}]\x1b[0m ${colorCode}[${level}]${resetCode}`;
  }

  getLevelColor(level) {
    const colors = {
      DEBUG: '\x1b[36m',   // Cyan
      INFO: '\x1b[32m',    // Green
      WARN: '\x1b[33m',    // Yellow
      ERROR: '\x1b[31m'    // Red
    };
    return colors[level] || '';
  }

  debug(message, data) {
    this.log('DEBUG', message, data);
  }

  info(message, data) {
    this.log('INFO', message, data);
  }

  warn(message, data) {
    this.log('WARN', message, data);
  }

  error(message, data) {
    this.log('ERROR', message, data);
  }

  setupGracefulShutdown() {
    const flushAndExit = () => {
      this.flush();
      this.isProcessing = false;
      this.flushSync(); // Final flush before exit
    };

    process.on('exit', flushAndExit);
    process.on('SIGINT', () => {
      flushAndExit();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      flushAndExit();
      process.exit(0);
    });
  }

  flushSync() {
    while (this.logQueue.length > 0) {
      const log = this.logQueue.shift();
      this.writeToConsole(log);
    }
  }
}

// Create singleton instance
// Optimized for production: larger batch and longer interval = less CPU overhead
const logger = new AsyncLogger({
  level: process.env.LOG_LEVEL || 'INFO',
  batchSize: process.env.NODE_ENV === 'production' ? 50 : 10,
  flushInterval: process.env.NODE_ENV === 'production' ? 200 : 50
});

module.exports = logger;