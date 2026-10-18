'use strict';

const { extractArchiveInto } = require('./zip_utils');

try {
  const archives = JSON.parse(process.env.NEXUSPANEL_WORKER_ARCHIVES || '[]');
  const destination = process.env.NEXUSPANEL_WORKER_DESTINATION;
  const mode = process.env.NEXUSPANEL_WORKER_MODE || 'fail';
  if (!Array.isArray(archives) || !destination) throw new Error('Invalid extraction worker request.');
  for (const archive of archives) extractArchiveInto(archive, destination, { mode });
} catch (error) {
  process.stderr.write(`${error.message || 'Archive extraction failed.'}\n`);
  process.exitCode = 1;
}
