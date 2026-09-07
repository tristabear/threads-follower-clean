#!/usr/bin/env node
const { createApp } = require('../src/server');

const port = Number(process.env.PORT) || 4173;
const app = createApp(port);

app.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log(`  threads-bot-filter running at http://127.0.0.1:${port}`);
  console.log('  Open that URL in your browser and follow the setup steps there.');
  console.log('');
  console.log('  (Bound to localhost only — nothing outside this machine can reach it.)');
  console.log('');
});
