import getPort from "get-port";
import d from "dockerode";
import pkg from "pg-connection-string";
const { parse } = pkg;
import { MongoClient } from "mongodb";
import stream from "stream";
import streamPromises from "stream/promises";
import waitPort from "wait-port";

export const networkName = "clone-connection";
/**
 * Execute a command in a running Docker container.
 *
 * @param container container to execute the command in
 * @param cmd command to execute
 * @param opts options passed to the Docker Engine API
 */
export async function exec(container, cmd, opts, docker) {
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
  const dockerExecInfo2 = await dockerExec.inspect();

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

const pull = (docker, image) => {
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
        ["pg_isready", "-U", config.user],
        { AttachStdout: true, AttachStderr: true },
        docker
      );
      isPostgresReady = checkPostgresStatus.stdout.includes(
        "accepting connections"
      );
    } catch (e) {}
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

async function cloneDatabase(input, databaseType) {
  try {
    let sourceDatabaseConfig;
    if (typeof input === "string") {
      sourceDatabaseConfig = parse(input);
    } else if (typeof input === "object") {
      sourceDatabaseConfig = input;
    } else {
      throw new Error(
        "Invalid input. Please provide a connection string or a configuration object."
      );
    }
    // hmmm how to figure out if its postgres or not
    sourceDatabaseConfig.databaseType = databaseType;

    const destinationPort = await getPort();
    const docker = new d();
    let destinationContainer;
    let dumpCommand;
    let restoreCommand;
    const containerName = `${sourceDatabaseConfig.databaseType}-${sourceDatabaseConfig.host}-${sourceDatabaseConfig.port}-${sourceDatabaseConfig.database}`;

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

    // Remove existing container if it exists
    try {
      const existingContainer = docker.getContainer(containerName);
      await existingContainer.remove({ force: true });
    } catch (error) {
      console.log(`No existing container with name ${containerName}`);
    }

    try {
      switch (sourceDatabaseConfig.databaseType) {
        case "postgres":
          await pull(docker, "postgres");
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
          dumpCommand = `pg_dump -v -h ${sourceDatabaseConfig.host} -p ${sourceDatabaseConfig.port} -U ${sourceDatabaseConfig.user} -d ${sourceDatabaseConfig.database} -f /tmp/dump.sql`;
          restoreCommand = `psql -h localhost -U ${sourceDatabaseConfig.user} -d ${sourceDatabaseConfig.database} -f /tmp/dump.sql`;
          break;
        case "mongodb":
          await pull(docker, "mongo");
          destinationContainer = await docker.createContainer({
            name: containerName,
            Image: `mongo`,
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
          dumpCommand = `mongodump --host ${sourceDatabaseConfig.host} --port ${sourceDatabaseConfig.port} --db ${sourceDatabaseConfig.database} --out /tmp/dump`;
          restoreCommand = `mongorestore --host localhost --port ${destinationPort} --db ${sourceDatabaseConfig.database} /tmp/dump/${sourceDatabaseConfig.database}`;
          break;
        default:
          throw new Error(
            `Unsupported database type. ${sourceDatabaseConfig.databaseType}`
          );
      }
    } catch (error) {
      console.error(`Error occurred while creating container: ${error}`);
    }

    await destinationContainer.start();

    switch (sourceDatabaseConfig.databaseType) {
      case "postgres":
        await waitForPostgresToStart(
          destinationContainer,
          { ...sourceDatabaseConfig, host: "localhost", port: destinationPort },
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
/*     console.log("START");
    console.log(
      await exec(
        destinationContainer,
        [
          "psql",
          "-h",
          sourceDatabaseConfig.host,
          "-p",
          `${sourceDatabaseConfig.port}`,
          "-U",
          `${sourceDatabaseConfig.user}`,
          "-d",
          `${sourceDatabaseConfig.database}`,
          "-c",
          "SELECT * FROM test",
        ],
        {
          AttachStdout: true,
          AttachStderr: true,
          Env:[ `PGPASSWORD=${sourceDatabaseConfig.password}`],
        },
        docker
      )
    );
    console.log("END"); */

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
    return destinationContainer;
  } catch (e) {
    throw e;
  }
}

export default cloneDatabase;
