/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const DeltaCalculator = require('./DeltaCalculator');

const createModuleIdFactory = require('../lib/createModuleIdFactory');
const crypto = require('crypto');
const defaults = require('../defaults');
const getPreludeCode = require('../lib/getPreludeCode');

const {wrapModule} = require('./Serializers/helpers/js');
const {EventEmitter} = require('events');

import type Bundler from '../Bundler';
import type {Options as JSTransformerOptions} from '../JSTransformer/worker';
import type DependencyGraph from '../node-haste/DependencyGraph';
import type Module from '../node-haste/Module';
import type {BundleOptions} from '../shared/types.flow';
import type {MainOptions} from './';
import type {DependencyEdge, DependencyEdges} from './traverseDependencies';
import type {MetroSourceMapSegmentTuple} from 'metro-source-map';

export type DeltaEntryType =
  | 'asset'
  | 'module'
  | 'script'
  | 'comment'
  | 'require';

export type DeltaEntry = {|
  +code: string,
  +id: number,
  +map: Array<MetroSourceMapSegmentTuple>,
  +name: string,
  +path: string,
  +source: string,
  +type: DeltaEntryType,
|};

export type DeltaEntries = Map<number, ?DeltaEntry>;

export type DeltaTransformResponse = {|
  +id: string,
  +pre: DeltaEntries,
  +post: DeltaEntries,
  +delta: DeltaEntries,
  +reset: boolean,
|};

const globalCreateModuleId = createModuleIdFactory();

/**
 * This class is in charge of creating the delta bundle with the actual
 * transformed source code for each of the modified modules. For each modified
 * module it returns a `DeltaModule` object that contains the basic information
 * about that file. Modules that have been deleted contain a `null` module
 * parameter.
 *
 * The actual return format is the following:
 *
 *   {
 *     pre: [{id, module: {}}],   Scripts to be prepended before the actual
 *                                modules.
 *     post: [{id, module: {}}],  Scripts to be appended after all the modules
 *                                (normally the initial require() calls).
 *     delta: [{id, module: {}}], Actual bundle modules (dependencies).
 *   }
 */
class DeltaTransformer extends EventEmitter {
  _bundler: Bundler;
  _dependencyGraph: DependencyGraph;
  _getPolyfills: ({platform: ?string}) => $ReadOnlyArray<string>;
  _polyfillModuleNames: $ReadOnlyArray<string>;
  _getModuleId: (path: string) => number;
  _deltaCalculator: DeltaCalculator;
  _bundleOptions: BundleOptions;
  _currentBuildPromise: ?Promise<DeltaTransformResponse>;
  _lastSequenceId: ?string;

  constructor(
    bundler: Bundler,
    dependencyGraph: DependencyGraph,
    deltaCalculator: DeltaCalculator,
    options: MainOptions,
    bundleOptions: BundleOptions,
  ) {
    super();

    this._bundler = bundler;
    this._dependencyGraph = dependencyGraph;
    this._deltaCalculator = deltaCalculator;
    this._getPolyfills = options.getPolyfills;
    this._polyfillModuleNames = options.polyfillModuleNames;
    this._bundleOptions = bundleOptions;

    // Only when isolateModuleIDs is true the Module IDs of this instance are
    // sandboxed from the rest.
    // Isolating them makes sense when we want to get consistent module IDs
    // between different builds of the same bundle (for example when building
    // production builds), while coupling them makes sense when we want
    // different bundles to share the same ids (on HMR, where we need to patch
    // the correct module).
    this._getModuleId = this._bundleOptions.isolateModuleIDs
      ? (bundleOptions.createModuleIdFactory || createModuleIdFactory)()
      : globalCreateModuleId;

    this._deltaCalculator.on('change', this._onFileChange);
  }

  static async create(
    bundler: Bundler,
    options: MainOptions,
    bundleOptions: BundleOptions,
  ): Promise<DeltaTransformer> {
    const dependencyGraph = await bundler.getDependencyGraph();

    const deltaCalculator = new DeltaCalculator(bundler, dependencyGraph, {
      ...bundleOptions,
      entryPoints: [bundleOptions.entryFile],
      type: 'module',
    });

    return new DeltaTransformer(
      bundler,
      dependencyGraph,
      deltaCalculator,
      options,
      bundleOptions,
    );
  }

  /**
   * Destroy the Delta Transformer and its calculator. This should be used to
   * clean up memory and resources once this instance is not used anymore.
   */
  end() {
    this.removeAllListeners();

    return this._deltaCalculator.end();
  }

  /**
   * Returns a function that can be used to calculate synchronously the
   * transitive dependencies of any given file within the dependency graph.
   **/
  async getDependenciesFn(): Promise<(string) => Set<string>> {
    if (!this._deltaCalculator.getGraph().dependencies.size) {
      // If by any means the dependency graph has not been initialized, call
      // getDelta() to initialize it.
      await this._getDelta({reset: false});
    }

    return this._getDependencies;
  }

  /**
   * Returns a function that can be used to calculate synchronously the
   * transitive dependencies of any given file within the dependency graph.
   **/
  async getInverseDependencies(): Promise<Map<number, $ReadOnlyArray<number>>> {
    const graph = this._deltaCalculator.getGraph();

    if (!graph.dependencies.size) {
      // If by any means the dependency graph has not been initialized, call
      // getDelta() to initialize it.
      await this._getDelta({reset: false});
    }

    const output = new Map();

    for (const [path, {inverseDependencies}] of graph.dependencies.entries()) {
      output.set(
        this._getModuleId(path),
        Array.from(inverseDependencies).map(dep => this._getModuleId(dep)),
      );
    }

    return output;
  }

  /**
   * Main method to calculate the bundle delta. It returns a DeltaResult,
   * which contain the source code of the modified and added modules and the
   * list of removed modules.
   */
  async getDelta(sequenceId: ?string): Promise<DeltaTransformResponse> {
    // If the passed sequenceId is different than the last calculated one,
    // return a reset delta (since that means that the client is desynchronized)
    const reset = !!this._lastSequenceId && sequenceId !== this._lastSequenceId;

    // If there is already a build in progress, wait until it finish to start
    // processing a new one (delta transformer doesn't support concurrent
    // builds).
    if (this._currentBuildPromise) {
      await this._currentBuildPromise;
    }

    this._currentBuildPromise = this._getDelta({reset});

    let result;

    try {
      result = await this._currentBuildPromise;
    } finally {
      this._currentBuildPromise = null;
    }

    return result;
  }

  async _getDelta({
    reset: resetDelta,
  }: {
    reset: boolean,
  }): Promise<DeltaTransformResponse> {
    // Calculate the delta of modules.
    const {modified, deleted, reset} = await this._deltaCalculator.getDelta({
      reset: resetDelta,
    });
    const graph = this._deltaCalculator.getGraph();

    const transformerOptions = await this._deltaCalculator.getTransformerOptions();

    // Return the source code that gets prepended to all the modules. This
    // contains polyfills and startup code (like the require() implementation).
    const prependSources = reset
      ? await this._getPrepend(transformerOptions, graph.dependencies)
      : new Map();

    // Precalculate all module ids sequentially. We do this to be sure that the
    // mapping between module -> moduleId is deterministic between runs.
    const modules = Array.from(modified.values());
    modules.forEach(module => this._getModuleId(module.path));

    // Get the transformed source code of each modified/added module.
    const modifiedDelta = await this._transformModules(
      modules,
      transformerOptions,
      graph.dependencies,
    );

    deleted.forEach(id => {
      modifiedDelta.set(this._getModuleId(id), null);
    });

    // Return the source code that gets appended to all the modules. This
    // contains the require() calls to startup the execution of the modules.
    const appendSources = reset
      ? await this._getAppend(graph.dependencies)
      : new Map();

    // generate a random
    this._lastSequenceId = crypto.randomBytes(8).toString('hex');

    return {
      pre: prependSources,
      post: appendSources,
      delta: modifiedDelta,
      reset,
      id: this._lastSequenceId,
    };
  }

  _getDependencies = (path: string): Set<string> => {
    const graph = this._deltaCalculator.getGraph();

    const dependencies = this._getDeps(path, graph.dependencies, new Set());

    // Remove the main entry point, since this method only returns the
    // dependencies.
    dependencies.delete(path);

    return dependencies;
  };

  _getDeps(
    path: string,
    edges: DependencyEdges,
    deps: Set<string>,
  ): Set<string> {
    if (deps.has(path)) {
      return deps;
    }

    const edge = edges.get(path);

    if (!edge) {
      return deps;
    }

    deps.add(path);

    for (const [, dependencyPath] of edge.dependencies) {
      this._getDeps(dependencyPath, edges, deps);
    }

    return deps;
  }

  async _getPrepend(
    transformOptions: JSTransformerOptions,
    dependencyEdges: DependencyEdges,
  ): Promise<DeltaEntries> {
    const preludeId = this._getModuleId('__prelude__');

    // Get all the polyfills from the relevant option params (the
    // `getPolyfills()` method and the `polyfillModuleNames` variable).
    const polyfillModuleNames = this._getPolyfills({
      platform: this._bundleOptions.platform,
    }).concat(this._polyfillModuleNames);

    // Build the module system dependencies (scripts that need to
    // be included at the very beginning of the bundle) + any polifyll.
    const modules = [defaults.moduleSystem]
      .concat(polyfillModuleNames)
      .map(polyfillModuleName =>
        this._dependencyGraph.createPolyfill({
          file: polyfillModuleName,
          id: polyfillModuleName,
          dependencies: [],
        }),
      );

    const edges = await Promise.all(
      modules.map(module =>
        this._createEdgeFromScript(module, transformOptions),
      ),
    );

    const transformedModules = await this._transformModules(
      edges,
      transformOptions,
      dependencyEdges,
    );
    // The prelude needs to be the first thing in the file, and the insertion
    // order of entries in the Map is significant.
    return new Map([
      [preludeId, this._getPrelude(preludeId)],
      ...transformedModules,
    ]);
  }

  _getPrelude(id: number): DeltaEntry {
    const code = getPreludeCode({isDev: this._bundleOptions.dev});
    const name = '__prelude__';
    return {code, id, map: [], name, source: code, path: name, type: 'script'};
  }

  async _getAppend(dependencyEdges: DependencyEdges): Promise<DeltaEntries> {
    // First, get the modules correspondant to all the module names defined in
    // the `runBeforeMainModule` config variable. Then, append the entry point
    // module so the last thing that gets required is the entry point.
    const append = new Map(
      this._bundleOptions.runBeforeMainModule
        .concat(this._bundleOptions.entryFile)
        .filter(path => dependencyEdges.has(path))
        .map(this._getModuleId)
        .map(moduleId => {
          const code = `require(${JSON.stringify(moduleId)});`;
          const name = 'require-' + String(moduleId);
          const path = name + '.js';

          return [
            moduleId,
            {
              code,
              id: moduleId,
              map: [],
              name,
              source: code,
              path,
              type: 'require',
            },
          ];
        }),
    );

    if (this._bundleOptions.sourceMapUrl) {
      const code = '//# sourceMappingURL=' + this._bundleOptions.sourceMapUrl;
      const id = this._getModuleId('/sourcemap.js');

      append.set(id, {
        code,
        id,
        map: [],
        name: 'sourcemap.js',
        path: '/sourcemap.js',
        source: code,
        type: 'comment',
      });
    }

    return append;
  }

  async _transformModules(
    modules: Array<DependencyEdge>,
    transformOptions: JSTransformerOptions,
    dependencyEdges: DependencyEdges,
  ): Promise<DeltaEntries> {
    return new Map(
      await Promise.all(
        modules.map(module =>
          this._transformModule(module, transformOptions, dependencyEdges),
        ),
      ),
    );
  }

  async _createEdgeFromScript(
    module: Module,
    transformOptions: JSTransformerOptions,
  ): Promise<DependencyEdge> {
    const result = await module.read(transformOptions);

    const edge = {
      dependencies: new Map(),
      inverseDependencies: new Set(),
      path: module.path,
      output: {
        code: result.code,
        map: result.map,
        source: result.source,
        type: 'script',
      },
    };

    return edge;
  }

  async _transformModule(
    edge: DependencyEdge,
    transformOptions: JSTransformerOptions,
    dependencyEdges: DependencyEdges,
  ): Promise<[number, ?DeltaEntry]> {
    const name = this._dependencyGraph.getHasteName(edge.path);

    const wrappedCode = wrapModule(edge, {
      createModuleId: this._getModuleId,
      dev: transformOptions.dev,
    });

    const {code, map} = transformOptions.minify
      ? await this._bundler.minifyModule(
          edge.path,
          wrappedCode,
          edge.output.map,
        )
      : {code: wrappedCode, map: edge.output.map};

    const id = this._getModuleId(edge.path);

    return [
      id,
      {
        code,
        id,
        map,
        name,
        source: edge.output.source,
        path: edge.path,
        type: edge.output.type,
      },
    ];
  }

  _onFileChange = () => {
    this.emit('change');
  };
}

module.exports = DeltaTransformer;
