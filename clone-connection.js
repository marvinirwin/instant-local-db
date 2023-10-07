import getPort from "get-port";
import d from "dockerode";
import pgPkg from "pg-connection-string";
import mongoPkg from "mongodb-uri";
const { parse: pgParse } = pgPkg;
const { parse: mongoParse } = mongoPkg;
import { MongoClient } from "mongodb";
import stream from "stream";
import streamPromises from "stream/promises";
import waitPort from "wait-port";

export const networkName = "clone-connection";

async function cloneDatabase(input, databaseType) {
  console.log("Starting the cloneDatabase function...");
  try {
    console.log("Parsing the input...");
    let sourceDatabaseConfig;
    if (typeof input === "string") {
      if (input.startsWith('{')) {
        // Parse stringified JSON
        console.log("Parsing stringified JSON...");
        const parsedInput = JSON.parse(input);
        sourceDatabaseConfig = parsedInput;
      } else {
        // Parse connection string
        console.log("Parsing connection string...");
        if (databaseType === "postgres") {
          sourceDatabaseConfig = pgParse(input);
        } else if (databaseType === "mongodb") {
          sourceDatabaseConfig = mongoParse(input);
          console.log(sourceDatabaseConfig);
          sourceDatabaseConfig.host = sourceDatabaseConfig.hosts[0].host;
          sourceDatabaseConfig.user = sourceDatabaseConfig.username;
        } else {
          throw new Error(
            "Invalid database type. Please provide either 'postgres' or 'mongodb'."
          );
        }
      }
    } else if (typeof input === "object") {
      sourceDatabaseConfig = input;
    } else {
      throw new Error(
        "Invalid input. Please provide a connection string or a configuration object."
      );
    }
    sourceDatabaseConfig.databaseType = databaseType;

    console.log("Getting a port for the destination database...");
    const destinationPort = await getPort();
    console.log("Creating a new Docker instance...");
    const docker = new d();
    let destinationContainer;
    let dumpCommand;
    let restoreCommand;
    const containerName = `${sourceDatabaseConfig.databaseType}-${sourceDatabaseConfig.host}-${sourceDatabaseConfig.port}-${sourceDatabaseConfig.database}`;

    console.log("Checking for an existing Docker network...");
    // Create a clone-connection docker network
    let network = docker.getNetwork(networkName);
    try {
      await network.inspect();
    } catch (error) {
      console.log(
        `No existing network with name ${networkName}, creating one.`
      );
      network = await docker.createNetwork({ Name: networkName });
    }

    console.log("Checking for an existing Docker container...");
    // Remove existing container if it exists
    try {
      const existingContainer = docker.getContainer(containerName);
      await existingContainer.remove({ force: true });
    } catch (error) {
      console.log(`No existing container with name ${containerName}`);
    }

    console.log("Creating a new Docker container...");
    try {
      switch (sourceDatabaseConfig.databaseType) {
        case "postgres":
          console.log("Pulling the Postgres image...");
          await pull(docker, "postgres");
          console.log("Creating a new Postgres container...");
          destinationContainer = await docker.createContainer({
            name: containerName,
            Image: `postgres`,
            Env: [
              `POSTGRES_USER=${sourceDatabaseConfig.user}`,
              `POSTGRES_PASSWORD=${sourceDatabaseConfig.password}`,
              `POSTGRES_DB=${sourceDatabaseConfig.database}`,
            ],
            ExposedPorts: {
              "5432/tcp": {},
            },
            HostConfig: {
              PortBindings: {
                "5432/tcp": [{ HostPort: `${destinationPort}` }],
              },
              NetworkMode: networkName,
            },
          });
          console.log("Setting up the dump and restore commands for Postgres...");
          dumpCommand = `pg_dump -v -h ${sourceDatabaseConfig.host}${sourceDatabaseConfig.port ? ' -p ' + sourceDatabaseConfig.port : ''} -U ${sourceDatabaseConfig.user} -d ${sourceDatabaseConfig.database} -f /tmp/dump.sql`;
          restoreCommand = `psql -h localhost -U ${sourceDatabaseConfig.user} -d ${sourceDatabaseConfig.database} -f /tmp/dump.sql`;
          break;
        case "mongodb":
          console.log("Pulling the MongoDB image...");
          await pull(docker, "mongo");
          console.log("Creating a new MongoDB container...");
          destinationContainer = await docker.createContainer({
            name: containerName,
            Image: `mongo`,
            Env: [
              `MONGO_INITDB_DATABASE=${sourceDatabaseConfig.database}`,
              `MONGO_INITDB_ROOT_USERNAME=${sourceDatabaseConfig.user}`,
              `MONGO_INITDB_ROOT_PASSWORD=${sourceDatabaseConfig.password}`
            ],
            ExposedPorts: {
              "27017/tcp": {},
            },
            HostConfig: {
              PortBindings: {
                "27017/tcp": [{ HostPort: `${destinationPort}` }],
              },
              NetworkMode: networkName,
            },
          });
          console.log("Setting up the dump and restore commands for MongoDB...");
          const sourceConnectionString = `${sourceDatabaseConfig.scheme}://${sourceDatabaseConfig.user}:${sourceDatabaseConfig.password}@${sourceDatabaseConfig.host}${sourceDatabaseConfig.port ? ':' + sourceDatabaseConfig.port : ''}/${sourceDatabaseConfig.database}`;
          const destinationConnectionString = `mongodb://${sourceDatabaseConfig.user}:${sourceDatabaseConfig.password}@localhost/${sourceDatabaseConfig.database}`;
          dumpCommand = `mongodump -v --uri ${sourceConnectionString} --out /tmp/dump`;
          restoreCommand = `mongorestore --uri ${destinationConnectionString} /tmp/dump/${sourceDatabaseConfig.database}`;
          break;
        default:
          throw new Error(
            `Unsupported database type. ${sourceDatabaseConfig.databaseType}`
          );
      }
    } catch (error) {
      console.error(`Error occurred while creating container: ${error}`);
    }

    console.log("Starting the Docker container...");
    await destinationContainer.start();

    console.log("Waiting for the database to start...");
    switch (sourceDatabaseConfig.databaseType) {
      case "postgres":
        await waitForPostgresToStart(
          destinationContainer,
          { ...sourceDatabaseConfig, host: "localhost" },
          docker
        );
        break;
      case "mongodb":
        await waitForMongoToStart(
          destinationContainer,
          { ...sourceDatabaseConfig, host: "localhost", port: destinationPort },
          docker
        );
        break;
      default:
        throw new Error(
          `Unsupported database type. ${sourceDatabaseConfig.databaseType}`
        );
    }

    console.log("Executing the dump command...");
    const dumpResult = await exec(
      destinationContainer,
      dumpCommand.split(" "),
      {
        AttachStdout: true,
        AttachStderr: true,
        Env: [`PGPASSWORD=${sourceDatabaseConfig.password}`],
      },
      docker
    );
    if (dumpResult.exitCode !== 0) {
      console.error(`Dump command error: ${dumpResult.stderr}`);
      return;
    }

    console.log("Executing the restore command...");
    const restoreResult = await exec(
      destinationContainer,
      restoreCommand.split(" "),
      { AttachStdout: true, AttachStderr: true },
      docker
    );
    if (restoreResult.exitCode !== 0) {
      console.error(`Restore command error: ${restoreResult.stderr}`);
      return;
    }
    console.log(`Restore command stdout: ${restoreResult.stdout}`);
    let destinationConnectionString;
    if (sourceDatabaseConfig.databaseType === "postgres") {
      destinationConnectionString = `postgresql://${sourceDatabaseConfig.user}:${sourceDatabaseConfig.password}@localhost:${destinationPort}/${sourceDatabaseConfig.database}`;
    } else if (sourceDatabaseConfig.databaseType === "mongodb") {
      destinationConnectionString = `mongodb://${sourceDatabaseConfig.user}:${sourceDatabaseConfig.password}@localhost:${destinationPort}/${sourceDatabaseConfig.database}`;
    }
    console.log(`Finished the cloneDatabase function.  Your new database can be found at ${destinationConnectionString}`);
    return destinationContainer;
  } catch (e) {
    console.error("An error occurred in the cloneDatabase function: ", e);
    throw e;
  }
}

export default cloneDatabase;

/**
 * Execute a command in a running Docker container.
 *
 * @param container container to execute the command in
 * @param cmd command to execute
 * @param opts options passed to the Docker Engine API
 */
export async function exec(container, cmd, opts, docker, logOutput = false) {
  if (!container) {
    console.log();
  }
  const dockerExec = await container.exec({
    ...opts,
    AttachStderr: true,
    AttachStdout: true,
    Cmd: cmd,
  });

  const dockerExecStream = await dockerExec.start({});

  const stdoutStream = new stream.PassThrough();
  const stderrStream = new stream.PassThrough();

  docker.modem.demuxStream(dockerExecStream, stdoutStream, stderrStream);

  dockerExecStream.resume();

  if (logOutput) {
    stdoutStream.on('data', (chunk) => {
      console.log(chunk.toString());
    });

    stderrStream.on('data', (chunk) => {
      console.error(chunk.toString());
    });
  }

  await streamPromises.finished(dockerExecStream);

  const stderr = stderrStream.read();
  const stdout = stdoutStream.read();

  const dockerExecInfo = await dockerExec.inspect();
  const exitCode = dockerExecInfo.ExitCode;
  const returnValue = {
    exitCode,
    stderr: stderr ? stderr.toString() : null,
    stdout: stdout ? stdout.toString() : null,
  };
  if (exitCode !== 0) {
    throw new Error(JSON.stringify({ command: cmd, ...returnValue }));
  }

  return returnValue;
}

export const pull = (docker, image) => {
  return new Promise((resolve, reject) =>
    docker.pull(image, (err, stream) => {
      // https://github.com/apocas/dockerode/issues/357
      docker.modem.followProgress(stream, onFinished);
      function onFinished(err, output) {
        if (!err) {
          resolve(true);
          return;
        }
        reject(err);
      }
    })
  );
};

export async function waitForPostgresToStart(container, config, docker) {
  let isPostgresReady = false;
  while (!isPostgresReady) {
    try {
      const checkPostgresStatus = await exec(
        container,
        ["pg_isready"],
        { AttachStdout: true, AttachStderr: true },
        docker
      );
      isPostgresReady = checkPostgresStatus.stdout.includes(
        "accepting connections"
      );
      if (!isPostgresReady) {
        console.log(checkPostgresStatus.stderr);
        console.log(config)
      }
    } catch (e) {
        console.error(e)
    }
    if (!isPostgresReady) {
      // Wait for a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export async function waitForMongoToStart(container, config) {
  let isMongoReady = false;
  const mongoClient = new MongoClient(`mongodb://localhost:${config.port}`);
  while (!isMongoReady) {
    try {
      await mongoClient.connect();
      isMongoReady = true;
    } catch (error) {
      // Wait for a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      await mongoClient.close();
    }
  }
}