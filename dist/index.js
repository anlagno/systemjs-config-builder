'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
/**
 * Copyright 2016 Alexis Vincent (http://alexisvincent.io)
 */
var fs = require('graceful-fs');
var path = require('path').posix;
var Promise = require('bluebird');
var _ = require('lodash');

var _require = require('jspm-npm/lib/node-conversion'),
    convertPackage = _require.convertPackage;

var _require2 = require('util'),
    inspect = _require2.inspect;

var semver = require('semver');

var nodeCoreModules = exports.nodeCoreModules = ['assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https', 'module', 'net', 'os', 'path', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty', 'url', 'util', 'vm', 'zlib'];

var nodeJspmModules = {};

var pfs = {};

/**
 * Promisify all fs functions
 */
Object.keys(fs).map(function (key) {
    if (typeof fs[key] == 'function') pfs[key] = Promise.promisify(fs[key]);
});

var log = function log(obj) {
    return console.log(inspect(obj, { depth: null }));
};

/**
 * Get all directories in a directory
 * @param srcpath
 * @returns {Promise.<*>}
 */
var getDirectories = function getDirectories(srcpath) {
    return pfs.readdir(srcpath).then(function (dirs) {
        return dirs.filter(function (file) {
            return fs.statSync(path.join(srcpath, file)).isDirectory();
        });
    }).then(function (dirs) {
        return Promise.all(dirs.map(function (dir) {
            if (dir.startsWith('@')) {
                return getDirectories(path.join(srcpath, dir)).then(function (subdirs) {
                    return subdirs.map(function (subdir) {
                        return path.join(dir, subdir);
                    });
                });
            } else {
                return dir;
            }
        }));
    }).then(function (dirs) {
        // Flatten array in case there are scoped packages that produce a nested array
        return [].concat.apply([], dirs);
    });
};

/**
 * For a given dir, get the corresponding package.json
 * @param dir
 * @returns {Promise.<TResult>}
 */
var getPackageConfig = exports.getPackageConfig = function getPackageConfig(dir) {
    return pfs.readFile(path.join(dir, 'package.json'), 'utf8').then(JSON.parse)
    // Pad it with defaults
    .then(function (config) {
        return Object.assign({
            dependencies: {},
            devDependencies: {},
            peerDependencies: {},
            augmented: false
        }, config);
    }).catch(function () {
        return null;
    });
};

/**
 * Return the dependencies that live in the first level of node_modules
 * @param packageDir
 * @returns {Promise.<TResult>}
 */
var getOwnDeps = exports.getOwnDeps = function getOwnDeps(packageDir) {
    var node_modules = path.join(packageDir, 'node_modules');

    return pfs.access(node_modules).then(function () {
        return getDirectories(node_modules);
    })
    // Map directories to their package.json
    .then(function (dirs) {
        return Promise.all(dirs.map(function (dir) {
            return getPackageConfig(path.join(packageDir, 'node_modules', dir));
        }));
    })
    // Filter out anything that wasn't a package
    .then(function (configs) {
        return configs.filter(function (v, k) {
            return v;
        });
    }).catch(function (err) {
        // console.log(err)
        return [];
    });
};

/**
 * Trace the full node_modules tree, and build up a registry on the way.
 *
 * Registry is of the form:
 * {
 *    'lodash@1.1.2': {
 *      name: 'lodash',
 *      config: <the package.json file>,
 *      key: 'lodash@1.1.2',
 *      location: 'node_modules/lodash'
 *    },
 *    ...
 * }
 *
 * Returned Tree is of the form:
 * [
 *    {
 *      name: 'react',
 *      version: '15.4.1',
 *      deps: <tree, like this one>
 *    },
 *    ...
 * ]
 *
 *
 * @param directory
 * @param name
 * @param version
 * @param registry
 * @returns {Promise.<{tree: *, registry: Array}>}
 */
var traceModuleTree = exports.traceModuleTree = function traceModuleTree(directory) {
    var name = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;
    var version = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;
    var registry = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : {};


    return Promise.resolve({ name: name, version: version })
    // Resolve the package.json and set name and version from there if either is not specified
    .then(function (_ref) {
        var name = _ref.name,
            version = _ref.version;

        if (!name || !version) {
            // Always add the target module to registry
            return getPackageConfig(directory).then(function (dep) {
                var versionName = dep.name + '@' + dep.version;
                registry[versionName] = {
                    name: dep.name,
                    config: dep,
                    key: versionName,
                    location: path.join(directory)
                };
                return Promise.resolve({ name: dep.name, version: dep.version });
            });
        } else {
            return Promise.resolve({ name: name, version: version });
        }
    }).then(function (_ref2) {
        var name = _ref2.name,
            version = _ref2.version;
        return (

            // Get the dependencies in node_modules
            getOwnDeps(directory)

            // Merge package { name@version : package.json } into the registry
            .then(function (ownDeps) {
                // console.log(ownDeps)
                ownDeps.forEach(function (dep) {
                    var versionName = dep.name + '@' + dep.version;
                    registry[versionName] = {
                        name: dep.name,
                        config: dep,
                        key: versionName,
                        location: path.join(directory, 'node_modules', dep.name)
                    };
                });

                return ownDeps;
            }).then(function (ownDeps) {
                // map each package.json to it's own tree
                return Promise.all(ownDeps.map(function (_ref3) {
                    var name = _ref3.name,
                        version = _ref3.version;

                    return traceModuleTree(path.join(directory, 'node_modules', name), name, version, registry)
                    // Drop the registry
                    .then(function (_ref4) {
                        var tree = _ref4.tree,
                            registry = _ref4.registry;
                        return tree;
                    });
                    // map the module and its dep list to a tree entry
                })).then(function (deps) {
                    return { name: name, deps: deps, version: version };
                });
            }).then(function (tree) {
                return { tree: tree, registry: registry, directory: directory };
            })
        );
    });
};

var filterDevDependencies = exports.filterDevDependencies = function filterDevDependencies(_ref5) {
    var tree = _ref5.tree,
        registry = _ref5.registry,
        directory = _ref5.directory;

    var filteredRegistry = {};
    var filteredTree = {
        name: tree['name'],
        version: tree['version'],
        deps: []
    };
    return Promise.resolve({ tree: tree, registry: registry, filteredTree: filteredTree, filteredRegistry: filteredRegistry, directory: directory }).then(function (_ref6) {
        var tree = _ref6.tree,
            registry = _ref6.registry,
            filteredTree = _ref6.filteredTree,
            filteredRegistry = _ref6.filteredRegistry,
            directory = _ref6.directory;

        var target = tree['name'] + '@' + tree['version'];
        var item = registry[target];

        filterDependencies(item.config, tree, registry, filteredTree, filteredRegistry, ['dependencies', 'peerDependencies']);
        return { tree: filteredTree, registry: filteredRegistry, directory: directory };
    });
};

var filterDependencies = function filterDependencies(item, tree, registry, filteredTree, filteredRegistry, dependencyType) {
    dependencyType.forEach(function (type) {
        var depends = item[type];
        Object.keys(depends).forEach(function (dep) {
            var found = _(tree.deps).thru(function (col) {
                return _.union(col, _.map(col, 'deps'));
            }).flatten().find(function (o) {
                return !_.includes(nodeCoreModules, dep) && o.name === dep && semver.satisfies(o.version, depends[dep]) || o.name.startsWith('jspm-nodelibs') && o.name === dep;
            });
            if (found) {
                (function () {
                    filteredTree['deps'].push(found);
                    var versionName = found.name + '@' + found.version;
                    // We track the jspm shims so we can access them from the registry during systemjs config generation
                    if (found.name.startsWith('jspm-nodelibs')) {
                        nodeJspmModules[found.name] = found.version;
                    }
                    filteredRegistry[versionName] = registry[versionName];
                    setTimeout(function () {
                        filterDependencies(registry[versionName].config, tree, registry, filteredTree, filteredRegistry, dependencyType);
                    }, 0);
                })();
            }
        });
    });
};

/**
 * Take an array of objects and turn it into an object with the key being the specified key.
 *
 * objectify('name', [
 *      {name: 'Alexis', surname: 'Vincent'},
 *      {name: 'Julien', surname: 'Vincent'}
 * ])
 *
 * =>
 *
 * {
 *    'Alexis': {name: 'Alexis', surname: 'Vincent'},
 *    'Julien': {name: 'Julien', surname: 'Vincent'},
 * }
 *
 * @param key
 * @param array
 * @returns {*}
 */
var objectify = function objectify(key, array) {
    return array.reduce(function (obj, arrayItem) {
        obj[arrayItem[key]] = arrayItem;
        return obj;
    }, {});
};

/**
 * Given a registry of package.json files, use jspm/npm to augment them to be SystemJS compatible
 * @param registry
 * @returns {Promise.<TResult>}
 */
var augmentRegistry = exports.augmentRegistry = function augmentRegistry(registry) {
    return Promise.all(Object.keys(registry).map(function (key) {
        var depMap = registry[key];

        // Don't augment things that already have been (from the cache)
        var shouldAugment = !depMap.augmented;

        // Don't augment things that specify config.jspmPackage
        if (depMap.config.jspmPackage != undefined && depMap.config.jspmPackage) shouldAugment = false;

        // Don't augment things that specify config.jspmNodeConversion == false
        if (depMap.config.jspmNodeConversion !== undefined && !depMap.config.jspmNodeConversion) shouldAugment = false;

        // Don't augment things that specify config.jspm.jspmNodeConversion == false
        if (depMap.config.jspm !== undefined && depMap.config.jspm.jspmNodeConversion !== undefined && !depMap.config.jspm.jspmNodeConversion) shouldAugment = false;

        // Augment the package.json
        return shouldAugment ? convertPackage(depMap.config, ':' + key, depMap.location, console).then(function (config) {
            return Object.assign(depMap, { config: config, augmented: true });
        }).catch(log) : depMap;
    })).then(objectify.bind(null, 'key'));
};

/**
 * Convenience method to allow easy chaining
 * @param tree
 * @param registry
 */
var augmentModuleTree = exports.augmentModuleTree = function augmentModuleTree(_ref7) {
    var tree = _ref7.tree,
        registry = _ref7.registry,
        directory = _ref7.directory;
    return augmentRegistry(registry).then(function (registry) {
        return { tree: tree, registry: registry, directory: directory };
    });
};

/**
 * Only keep keys we are interested in for package config generation
 * @param registry
 * @returns {Promise.<*>}
 */
var pruneRegistry = exports.pruneRegistry = function pruneRegistry(registry) {
    return Promise.resolve(objectify('key', Object.keys(registry).map(function (key) {
        return Object.assign({}, registry[key], {
            config: _.pick(registry[key].config, ['meta', 'map', 'main', 'format', 'defaultExtension', 'defaultJSExtensions'])
        });
    })));
};

/**
 * Convenience method to allow easy chaining
 * @param tree
 * @param registry
 */
var pruneModuleTree = exports.pruneModuleTree = function pruneModuleTree(_ref8) {
    var tree = _ref8.tree,
        registry = _ref8.registry,
        directory = _ref8.directory;
    return pruneRegistry(registry).then(function (registry) {
        return { tree: tree, registry: registry, directory: directory };
    });
};

/**
 * Walk the tree, call f on all nodes.
 * @param tree
 * @param registry
 * @param f - (versionName, deps, tree)
 * @param depth - How deep should we go
 * @param skip - How many levels should we skip
 */
var walkTree = exports.walkTree = function walkTree(_ref9, f) {
    var tree = _ref9.tree,
        registry = _ref9.registry;
    var depth = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : Infinity;
    var skip = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : 0;

    if (depth >= 1) {
        var name = tree.name,
            deps = tree.deps,
            version = tree.version;

        if (skip <= 0) {
            if (!registry[name + '@' + version]) console.log('Cant find module [' + name + '@' + version + '], Perhaps the depth tree walk was too shallow?');else f(registry[name + '@' + version], deps, tree);
        }

        if (depth >= 2) deps.forEach(function (tree) {
            return walkTree({ tree: tree, registry: registry }, f, depth - 1, skip - 1);
        });
    }
};

_.mixin({
    deeply: function deeply(map) {
        return function (obj, fn) {
            return map(_.mapValues(obj, function (v) {
                return _.isPlainObject(v) ? _.deeply(map)(v, fn) : v;
            }), fn);
        };
    }
});

/**
 * Use the tree and registry to create a SystemJS config
 *
 * TODO: Use SystemJS 20 normalize idempotency to optimize mappings
 * // Do this by mapping package@version to location like JSPM does
 *
 * @param tree
 * @param registry
 * @returns {Promise.<{map: {}, packages: {}}>}
 */
var generateConfig = exports.generateConfig = function generateConfig(_ref10) {
    var tree = _ref10.tree,
        registry = _ref10.registry,
        directory = _ref10.directory;


    var systemConfig = {
        "map": {},
        "packages": {}
    };

    // get readable stream working
    // TODO: Fix this hack
    systemConfig['map']["_stream_transform"] = "node_modules/readable-stream/transform";

    // Walk first level of dependencies and map package name to location
    walkTree({ tree: tree, registry: registry }, function (_ref11, deps) {
        var name = _ref11.name,
            config = _ref11.config,
            key = _ref11.key,
            location = _ref11.location;

        systemConfig['map'][name] = location;
    }, 2, 1);

    // Walk full dep tree and assign package config entries
    walkTree({ tree: tree, registry: registry }, function (_ref12, deps, tree) {
        var name = _ref12.name,
            config = _ref12.config,
            key = _ref12.key,
            location = _ref12.location;


        // Construct package entry based off config
        var packageEntry = Object.assign({
            map: {},
            meta: {}
        }, config);

        // Add mappings for it's deps.
        walkTree({ tree: tree, registry: registry }, function (_ref13, deps) {
            var name = _ref13.name,
                config = _ref13.config,
                key = _ref13.key,
                location = _ref13.location;

            packageEntry['map'][name] = location;
        }, 2, 1);

        // If there are no mappings, don't pollute the config
        if (Object.keys(packageEntry['map']).length == 0) delete packageEntry['map'];

        // Assign package entry to config
        systemConfig['packages'][location] = packageEntry;

        // Add mappings for all jspm-nodelibs
        // TODO: Fix this hack
        nodeCoreModules.forEach(function (lib) {
            var jspmNodelibVersion = nodeJspmModules['jspm-nodelibs-' + lib];
            if (jspmNodelibVersion != undefined) {
                systemConfig['map'][lib] = registry['jspm-nodelibs-' + lib + '@' + jspmNodelibVersion].location;
            }
        });
    }, Infinity, 1);

    // TODO: Make the mappings here more universal
    // map nm: -> node_modules/ to make config smaller
    systemConfig['paths'] = {
        'nm:': 'node_modules/'
    };

    // map nm: -> node_modules/ to make config smaller
    Object.keys(systemConfig['map']).forEach(function (key) {
        systemConfig['map'][key] = systemConfig['map'][key].replace(/^node_modules\//, 'nm:');
    });

    // map nm: -> node_modules/ to make config smaller
    Object.keys(systemConfig['packages']).forEach(function (key) {
        if (key.startsWith('node_modules/')) {
            systemConfig['packages'][key.replace(/^node_modules\//, 'nm:')] = systemConfig['packages'][key];
            delete systemConfig['packages'][key];
        }
    });

    // TODO: double object walk is really hacky...
    var mySystemConfig = _.deeply(_.mapValues)(systemConfig, function (val, key) {
        if (typeof val === 'string' || val instanceof String) {
            return _.replace(val, path.join(directory, 'node_modules' + path.sep), 'nm:');
        } else {
            return val;
        }
    });

    mySystemConfig = _.deeply(_.mapKeys)(mySystemConfig, function (val, key) {
        return _.replace(key, path.join(directory, 'node_modules' + path.sep), 'nm:');
    });

    return Promise.resolve(mySystemConfig);
};

// TODO: This needs to be done better (fails if locations of shit changes)
var mergeCache = exports.mergeCache = function mergeCache(registry, cachedRegistry) {
    return Object.assign({}, registry, cachedRegistry);
};

var fromCache = exports.fromCache = function fromCache(_ref14) {
    var tree = _ref14.tree,
        registry = _ref14.registry,
        directory = _ref14.directory;

    return dehydrateCache().then(function (cachedRegistry) {
        return { tree: tree, registry: mergeCache(registry, cachedRegistry), directory: directory };
    });
};

/**
 * Convenience method to allow easy chaining
 * @param tree
 * @param registry
 * @returns {Promise.<{tree: *, registry: *}>}
 */
var toCache = exports.toCache = function toCache(_ref15) {
    var tree = _ref15.tree,
        registry = _ref15.registry,
        directory = _ref15.directory;

    return hydrateCache(registry).then(function () {
        return { tree: tree, registry: registry, directory: directory };
    });
};

var serializeConfig = exports.serializeConfig = function serializeConfig(config) {
    return 'SystemJS.config(' + JSON.stringify(config, null, 2) + ')';
};

/**
 * Write registry to ./systemjs.cache
 * @param registry
 * @returns {Promise.<TResult>}
 */
var hydrateCache = function hydrateCache(registry) {
    return Promise.resolve(JSON.stringify(registry)).then(pfs.writeFile.bind(null, './systemjs.cache'));
};

/**
 * Construct registry from ./systemjs.cache
 * @returns {Promise.<TResult>}
 */
var dehydrateCache = function dehydrateCache() {
    return pfs.readFile('./systemjs.cache', 'utf8').then(JSON.parse).catch(function (e) {
        console.log("No cache, parsing node_modules. Warning this may take a while.");
        return {};
    });
};