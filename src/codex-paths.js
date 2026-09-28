'use strict';

const os = require('os');
const path = require('path');

// An explicit home is also an isolation boundary for callers with temporary
// profiles. It must never fall through to the agent host's CODEX_HOME. Production
// callers that supply home and want the active Codex profile can also pass
// codexHome: resolveCodexHome().
function resolveCodexHome(options = {}) {
  if (typeof options.codexHome === 'string' && options.codexHome.trim()) {
    return path.resolve(options.codexHome);
  }
  if (options.home !== undefined) {
    if (typeof options.home !== 'string' || !options.home.trim()) {
      throw new TypeError('home must be a nonempty path');
    }
    return path.resolve(options.home, '.codex');
  }
  const configured = process.env.CODEX_HOME;
  return typeof configured === 'string' && configured.trim()
    ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

module.exports = { resolveCodexHome };
