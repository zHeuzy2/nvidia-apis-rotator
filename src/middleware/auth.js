/**
 * Middleware de autenticação para proxy
 * Verifica se o cliente tem acesso à API
 */
function proxyAuthMiddleware(req, res, next) {
  const proxyKey = process.env.PROXY_API_KEY;
  
  // Se não há chave de proxy configurada, permite acesso
  if (!proxyKey) {
    return next();
  }

  // Verifica header Authorization
  const authHeader = req.headers['authorization'];
  const providedKey = authHeader?.replace('Bearer ', '');

  if (!providedKey || providedKey !== proxyKey) {
    return res.status(401).json({
      id: `err-${Date.now()}`,
      error: {
        type: 'authentication_error',
        message: 'Chave de API inválida'
      }
    });
  }

  next();
}

module.exports = { proxyAuthMiddleware };
