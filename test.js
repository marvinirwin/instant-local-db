import assert from "assert";
import d from "dockerode";
import cloneDatabase, {
  waitForMongoToStart,
  waitForPostgresToStart,
  exec,
  networkName,
  pull,
} from "./clone-connection.js";
import getPort from "get-port";

async function testDatabaseClone() {
  try {
    const networkName = "clone-connection";
    const database = "test";
    const databases = ["postgres", "mongodb"];
    const docker = new d();
    let network = docker.getNetwork(networkName);
    try {
      await network.inspect();
    } catch (error) {
      console.log(
        `No existing network with name ${networkName}, creating one.`
      );
      network = await docker.createNetwork({ Name: networkName });
    }
    for (let db of databases) {
      const sourcePort = await getPort();
      // randomPort
      const image = db === "postgres" ? "postgres" : "mongo";
      const databaseDefaultPort = image === "postgres" ? 5432 : 27017;
      await pull(docker, image);
      const config = {
        databaseType: db,
        host: database, // set the host to db so that the containers can address each other (On linux they could just use localHost, but not on MacOS)
        port: sourcePort,
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
        Image: image,
        Env: [
          `POSTGRES_USER=${config.user}`,
          `POSTGRES_PASSWORD=${config.password}`,
          `POSTGRES_DB=${config.database}`,
        ],
        ExposedPorts: {
          [`${databaseDefaultPort}/tcp`]: {},
        },
        HostConfig: {
          PortBindings: {
            [`${databaseDefaultPort}/tcp`]: [{ HostPort: `${sourcePort}` }],
          },
          NetworkMode: networkName,
        },
      });
      await sourceContainer.start();

      switch (db) {
        case "postgres":
          await waitForPostgresToStart(sourceContainer, config, docker);
          break;
        case "mongodb":
          await waitForMongoToStart(sourceContainer, config, docker);
          break;
        default:
          throw new Error(`Unsupported database type. ${config.databaseType}`);
      }

      // Seed data
      let seedCommand;
      if (db === "postgres") {
        seedCommand = [
          "psql",
          "-h",
          "localhost",
          "-U",
          `${config.user}`,
          "-d",
          `${config.database}`,
          "-c",
          "CREATE TABLE test (id SERIAL PRIMARY KEY, data VARCHAR(100)); INSERT INTO test (data) VALUES ('test');",
        ];
      } else {
        seedCommand = [
          "mongosh",
          `localhost/${config.database}`,
          "--eval",
          "db.test.insert({data: 'test'})"
        ];
      }

      console.log(
        await exec(
          sourceContainer,
          seedCommand,
          { AttachStdout: true, AttachStderr: true },
          docker
        )
      );

      // Clone database
      const clonedContainer = await cloneDatabase(config, db);

      // Test cloned data
      let testCommand;
      if (db === "postgres") {
        testCommand = [
          "psql",
          "-h",
          "localhost",
          "-U",
          `${config.user}`,
          "-d",
          `${config.database}`,
          "-c",
          "SELECT * FROM test;",
        ];
      } else {
        testCommand = [
          "mongosh",
          "--quiet",
          `localhost/${config.database}`,
          "--eval",
          "db.test.find()"
        ];
      }
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
