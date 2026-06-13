/**
 * Middleware de tratamento de erros
 */

function errorHandler(err, req, res, next) {
  console.error(`[ERROR] ${new Date().toISOString()} - ${err.message}`);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);

  // Erro de validação
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      id: `err-${Date.now()}`,
      error: {
        type: 'validation_error',
        message: err.message
      }
    });
  }

  // Erro de autenticação
  if (err.name === 'UnauthorizedError' || err.status === 401) {
    return res.status(401).json({
      id: `err-${Date.now()}`,
      error: {
        type: 'authentication_error',
        message: 'Chave de API inválida ou não fornecida'
      }
    });
  }

  // Erro de rate limit
  if (err.status === 429) {
    return res.status(429).json({
      id: `err-${Date.now()}`,
      error: {
        type: 'rate_limit_error',
        message: 'Limite de requisições atingido. Tente novamente em alguns segundos.'
      }
    });
  }

  // Erro genérico
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    id: `err-${Date.now()}`,
    error: {
      type: 'internal_error',
      message: process.env.NODE_ENV === 'production' 
        ? 'Erro interno do servidor' 
        : err.message
    }
  });
}

module.exports = errorHandler;
