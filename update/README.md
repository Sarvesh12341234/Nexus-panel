# NexusPanel Safe Update

Run the updater from the existing installation. It updates application code,
installs dependencies, and restarts the service without deleting the install
directory.

```bash
cd /opt/nexuspanel
sudo bash update/update.sh
```

The updater works with both Git-based installations and release/source folders
without `.git` metadata. For a non-Git installation, it downloads the configured
release tag and overlays its tracked files in place.

These existing paths and files are preserved:

- `servers/`, `data/`, `backups/`, `backupfolder/`, and `software/`
- `node_modules/`, `.env`, and updater snapshots in `update/backups/`
- Other files not present in the downloaded release remain in place

Before changing application code, the updater saves a timestamped code snapshot
under `update/backups/`. On failure it restores that snapshot and restarts the
service. The update does not remove old code files absent from the new release;
this avoids deleting unknown user files.

To select a different release tag or repository:

```bash
sudo NEXUSPANEL_UPDATE_TAG=v1.0.5 \
  NEXUSPANEL_REPO_URL=https://github.com/Sarvesh12341234/Nexus-panel.git \
  bash update/update.sh
```
