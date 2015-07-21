'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {NuclideUri} from 'nuclide-remote-uri';

var {PromiseQueue} = require('nuclide-commons');

var ERROR_RESPONSES = new Set([
  'failure',
  'error',
  'exception',
]);

/**
 * Wraps an ocamlmerlin process; provides api access to
 * ocamlmerlin's json-over-stdin/stdout protocol.
 *
 * This is based on the protocol description at:
 *   https://github.com/the-lambda-church/merlin/blob/master/PROTOCOL.md
 *   https://github.com/the-lambda-church/merlin/tree/master/src/frontend
 */
class MerlinProcess {
  _proc: child_process$ChildProcess;
  _promiseQueue: PromiseQueue;
  _running: bool;

  constructor(proc: child_process$ChildProcess) {
    this._proc = proc;
    this._promiseQueue = new PromiseQueue();
    this._running = true;
    this._proc.on('exit', (code, signal) => { this._running = false; });
  }

  isRunning(): bool {
    return this._running;
  }

  /**
   * Tell merlin where to find its per-repo .merlin config file.
   *
   * Configuration file format description:
   *   https://github.com/the-lambda-church/merlin/wiki/project-configuration
   *
   * @return a dummy cursor position on success
   */
  async pushDotMerlinPath(path: NuclideUri): Promise<mixed> {
    return await this._promiseQueue.submit(async (resolve, reject) => {
      var result = await this.runSingleCommand([
        'reset',
        'dot_merlin',
        [path],
        'auto',
      ]);
      resolve(result);
    });
  }

  /**
   * Set the buffer content to query against. Merlin uses an internal
   * buffer (name + content) that is independent from file content on
   * disk.
   *
   * @return on success: a cursor position pointed at the end of the buffer
   */
  async pushNewBuffer(name: NuclideUri, content): Promise<mixed> {
    return await this._promiseQueue.submit(async (resolve, reject) => {
      await this.runSingleCommand([
        'reset',
        'auto', // one of {ml, mli, auto}
        name,
      ]);

      var result = await this.runSingleCommand([
        'tell',
        'source',
        content,
      ]);
      resolve(result);
    });
  }

  /**
   * Find definition
   *
   * `kind` is one of 'ml' or 'mli'
   *
   * Note: ocamlmerlin line numbers are 1-based.
   * @return null if nothing was found; a position of the form
   *   {"file": "somepath", "pos": {"line": 41, "col": 5}}.
   */
  async locate(path: NuclideUri, line, col, kind): Promise<mixed> {
    return await this._promiseQueue.submit(async (resolve, reject) => {
      var location = await this.runSingleCommand([
        'locate',
        /* identifier name */ '',
        kind,
        'at',
        {line: line + 1, col},
      ]);


      if (typeof location === 'string') {
        return reject(Error(location));
      }

      // Ocamlmerlin doesn't include a `file` field at all if the destination is
      // in the same file.
      if (!location.file) {
        location.file = path;
      }

      resolve(location);
    });
  }

  async complete(path: NuclideUri, line, col, prefix): Promise<mixed> {
    return await this._promiseQueue.submit(async (resolve, reject) => {
       var result = await this.runSingleCommand([
          'complete',
          'prefix',
          prefix,
          'at',
          {line: line + 1, col: col + 1},
       ]);

       resolve(result);
    });
  }


  /**
   * Run a command; parse the json output, return an object. This assumes
   * that merlin's protocol is line-based (results are json objects rendered
   * on a single line).
   */
  runSingleCommand(command: mixed): Promise<mixed> {
    var logger = require('nuclide-logging').getLogger();

    var command = JSON.stringify(command);
    var stdin = this._proc.stdin;
    var stdout = this._proc.stdout;

    return new Promise((resolve, reject) => {
      var readline = require('readline');
      var reader = readline.createInterface({
        input: stdout,
        terminal: false,
      });

      reader.on('line', (line) => {
        reader.close();
        var response;
        try {
          response = JSON.parse(line);
        } catch (err) {
          response = null;
        }
        if (!response || !Array.isArray(response) || response.length !== 2) {
          logger.error('Unexpected response from ocamlmerlin: ${line}');
          reject(Error('Unexpected ocamlmerlin output format'));
          return;
        }

        var status = response[0];
        var content = response[1];

        if (ERROR_RESPONSES.has(status)) {
          logger.error('Ocamlmerlin raised an error: ' + line);
          reject(Error('Ocamlmerlin returned an error'));
          return;
        }

        resolve(content);
      });

      stdin.write(command);
    });
  }

  dispose() {
    this._proc.kill();
  }
}

module.exports = MerlinProcess;
