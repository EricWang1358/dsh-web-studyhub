const prefix='daily-flashcard-demo-file:';
export const mkdir=async()=>{};
export async function readFile(path){let value=localStorage.getItem(prefix+path);if(value===null && path==='/demo/study/board.json'){value=JSON.stringify(sampleBoard());localStorage.setItem(prefix+path,value);}if(value===null)throw Object.assign(new Error('Missing demo file'),{code:'ENOENT'});return value;}
export async function writeFile(path,value){localStorage.setItem(prefix+path,value);}
export async function rename(from,to){await writeFile(to,await readFile(from));await rm(from);}
export async function rm(path){localStorage.removeItem(prefix+path);}
export const homedir=()=>'/demo';
export const tmpdir=()=>{throw new Error('Temporary files require the installed plugin.');};
const queues=new Map();
export default {async lock(key){const prior=queues.get(key)||Promise.resolve();let release;const pending=new Promise(resolve=>{release=resolve;});queues.set(key,prior.then(()=>pending));await prior;return release;}};
import { sampleBoard } from './board-seed.js';
