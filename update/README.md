# NexusPanel Safe Update

Use this on a VPS to update panel source without touching Minecraft data.

```bash
cd /root/summa/panel
bash update/update.sh
```

Protected folders:

- `servers/`
- `data/`
- `backups/`
- `backupfolder/`
- `software/`
- `node_modules/`

If the install is not a git repo, copy the new source over the panel folder first, then run the updater. The script snapshots old code into `update/backups/` before updating.
