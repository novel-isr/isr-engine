import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

try {
  const directory = process.argv[2];
  if (!directory) throw new Error('A CodeQL SARIF output directory is required');
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.sarif'))
    .map(entry => path.join(entry.parentPath, entry.name));
  if (!files.length) throw new Error('No CodeQL SARIF evidence found');
  let findings = 0;
  let runs = 0;
  for (const filename of files) {
    const report = JSON.parse(await readFile(filename, 'utf8'));
    if (report.version !== '2.1.0' || !Array.isArray(report.runs) || !report.runs.length) {
      throw new Error(`Incomplete SARIF report: ${filename}`);
    }
    for (const run of report.runs) {
      if (run.tool?.driver?.name !== 'CodeQL' || !Array.isArray(run.results)) {
        throw new Error(`Missing CodeQL results: ${filename}`);
      }
      if (run.invocations !== undefined && !Array.isArray(run.invocations)) {
        throw new Error(`Invalid CodeQL invocation evidence: ${filename}`);
      }
      for (const invocation of run.invocations ?? []) {
        const notifications = [
          ...(invocation.toolExecutionNotifications ?? []),
          ...(invocation.toolConfigurationNotifications ?? []),
        ];
        if (
          invocation.executionSuccessful === false ||
          (invocation.exitCode !== undefined && invocation.exitCode !== 0) ||
          notifications.some(notification => notification.level === 'error')
        ) {
          throw new Error(`CodeQL reported incomplete or failed analysis: ${filename}`);
        }
      }
      runs++;
      for (const result of run.results) {
        findings++;
        // Treat every result as blocking, even if previously dismissed or suppressed.
        // JSON preserves one physical line and cannot emit workflow command annotations.
        console.log(
          JSON.stringify({
            ruleId: result.ruleId,
            level: result.level,
            message: result.message,
            locations: result.locations,
          })
        );
      }
    }
  }
  console.log(`CodeQL: ${runs} analyzed run(s), ${findings} findings`);
  if (findings) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
