# Instant Local DB


Clone a remote postgres or mongodb database into a local docker container, with the same credentials.  Just swap the hostname and port!

## QuickStart
`npx instant-local-db@latest --databaseType postgres --connectionData postgresql://adminuser:password@db-postgresql.com:5432/postgres`

`npx instant-local-db@latest --databaseType mongodb --connectionData mongodb+srv://username:password@db-mongodb/database`
