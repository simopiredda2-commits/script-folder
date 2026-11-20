/** `node:os` nel browser (D221). */
export const EOL = '\n';
export const hostname = () => 'browser';
export const tmpdir = () => '/tmp';
export const homedir = () => '/home';
export const platform = () => 'browser';
export const type = () => 'Browser';
export const arch = () => 'wasm';
export const release = () => '';
export const cpus = () => [];
export const totalmem = () => 0;
export const freemem = () => 0;
export const uptime = () => 0;
export const loadavg = () => [0, 0, 0];
export const networkInterfaces = () => ({});
export const userInfo = () => ({
  username: 'dimostrazione',
  uid: 0,
  gid: 0,
  shell: null,
  homedir: '/home',
});
export const constants = { signals: {}, errno: {} };

export default {
  EOL,
  hostname,
  tmpdir,
  homedir,
  platform,
  type,
  arch,
  release,
  cpus,
  totalmem,
  freemem,
  uptime,
  loadavg,
  networkInterfaces,
  userInfo,
  constants,
};
