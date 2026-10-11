import { runWorker } from '../nutrition/worker.js';
let target;
process.once('message', job => { target = job.testFault; });
runWorker({ fault: phase => { if (phase === target) process.kill(process.pid, 'SIGKILL'); } });
