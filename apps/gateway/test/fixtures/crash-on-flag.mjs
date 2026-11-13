// Preloaded into a gateway in a test, with `node --import`: once the file that GATEWAY_TEST_CRASH_FILE
// names exists, throws from a timer, as an error that nothing handles would. Without the variable it
// does nothing. The timer does not keep the process alive.
// Plain JavaScript, so that Node runs it without type stripping.
import { existsSync } from 'node:fs';

const flag = process.env.GATEWAY_TEST_CRASH_FILE;
if (flag) {
  setInterval(() => {
    if (existsSync(flag)) throw new Error('an error nothing handles, thrown by the test');
  }, 20).unref();
}
