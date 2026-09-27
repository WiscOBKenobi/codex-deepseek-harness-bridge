/** Parent-death fixture: the child must stop when its owner disappears. */
import { startHarness } from '../../src/harness-runner.mjs';
const options = JSON.parse(process.argv[2]);
const run = await startHarness(options);
await run.done;
