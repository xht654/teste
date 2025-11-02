import fs from 'fs';
import path from 'path';

export default class Logger {
  constructor(module = 'General') {
    this.module = module;
    this.logDir = '/app/logs';
    this.ensureLogDir();
  }

  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] [${this.module}] ${message}`;
    
    // Console output
    console.log(logMessage);
    
    // File output
    const logFile = path.join(this.logDir, `capture_${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, logMessage + '\n');
  }

  info(message) {
    this.log(message, 'INFO');
  }

  warn(message) {
    this.log(message, 'WARN');
  }

  error(message, error = null) {
    let fullMessage = message;
    if (error) {
      fullMessage += ` | Error: ${error.message}`;
      if (error.stack) {
        fullMessage += ` | Stack: ${error.stack}`;
      }
    }
    this.log(fullMessage, 'ERROR');
  }

  debug(message) {
    if (process.env.DEBUG === 'true') {
      this.log(message, 'DEBUG');
    }
  }
}
