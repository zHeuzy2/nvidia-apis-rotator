/**
 * Middleware de logging
 */

const logger = require('../utils/asyncLogger');

function requestLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || `req-${Date.now()}`;
  
  // Adiciona request ID ao req
  req.requestId = requestId;

  // Log da requisição
  logger.info(`${req.method} ${req.path}`, { requestId });

  // Intercepta o fim da resposta
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    logger[level.toLowerCase()](`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`, { requestId });
  });

  next();
}

module.exports = requestLogger;
