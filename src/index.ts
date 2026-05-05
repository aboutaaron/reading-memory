import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { createReadingApi } from './api/server.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const server = createReadingApi(config, db);

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'reading-api.started', host: config.host, port: config.port, db: config.dbPath }));
});

function shutdown(signal: NodeJS.Signals) {
  console.log(JSON.stringify({ event: 'reading-api.shutdown', signal }));
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
