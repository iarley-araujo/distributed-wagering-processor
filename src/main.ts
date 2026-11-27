// ㉿ Distributed Wagering Processor — ponto de entrada de uma instância.
import { createApp } from './bootstrap';
import { loadConfig } from './config/app-config';
import { AppLogger } from './observability/logger';

const config = loadConfig();
const logger = new AppLogger('main');
logger.info('㉿ distributed-wagering-processor', { instanceId: config.instanceId, roles: [...config.roles] });
const app = await createApp(config);
await app.listen(config.http.port, '0.0.0.0');
logger.info('http listening', { port: config.http.port });
