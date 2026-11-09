// 极简日志：带时间和模块名，方便看清是谁打的日志。
// 以后要换成 pino / winston 之类，只改这个文件即可。
function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

export function createLogger(moduleName) {
  const prefix = () => `[${timestamp()}] [${moduleName}]`;
  return {
    info: (...args) => console.log(prefix(), ...args),
    warn: (...args) => console.warn(prefix(), '⚠️', ...args),
    error: (...args) => console.error(prefix(), '❌', ...args),
  };
}
