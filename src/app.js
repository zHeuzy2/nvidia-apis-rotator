

require('dotenv').config();

const express = require('express');
const errorHandler = require('./middleware/errorHandler');
const requestLogger = require('./middleware/logger');
const proxyRoutes = require('./routes/proxy');
const healthService = require('./services/healthService');
const apiConfig = require('./config/apiConfig');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== Middlewares ====================

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(requestLogger);

app.get('/', (req, res) => {
  const apis = apiConfig.getHealthyApis();
  res.json({
    name: 'NVIDIA API Rotator',
    version: '2.0.0',
    status: 'online',
    apisConfigured: apiConfig.getAllApis().length,
    apisHealthy: apis.length,
    endpoints: {
      proxy: '/v1/*',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => {
  const apis = apiConfig.getAllApis();
  const healthy = apis.filter(a => a.healthy).length;
  const total = apis.length;
  res.json({
    status: healthy > 0 ? 'healthy' : 'unhealthy',
    apis: { total, healthy, unhealthy: total - healthy },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.use('/v1', proxyRoutes);

// ==================== Error Handler ====================

app.use(errorHandler);

app.use((req, res) => {
  res.status(404).json({
    error: { message: 'Endpoint não encontrado', path: req.path }
  });
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log('    NVIDIA API Rotator');
  console.log('========================================');
  console.log(`Porta: ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);

  const apis = apiConfig.getAllApis();
  console.log(`APIs configuradas: ${apis.length}`);
  apis.forEach(api => {
    console.log(`  - ${api.name} (${api.id})`);
  });

  healthService.start();
  console.log('Health check monitor iniciado');
  console.log('========================================');
});

process.on('SIGTERM', () => {
  healthService.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  healthService.stop();
  process.exit(0);
});

module.exports = app;
