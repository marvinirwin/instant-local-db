 const docker = require('dockerode');
 const getPort = require('get-port');
 const { exec } = require('child_process');
 const { parse } = require('pg-connection-string');
 const mysql = require('mysql');
 const MongoClient = require('mongodb').MongoClient;

 async function cloneDatabase(input) {
   let config;
   if (typeof input === 'string') {
     config = parse(input);
   } else if (typeof input === 'object') {
     config = input;
   } else {
     throw new Error('Invalid input. Please provide a connection string or a configuration object.');
   }

   const port = await getPort();
   const docker = new docker();
   let container;
   let dumpCommand;
   let restoreCommand;
   const containerName = `${config.databaseType}-${config.host}-${config.port}-${config.database}`;

   // Remove existing container if it exists
   try {
     const existingContainer = docker.getContainer(containerName);
     await existingContainer.remove({ force: true });
   } catch (error) {
     console.log(`No existing container with name ${containerName}`);
   }

   switch (config.databaseType) {
     case 'postgres':
       container = await docker.createContainer({
         name: containerName,
         Image: `postgres:${config.version}`,
         Env: [`POSTGRES_USER=${config.user}`, `POSTGRES_PASSWORD=${config.password}`, `POSTGRES_DB=${config.database}`],
         ExposedPorts: {
           '5432/tcp': {}
         },
         HostConfig: {
           PortBindings: {
             '5432/tcp': [{ HostPort: `${port}` }]
           }
         }
       });
       dumpCommand = `docker exec -it ${container.id} /bin/bash -c "pg_dump -h ${config.host} -p ${config.port} -U ${config.user} -d ${config.database} -f /tmp/dump.sql"`;
       restoreCommand = `docker exec -it ${container.id} /bin/bash -c "psql -h localhost -p ${port} -U ${config.user} -d ${config.database} -f /tmp/dump.sql"`;
       break;
     case 'mysql':
       container = await docker.createContainer({
         name: containerName,
         Image: `mysql:${config.version}`,
         Env: [`MYSQL_ROOT_PASSWORD=${config.password}`],
         ExposedPorts: {
           '3306/tcp': {}
         },
         HostConfig: {
           PortBindings: {
             '3306/tcp': [{ HostPort: `${port}` }]
           }
         }
       });
       dumpCommand = `docker exec -it ${container.id} /bin/bash -c "mysqldump -h ${config.host} -P ${config.port} -u ${config.user} -p${config.password} ${config.database} > /tmp/dump.sql"`;
       restoreCommand = `docker exec -it ${container.id} /bin/bash -c "mysql -h localhost -P ${port} -u root -p${config.password} ${config.database} < /tmp/dump.sql"`;
       break;
     case 'mongodb':
       container = await docker.createContainer({
         name: containerName,
         Image: `mongo:${config.version}`,
         ExposedPorts: {
           '27017/tcp': {}
         },
         HostConfig: {
           PortBindings: {
             '27017/tcp': [{ HostPort: `${port}` }]
           }
         }
       });
       dumpCommand = `docker exec -it ${container.id} /bin/bash -c "mongodump --host ${config.host} --port ${config.port} --db ${config.database} --out /tmp/dump"`;
       restoreCommand = `docker exec -it ${container.id} /bin/bash -c "mongorestore --host localhost --port ${port} --db ${config.database} /tmp/dump/${config.database}"`;
       break;
     default:
       throw new Error('Unsupported database type.');
   }

   await container.start();

   exec(dumpCommand, (error, stdout, stderr) => {
     if (error) {
       console.error(`exec error: ${error}`);
       return;
     }
     console.log(`stdout: ${stdout}`);
     console.error(`stderr: ${stderr}`);
   });

   exec(restoreCommand, (error, stdout, stderr) => {
     if (error) {
       console.error(`exec error: ${error}`);
       return;
     }
     console.log(`stdout: ${stdout}`);
     console.error(`stderr: ${stderr}`);
   });
 }

 cloneDatabase(process.argv[2]);

