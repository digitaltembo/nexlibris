import { TextWork } from './textWork';
import { serveWorker } from './workerRpc';

serveWorker(new TextWork());
