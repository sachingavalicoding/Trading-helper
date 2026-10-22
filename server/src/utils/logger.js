const silent = process.env.NODE_ENV === 'test';
const stamp = () => new Date().toISOString();

export const logger = {
  info: (...a) => !silent && console.log(stamp(), '[info]', ...a),
  warn: (...a) => !silent && console.warn(stamp(), '[warn]', ...a),
  error: (...a) => console.error(stamp(), '[error]', ...a),
};
