import cloneDatabase from "./clone-connection.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const argv = yargs(hideBin(process.argv))
  .option("connectionData", {
    alias: "c",
    type: "string",
    description: "Connection data for the database",
    demandOption: true,
  })
  .option("databaseType", {
    alias: "d",
    type: "string",
    description: "Type of the database",
    choices: ["mongodb", "postgres"],
    demandOption: true,
  })
  .help()
  .alias("help", "h")
  .argv;

cloneDatabase(argv.connectionData, argv.databaseType);
