# Connector setup

`mcp-server-db2i` ships two backends. Pick one and configure it under `connection`.

| Backend | Pros                                       | Cons                                       |
|---------|--------------------------------------------|--------------------------------------------|
| `odbc`  | Native, fast, widely supported             | Requires installing IBM i ODBC driver      |
| `jt400` | Pure-Java, no native deps, easy on Linux   | Needs a JRE; slightly slower               |

## ODBC (recommended)

### Driver install

**Windows**
1. Install [IBM i Access Client Solutions](https://www.ibm.com/support/pages/ibm-i-access-client-solutions) (free, requires IBM ID).
2. Install the bundled "ODBC Driver for IBM i Access".
3. Configure a System DSN named e.g. `AS400` pointing at your host.
4. Test with: `Test-OdbcDriver -Name "IBM i Access ODBC Driver"` (PowerShell).

**Linux**
1. Install unixODBC: `sudo apt install unixodbc unixodbc-dev` (Debian/Ubuntu) or equivalent.
2. Download "IBM i Access ODBC Driver" from IBM (free, requires IBM ID).
3. Register the driver in `/etc/odbcinst.ini` and define a DSN in `/etc/odbc.ini`.

**macOS**
Same as Linux but use Homebrew (`brew install unixodbc`).

### Connection string

```
DSN=AS400;UID=READER;PWD=${DB2I_PASSWORD}
```

You can also use a DSN-less string:
```
DRIVER={IBM i Access ODBC Driver};SYSTEM=host.example.com;UID=READER;PWD=${DB2I_PASSWORD}
```

## jt400 (JDBC)

### Setup
1. Install a JRE (`java -version` must succeed). OpenJDK 17+ recommended.
2. `npm install jt400` (it is an optional peer dep of this server).
3. Configure:

```jsonc
{
  "connection": {
    "driver": "jt400",
    "jt400": {
      "host": "host.example.com",
      "user": "READER",
      "password": "${DB2I_PASSWORD}",
      "naming": "system"
    }
  }
}
```

### Naming convention

- `"system"` (default): IBM i native — `LIBRARY/FILE`, list-of-libraries lookup.
- `"sql"`: SQL standard — `SCHEMA.TABLE`, no library list.

If your queries use `SCHEMA.TABLE` syntax (as in the example config), `sql` may be safer; if you rely on `*LIBL`, use `system`.

## Troubleshooting

**`Cannot find module 'odbc'`**
You're running the server without installing native deps. Run `npm install odbc` (it's a real dep, not optional).

**`SQL0440 — Routine *N in *N not found`**
The DB user lacks privileges on `QSYS2.SYSTABLES` / `SYSCOLUMNS`. Grant `SELECT` on those views.

**`SQL30082 — Authorization failure on connection`**
Wrong username/password, or the user profile is disabled / has too many invalid sign-on attempts.

**`No tables found` after introspection**
Check that `--schema` matches your library/schema name in the case stored on IBM i (usually uppercase). Try `npm run introspect -- --schema $(echo MYLIB | tr a-z A-Z)`.

**Stdout corruption / Claude Desktop reports invalid JSON-RPC**
You're using a fork that prints to stdout. Make sure you're on the current version where all logging goes to stderr.
