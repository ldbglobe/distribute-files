"use strict";

var Transfer = require('../Transfer');
var sftp = require('ssh2-sftp-client');
var path = require('path');
var os = require("os");
var Promise = require("bluebird");

module.exports = class SftpTransfer extends Transfer {

    setupConnection() {
        this.conn = new sftp();
    }

    connect() {
        if (this.connected) {
            return Promise.resolve();
        }
        if (this.connecting) {
            return this.connecting;
        }

        // in case we are disconnecting return this promise to wait until its done and then reconnect
        if (this.disconnecting) {
            return this.disconnecting.then(() => {
                return this.connect();
            });
        }

        if (this.config.debug) {
            console.log("Connecting to " + this.config.connection.host);
            this.config.connection.debug = function (val) {
                console.log(val);
            }
        }
        this.connecting = this.conn.connect(this.config.connection).then(() => {
            if (this.config.debug) {
                console.log("Connected to " + this.config.connection.host);
            }
            this.connecting = null;
            this.connected = true;
        }, (err) => {
            if (this.config.debug) {
                console.error("Error while connecting to " + this.config.connection.host);
                console.error(err);
            }
            this.connecting = null;
            return Promise.reject(err);
        });

        return this.connecting;
    }

    disconnect() {
        if (!this.connected) {
            return Promise.resolve();
        }
        if (this.disconnecting) {
            return this.disconnecting;
        }
        if (this.transferInProgress) {
            return new Promise((resolve, reject) => {
                return this.disconnect().then(resolve, reject);
            });
        }

        this.disconnecting = this.conn.end().then(() => {
            if (this.config.debug) {
                console.error("Disconnected from " + this.config.connection.host);
            }
            this.disconnecting = null;
            this.connected = false;
            this.setupConnection();
        }, (err) => {
            if (this.config.debug) {
                console.error("Failed to disconnect from " + this.config.connection.host);
            }

            this.disconnecting = null;
            this.connected = false;
            this.setupConnection();
            return Promise.reject(err);
        });

        return this.disconnecting;
    }

    remove(file, leaveConnectionOpen) {
        return new Promise((resolve, reject) => {
            if (this.config.root) {
                file = path.join(this.config.root, file);
            }

            file = path.resolve(file);
            file = path.normalize(file.split(path.sep).join("/"));

            if (os.platform() === "win32") {
                file = file.replace("C:", "");
                file = file.replace(/\\/g, "/");
            }

            return this.connect(this.config.connection).then(() => {
                return this.conn.delete(file);
            }, (err) => {
                reject(new Error("Couldn't connect to server: " + err));
            }).then(() => {
                if (!leaveConnectionOpen) {
                    return this.disconnect().then(() => {
                        return resolve();
                    });
                }
                return resolve();
            }, (err) => {
                if (!leaveConnectionOpen) {
                    return this.disconnect().then(() => {
                        return reject(new Error("Couldn't delete "+ file +" on the server: " + err));
                    });
                }
                return reject(new Error("Couldn't delete "+ file +" on the server: " + err));
            });
        });
    }

    transfer(file, targetFile, leaveConnectionOpen) {
        return new Promise((resolve, reject) => {
            this.transferInProgress = true;

            if (!targetFile) {
                targetFile = file;
            }

            if (this.config.root) {
                targetFile = path.join(this.config.root, targetFile);
            }

            targetFile = path.resolve(targetFile);

            // normalize for unix
            targetFile = path.normalize(targetFile.split(path.sep).join("/"));

            var tmpFilename = targetFile + "_tmp_" + Date.now();
            var targetPath = path.dirname(tmpFilename);
            if (os.platform() === "win32") {
                targetFile = targetFile.replace("C:", "");
                tmpFilename = tmpFilename.replace("C:", "");
                targetPath = targetPath.replace("C:", "");

                targetFile = targetFile.replace(/\\/g, "/");
                tmpFilename = tmpFilename.replace(/\\/g, "/");
                targetPath = targetPath.replace(/\\/g, "/");
            }

            return this.connect(this.config.connection).then(() => {
                return this.conn.mkdir(targetPath, true);
            }, (err) => {
                this.transferInProgress = false;
                reject(new Error("Couldn't connect to server: " + err));
            }).then(() => {
                return this.conn.put(file, tmpFilename, this.config.connection.useCompression);
            }, (err) => {
                this.transferInProgress = false;
                reject(new Error("Couldn't create target directory on the server: " + err));
            }).then(() => {
                return this.conn.delete(targetFile).then(() => {
                    return Promise.resolve();
                }, (err) => {
                    return Promise.resolve(); // if it doesn't exists, ignore this error...
                });
            }, (err) => {
                this.transferInProgress = false;
                reject(new Error("Couldn't put the file " + file + " to the server at + " + tmpFilename + ": " + err));
            }).then(() => {
                return this.conn.rename(tmpFilename, targetFile);
            }).then(() => {
                return resolve();
            }, (err) => {
                return this.conn.delete(tmpFilename, (err2) => {
                    this.transferInProgress = false;
                    return reject(err);
                });
            }).then(() => {
                this.transferInProgress = false;
                if (!leaveConnectionOpen) {
                    return this.disconnect().then(() => {
                        return Promise.resolve();
                    });
                }

                return Promise.resolve();
            }, (err) => {
                this.transferInProgress = false;
                if (!leaveConnectionOpen) {
                    return this.disconnect().then(() => {
                        return Promise.reject(err);
                    });
                }

                return Promise.reject(err);
            });
        })
    }

}