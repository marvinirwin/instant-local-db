import assert from "assert";
import d from "dockerode";
import cloneDatabase, {
  waitForMongoToStart,
  waitForPostgresToStart,
  exec,
  networkName
} from "./clone-connection.js";
import getPort from "get-port";

async function testDatabaseClone() {
  try {
    const networkName = "clone-connection";
    const databases = ["postgres", "mongodb"];
    const docker = new d();
    let network = docker.getNetwork(networkName);
    try {
      await network.inspect();
    } catch (error) {
      console.log(`No existing network with name ${networkName}, creating one.`);
      network = await docker.createNetwork({ Name: networkName });
    }
    for (let db of databases) {
      const sourcePort = await getPort();
      // randomPort
      const databaseDefaultPort = db === "postgres" ? 5432 : 27017;
      const database = "test";
      const config = {
        databaseType: db,
        host: database, // set the host to db so that the containers can address each other (On linux they could just use localHost, but not on MacOS)
        port: databaseDefaultPort,
        database: database,
        user: "test",
        password: "test",
        version: "latest",
      };

      // Remove existing source database if it exists
      try {
        const existingContainer = docker.getContainer(config.database);
        await existingContainer.remove({ force: true });
      } catch (error) {
        console.log(`No existing container with name ${config.database}`);
      }

      // Start source database
      const sourceContainer = await docker.createContainer({
        name: config.database,
        Image: db === "postgres" ? "postgres" : "mongo",
        Env: [
            `POSTGRES_USER=${config.user}`,
            `POSTGRES_PASSWORD=${config.password}`,
            `POSTGRES_DB=${config.database}`
        ],
        ExposedPorts: {
          "5432/tcp": {},
        },
        HostConfig: {
          PortBindings: {
            "5432/tcp": [{ HostPort: `${sourcePort}` }],
          },
            NetworkMode: networkName,
        },
      });
      await sourceContainer.start();

      switch (db) {
        case "postgres":
            await waitForPostgresToStart(sourceContainer, config, docker)
          break;
        case "mongodb":
            await waitForMongoToStart(sourceContainer, config, docker)
          break;
        default:
          throw new Error(`Unsupported database type. ${config.databaseType}`);
      }
      // Is this going to work
      // Print container logs
      const logData = await sourceContainer.logs({
        follow: false,
        stdout: true,
        stderr: true,
      });
      console.log(logData.toString());

      // Seed data
      let seedCommand;
      if (db === "postgres") {
        seedCommand = ["psql", "-h", "localhost", "-U", `${config.user}`, "-d", `${config.database}`, "-c", "CREATE TABLE test (id SERIAL PRIMARY KEY, data VARCHAR(100)); INSERT INTO test (data) VALUES ('test');"];
      } else {
        seedCommand = ["echo", "'db.test.insert({data: \"test\"})'", "|", "mongo", `localhost/${config.database}`];
      }

      console.log(await exec(
        sourceContainer,
        seedCommand,
        { AttachStdout: true, AttachStderr: true },
        docker
      ));

      console.log(await exec(
        sourceContainer,
        ["psql", "-h", "localhost", "-p", `${config.port}`, "-U", `${config.user}`, "-d", `${config.database}`, "-c", "SELECT * FROM test"],
        { AttachStdout: true, AttachStderr: true },
        docker
      ));

/*       await sourceContainer.exec({
        Cmd: ["/bin/bash", "-c", seedCommand],
        AttachStdout: true,
        AttachStderr: true,
      }); */

      // Clone database
      const clonedContainer = await cloneDatabase(config, db);

      // Test cloned data
      let testCommand;
      if (db === "postgres") {
        testCommand = ["psql", "-h", "localhost", "-p", `${config.port}`, "-U", `${config.user}`, "-d", `${config.database}`, "-c", "SELECT * FROM test;"];
      } else {
        testCommand = ["echo", "'db.test.find()'", "|", "mongo", `localhost:${config.port}/${config.database}`];
      }
      // TODO maybe have to use the exec function here, but this might also work because we're not on windows
      const output = await exec(
        clonedContainer,
        testCommand,
        { AttachStdout: true, AttachStderr: true, ENV: [] },
        docker
      );
      assert(output.stdout.includes("test"));

      // Stop and remove source database
      await sourceContainer.stop();
      await sourceContainer.remove();
    }
  } catch (e) {
    console.error(e);
  }
}

testDatabaseClone();
