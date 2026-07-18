# NexusPanel project structure

The repository keeps runtime code, maintenance tools, tests, native code, and generated data separate.

```text
backend/                 Node.js server and runtime modules
frontend/                Browser HTML, CSS, and JavaScript
native/nexusmark/src/    Production NexusMark C source
native/nexusmark/tests/  Native audits, benchmarks, and test payloads
native/host-agent/src/   Native C host telemetry and control-plane bridge
scripts/                 Administrator maintenance commands
tests/                   Node.js integration tests
installers/              Versioned Linux installer entrypoints
update/                  Safe updater and updater documentation
pictures/                Referenced UI theme assets
data/                    Generated database and state, ignored by Git
servers/                 Generated game-server data, ignored by Git
software/                Downloaded server software, ignored by Git
backups/                 Generated backups, ignored by Git
```

Root files are limited to project metadata, primary documentation, package manifests, and the portable Windows installer.

## Validation commands

```bash
npm test
npm run audit:nexusmark
npm run benchmark:nexusmark
```

NexusMark production code must stay in `native/nexusmark/src`. Audit and benchmark payloads must stay in `native/nexusmark/tests` so they can never be mistaken for panel runtime dependencies.
