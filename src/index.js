'use strict';

const app = require('./app');
const config = require('./config');

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`LiquiFact API listening on http://localhost:${config.port} (docs: /docs)`);
  });
}

module.exports = app;
