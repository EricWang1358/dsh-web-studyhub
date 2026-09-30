export function unavailable() { throw new Error('此功能需要本地插件。网页体验版请使用内置资料和示例题组。'); }
export const extractPdf = unavailable, importLegacy = unavailable;
// Match fs/promises: callers can handle absent desktop files with .catch().
const unavailableAsync = async () => unavailable();
export const open = unavailableAsync, readdir = unavailableAsync, stat = unavailableAsync, readFile = unavailableAsync, realpath = unavailableAsync;
export const createReadStream = unavailable, spawn = unavailable;
export const appendFile = unavailable, mkdir = unavailable, rm = unavailable, writeFile = unavailable;
export const rename = unavailable, copyFile = unavailable, mkdtemp = unavailable;
export const MAX_PDF_BYTES = 8 * 1024 * 1024, MAX_REQUEST_BYTES = 12 * 1024 * 1024;
export const join = (...parts) => parts.join('/');
export const basename = p => p.split(/[\\/]/).pop();
export const extname = p => /\.[^./\\]+$/.exec(p)?.[0] || '';
export const isAbsolute = p => p.startsWith('/') || /^[A-Z]:/i.test(p);
export const relative = (a,b) => b;
export const win32 = { basename };
export default { join, basename, extname, isAbsolute, relative, win32, request: unavailable };
