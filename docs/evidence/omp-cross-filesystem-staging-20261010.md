# OMP staging across filesystems

Issue: [#63](https://github.com/archeism/plugnz/issues/63). Starting main:
`7ccc6ded64ac4513af82de4e539e2d5669c203f8`.

OMP previously projected packages under system temp and renamed them into its
managed store. On charles-netcup, `/tmp` is tmpfs (device 32), while the destination
is ext4 (device 65028), so activation failed with `EXDEV`. Real installations now
stage inside the managed destination after `mkdirSafe` validates it. Dry runs
continue using system temp and leave an absent native store absent. Existing
activation, rollback, ownership checks and cleanup remain in the OMP writer.

Verification on Bun 1.4.2 and Node 22.23.1:

- The portable regression fails before the fix when system temp is unavailable;
  fresh install, content update and unchanged add pass afterward.
- `bun test test/omp-lifecycle.test.ts`: 10 pass, 53 assertions. The same suite with
  `OPEN_PLUGIN_TEST_OMP_HOME_PARENT=/root/.local/state/plugnz-omp-exdev/home-trials`
  and no `TMPDIR` override passes across the actual mounts. The pre-fix cross-mount
  run had 4 pass and 6 fail, including cross-device activation errors.
- Independent Codex-agent review and a separate cross-mount focused run passed.
- `bun run check` and `bun run build` pass. The built Node CLI passed eight commands:
  dry run, install, list, update, unchanged add, forced activation failure,
  recovery, and doctor. Content readback, prior bytes after rollback, native links
  and removal of temporary staging/backup folders were verified.
- Full suite with root DAC bypass disabled:
  `setpriv --bounding-set=-dac_override,-dac_read_search bun test`.
  Unchanged main: 462 pass, 2 skip, 3 fail. Candidate: 465 pass, 2 skip, 3 fail.
  Both have exactly the same existing failures: two ZCode desktop-detection tests
  on Linux and the Codex old-version-cleanup failure test. The full suite is not
  green on this host. No unrelated source or tests were changed.

Raw logs and receipts are retained under
`/root/.local/state/plugnz-omp-exdev/`, including `full-suite-comparison.json`,
baseline/fixed cross-filesystem logs, and `cli-0ch9z17t/receipt.json` plus
`runs.json`. The CLI receipt verifies bundle SHA-256
`21bdf993fd1e500b612b3510d5b18804652def85505ee5c1de45bd7f6e6cb58d`.
No npm publication or fleet rollout was performed. Skill instructions are unchanged.
