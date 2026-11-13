// Run by redact.test.ts as a child process, with QUORUM_RPC_URL set: writes the URL every way a
// process's output can carry it, then ends on an uncaught error that quotes it, as the first argument
// says: `throw`, `await` (a rejected top-level await) or `reject` (an unhandled rejection).
import { redactProcessOutput } from '../../src/redact.ts';

redactProcessOutput();
const url = process.env.QUORUM_RPC_URL;
console.log(`console.log ${url}`);
console.error(new Error(`console.error ${url}`, { cause: new Error(url) }));
process.stdout.write(`process.stdout.write ${url}\n`);
process.stderr.write(Buffer.from(`process.stderr.write ${url}\n`));

const ending = process.argv[2];
if (ending === 'reject') void Promise.reject(new Error(`reject ${url}`));
else if (ending === 'await') await Promise.reject(new Error(`await ${url}`));
else throw new Error(`throw ${url}`);
