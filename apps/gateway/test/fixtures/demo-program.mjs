// Stands in for the swarm's `demo` command in the gateway's tests. The gateway appends the scenario
// after the arguments it is given, so the first argument picks what this program does:
//   lines           writes two lines and a last one without a newline to stdout, and one line to
//                   stderr, then exits with 0
//   exit <code>     writes one line, then exits with <code>
//   hang            writes "ready", then runs until a signal ends it, or for at most 120 seconds
//   ignore-sigterm  like hang, but on SIGTERM writes "SIGTERM ignored" and runs on (on POSIX only:
//                   Windows ends the process instead)
//   describe        writes its arguments, its working folder and its QUORUM_* variables (any case) as
//                   JSON on one line, then exits with 0
// Plain JavaScript, so that Node runs it without type stripping.
const [mode, ...rest] = process.argv.slice(2);

/**
 * Keeps the program running, then exits with 70 after 120 seconds, far longer than any test lets a
 * run last: a test that fails before it ends the run does not leave the program running forever.
 */
function runAtMost120Seconds() {
  setTimeout(() => process.exit(70), 120_000);
}

switch (mode) {
  case 'lines':
    process.stdout.write('first line\nsecond line\r\n');
    process.stderr.write('an error line\n');
    process.stdout.write('last line without a newline');
    break;
  case 'exit':
    console.log(`exiting with ${rest[0]}`);
    process.exitCode = Number(rest[0]);
    break;
  case 'ignore-sigterm':
    process.on('SIGTERM', () => console.log('SIGTERM ignored'));
    console.log('ready');
    runAtMost120Seconds();
    break;
  case 'hang':
    console.log('ready');
    runAtMost120Seconds();
    break;
  case 'describe': {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^quorum_/i.test(name)));
    console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }));
    break;
  }
  default:
    console.error(`unknown mode ${JSON.stringify(mode)}`);
    process.exitCode = 2;
}
