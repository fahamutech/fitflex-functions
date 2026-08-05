// Knex CLI configuration (CommonJS — package.json sets "type": "module", so this
// file must keep the .cjs extension to be loaded correctly by the Knex CLI).
require('dotenv').config();

/** @type {import('knex').Knex.Config} */
const config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: './db/migrations',
    tableName: 'knex_migrations',
    extension: 'cjs',
  },
};

module.exports = config;
