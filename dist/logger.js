"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const winston = require("winston");
const fs = require("fs");
const path = require("path");
const config = require("../conf/config.js");
const tsFormat = () => (new Date()).toUTCString();
/**
 * This module exports a singleton wrapper around a winston logger configured
 * by parameters in the config.js file.  The reason it exists is to allow all
 * components to share a common logger, and more importantly for performance
 * reasons.  The logging methods (debug, info, etc) exposed on the object accept
 * a function returning an array of actual parameters passed to the logger instead
 * of directly accepting the parameters.  The reason for that is JavaScript is not a
 * big-boy language like Haskell or Scala, and has only eager evaluation instead of
 * lazy evaluation.  That means if you do something like:
 *
 *      log.debug( JSON.stringify( really_big_object ) );
 *
 * you'll pay the penalty of stringifying the damn object regardless of the debug level.
 * But the methods on this Logger class only evaluate the function passed to it if the
 * logger would actually do something with them. Therefore, doing this:
 *
 *      logger.debug( () => [JSON.stringify( really_big_object )] );
 *
 * doesn't call stringify anything unless the logger processes debug messages.
 */
class Logger {
    constructor() {
        this.levels = { error: 0, warn: 1, info: 2, verbose: 3, debug: 4, silly: 5 };
        // Create the log directory if it does not exist
        if (!fs.existsSync(config.logger.directory)) {
            fs.mkdirSync(config.logger.directory);
        }
        // Configure singleton logging object
        this._logger_ = new (winston.Logger)({
            levels: this.levels,
            level: config.logger.level,
            transports: [
                // colorize the output to the console
                new (winston.transports.Console)({
                    timestamp: tsFormat,
                    colorize: true,
                    //level: config.logger.console_level
                    level: config.logger.level
                }),
                new (winston.transports.File)({
                    filename: config.logger.directory + path.sep + config.logger.filename,
                    timestamp: tsFormat,
                    // level: config.logger.file_level
                    level: config.logger.level
                })
            ]
        });
        this.level = this.levels[this._logger_.level];
    }
    error(f) {
        if (this.level >= this.levels["error"]) {
            this._logger_.error.apply(null, f());
        }
    }
    warn(f) {
        if (this.level >= this.levels["warn"]) {
            this._logger_.warn.apply(null, f());
        }
    }
    info(f) {
        if (this.level >= this.levels["info"]) {
            this._logger_.info.apply(null, f());
        }
    }
    verbose(f) {
        if (this.level >= this.levels["verbose"]) {
            this._logger_.verbose.apply(null, f());
        }
    }
    debug(f) {
        if (this.level >= this.levels["debug"]) {
            this._logger_.debug.apply(null, f());
        }
    }
    silly(f) {
        if (this.level >= this.levels["silly"]) {
            this._logger_.silly.apply(null, f());
        }
    }
}
let _singleton_;
function getLogger() {
    if (typeof (_singleton_) === "undefined") {
        _singleton_ = new Logger();
    }
    return _singleton_;
}
module.exports = getLogger;
//# sourceMappingURL=logger.js.map