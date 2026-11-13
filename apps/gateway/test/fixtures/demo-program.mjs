// Stands in for the swarm's `demo` command in the gateway's tests. The gateway appends the scenario
// after the arguments it is given, so the first argument picks what this program does:
//   lines           writes two lines and a last one without a newline to stdout, and one line to
//                   stderr, then exits with 0
//   exit <code>     writes one line, then exits with <code>
//   hang            writes "ready", then runs until a signal ends it
//   ignore-sigterm  like hang, but on SIGTERM writes "SIGTERM ignored" and runs on (on POSIX only:
//                   Windows ends the process instead)
//   describe        writes its arguments, its working folder and its QUORUM_* variables (any case) as
//                   JSON on one line, then exits with 0
// Plain JavaScript, so that Node runs it without type stripping.
const [mode, ...rest] = process.argv.slice(2);

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
    setInterval(() => {}, 60_000);
    break;
  case 'hang':
    console.log('ready');
    setInterval(() => {}, 60_000);
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
