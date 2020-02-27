import Umzug from 'umzug';
import Bluebird from 'bluebird';
import _ from 'lodash';
import { readFileSync } from 'fs';
import { dirname } from 'path';
import typescript from 'typescript';

import helpers from '../helpers/index';
import resolve from 'resolve';

const Sequelize = helpers.generic.getSequelize();

export function logMigrator (s) {
  if (s.indexOf('Executing') !== 0) {
    helpers.view.log(s);
  }
}

function getSequelizeInstance () {
  let config = null;

  try {
    config = helpers.config.readConfig();
  } catch (e) {
    helpers.view.error(e);
  }

  config = _.defaults(config, { logging: logMigrator });

  try {
    return new Sequelize(config);
  } catch (e) {
    helpers.view.error(e);
  }
}

export function getMigrator (type, args) {
  return Bluebird.try(() => {
    if (!(helpers.config.configFileExists() || args.url)) {
      helpers.view.error(
        'Cannot find "' + helpers.config.getConfigFile() +
        '". Have you run "sequelize init"?'
      );
      process.exit(1);
    }

    let migratorPath = helpers.path.getPath(type);

    if ( type === 'migration' ) {
      migratorPath = helpers.path.getMigrationsCompiledPath();
    }

    if ( type === 'seeder' ) {
      migratorPath = helpers.path.getSeedersCompiledPath();
    }

    const sequelize = getSequelizeInstance();
    const migrator = new Umzug({
      storage: helpers.umzug.getStorage(type),
      storageOptions: helpers.umzug.getStorageOptions(type, { sequelize }),
      logging: helpers.view.log,
      migrations: {
        params: [sequelize.getQueryInterface(), Sequelize],
        path: migratorPath,
        pattern: /\.[jt]s$/,
        customResolver: path => {
          const program = typescript.createProgram(path, {});
          const emitResult = program.emit();

          const allDiagnostics = typescript
            .getPreEmitDiagnostics(program)
            .concat(emitResult.diagnostics);

          allDiagnostics.forEach(diagnostic => {
            if (diagnostic.file) {
              const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
              const message = typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
              console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
            } else {
              console.log(typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
            }
          });
          const Module = module.constructor;
          const m = new Module(path, module.parent);
          m.filename = path;
          // eslint-disable-next-line no-undef
          m.paths = [...Module._nodeModulePaths(dirname(path)), resolve(__dirname, '../test/helpers'), resolve(__dirname, '../')];
          m._compile(emitResult, path);
          return m.exports;
        },
        wrap: fun => {
          if (fun.length === 3) {
            return Bluebird.promisify(fun);
          } else {
            return fun;
          }
        }
      }
    });

    return sequelize
      .authenticate()
      .then(() => {
        // Check if this is a PostgreSQL run and if there is a custom schema specified, and if there is, check if it's
        // been created. If not, attempt to create it.
        if (helpers.version.getDialectName() === 'pg') {
          const customSchemaName = helpers.umzug.getSchema('migration');
          if (customSchemaName && customSchemaName !== 'public') {
            return sequelize.createSchema(customSchemaName);
          }
        }

        return Bluebird.resolve();
      })
      .then(() => migrator)
      .catch(e => helpers.view.error(e));
  });
}

export function ensureCurrentMetaSchema (migrator) {
  const queryInterface = migrator.options.storageOptions.sequelize.getQueryInterface();
  const tableName = migrator.options.storageOptions.tableName;
  const columnName = migrator.options.storageOptions.columnName;

  return ensureMetaTable(queryInterface, tableName)
    .then(table => {
      const columns = Object.keys(table);

      if (columns.length === 1 && columns[0] === columnName) {
        return;
      } else if (columns.length === 3 && columns.indexOf('createdAt') >= 0) {
        return;
      }
    })
    .catch(() => {});
}

function ensureMetaTable (queryInterface, tableName) {
  return queryInterface.showAllTables()
    .then(tableNames => {
      if (tableNames.indexOf(tableName) === -1) {
        throw new Error('No MetaTable table found.');
      }
      return queryInterface.describeTable(tableName);
    });
}

/**
 * Add timestamps
 *
 * @return {Promise}
 */
export function addTimestampsToSchema (migrator) {
  const sequelize = migrator.options.storageOptions.sequelize;
  const queryInterface = sequelize.getQueryInterface();
  const tableName = migrator.options.storageOptions.tableName;

  return ensureMetaTable(queryInterface, tableName)
    .then(table => {
      if (table.createdAt) {
        return;
      }

      return ensureCurrentMetaSchema(migrator)
        .then(() => queryInterface.renameTable(tableName, tableName + 'Backup'))
        .then(() => {
          const sql = queryInterface.QueryGenerator.selectQuery(tableName + 'Backup');
          return helpers.generic.execQuery(sequelize, sql, { type: 'SELECT', raw: true });
        })
        .then(result => {
          const SequelizeMeta = sequelize.define(tableName, {
            name: {
              type: Sequelize.STRING,
              allowNull: false,
              unique: true,
              primaryKey: true,
              autoIncrement: false
            }
          }, {
            tableName,
            timestamps: true,
            schema: helpers.umzug.getSchema()
          });

          return SequelizeMeta.sync()
            .then(() => {
              return SequelizeMeta.bulkCreate(result);
            });
        });
    });
}
