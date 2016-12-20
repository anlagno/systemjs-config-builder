/**
 * Copyright 2016 Alexis Vincent (http://alexisvincent.io)
 */
const fs = require('graceful-fs')
const path = require('path').posix
const Promise = require('bluebird')
const _ = require('lodash')
const {convertPackage} = require('jspm-npm/lib/node-conversion')
const {inspect} = require('util')
const semver = require('semver')

export const nodeCoreModules = [
    'assert',
    'buffer',
    'child_process',
    'cluster',
    'console',
    'constants',
    'crypto',
    'dgram',
    'dns',
    'domain',
    'events',
    'fs',
    'http',
    'https',
    'module',
    'net',
    'os',
    'path',
    'process',
    'punycode',
    'querystring',
    'readline',
    'repl',
    'stream',
    'string_decoder',
    'sys',
    'timers',
    'tls',
    'tty',
    'url',
    'util',
    'vm',
    'zlib'
];

const nodeJspmModules = {};


const pfs = {}

/**
 * Promisify all fs functions
 */
Object.keys(fs).map(key => {
    if (typeof fs[key] == 'function')
        pfs[key] = Promise.promisify(fs[key]);
})

const log = obj => console.log(inspect(obj, {depth: null}))

/**
 * Get all directories in a directory
 * @param srcpath
 * @returns {Promise.<*>}
 */
const getDirectories = (srcpath) => {
    return pfs.readdir(srcpath).then(
        dirs => dirs.filter((file) => {
            return fs.statSync(path.join(srcpath, file)).isDirectory();
        })
    ).then(dirs => {
        return Promise.all(dirs.map(dir => {
            if (dir.startsWith('@')) {
                return getDirectories(path.join(srcpath, dir)).then(subdirs => {
                    return subdirs.map(subdir => path.join(dir, subdir));
                });
            } else {
                return dir;
            }
        }));
    }).then(dirs => {
        // Flatten array in case there are scoped packages that produce a nested array
        return [].concat.apply([], dirs)
    });
}

/**
 * For a given dir, get the corresponding package.json
 * @param dir
 * @returns {Promise.<TResult>}
 */
export const getPackageConfig = (dir) => {
    return pfs.readFile(path.join(dir, 'package.json'), 'utf8')
        .then(JSON.parse)
        // Pad it with defaults
        .then(config => Object.assign({
            dependencies: {},
            devDependencies: {},
            peerDependencies: {},
            augmented: false
        }, config))
        .catch(() => null)
}

/**
 * Return the dependencies that live in the first level of node_modules
 * @param packageDir
 * @returns {Promise.<TResult>}
 */
export const getOwnDeps = (packageDir) => {
    const node_modules = path.join(packageDir, 'node_modules')

    return pfs.access(node_modules)
        .then(() => getDirectories(node_modules))
        // Map directories to their package.json
        .then(dirs => Promise.all(dirs.map(dir => getPackageConfig(path.join(packageDir, 'node_modules', dir)))))
        // Filter out anything that wasn't a package
        .then(configs => configs.filter((v, k) => v))

        .catch(err => {
            // console.log(err)
            return []
        })
}

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
export const traceModuleTree = (directory, name = false, version = false, registry = {}) => {

    return Promise.resolve({name, version})
    // Resolve the package.json and set name and version from there if either is not specified
        .then(({name, version}) => {
            if (!name || !version) {
                // Always add the target module to registry
                return getPackageConfig(directory).then(dep => {
                    const versionName = dep.name + '@' + dep.version
                    registry[versionName] = {
                        name: dep.name,
                        config: dep,
                        key: versionName,
                        location: path.join(directory)
                    }
                    return Promise.resolve({name: dep.name, version: dep.version})
                })
            } else {
                return Promise.resolve({name, version})
            }
        })
        .then(({name, version}) => (

            // Get the dependencies in node_modules
            getOwnDeps(directory)

            // Merge package { name@version : package.json } into the registry
                .then(ownDeps => {
                    // console.log(ownDeps)
                    ownDeps.forEach((dep => {
                        const versionName = dep.name + '@' + dep.version
                        registry[versionName] = {
                            name: dep.name,
                            config: dep,
                            key: versionName,
                            location: path.join(directory, 'node_modules', dep.name)
                        }
                    }))

                    return ownDeps
                })

                .then(ownDeps => {
                    // map each package.json to it's own tree
                    return Promise.all(ownDeps.map(({name, version}) => {
                        return traceModuleTree(path.join(directory, 'node_modules', name), name, version, registry)
                        // Drop the registry
                            .then(({tree, registry}) => tree)
                        // map the module and its dep list to a tree entry
                    })).then(deps => ({name, deps, version: version}))
                })

                .then(tree => ({tree, registry, directory}))
        ))
}

export const filterDevDependencies = ({tree, registry, directory}) => {
    const filteredRegistry = {};
    const filteredTree = {
        name: tree['name'],
        version: tree['version'],
        deps: []
    };
    return Promise.resolve({tree, registry, filteredTree, filteredRegistry, directory}).then(({tree, registry, filteredTree, filteredRegistry, directory}) => {
        const target = tree['name'] + '@' + tree['version']
        const item = registry[target]

        filterDependencies(item.config, tree, registry, filteredTree, filteredRegistry, ['dependencies', 'peerDependencies'])
        return {tree: filteredTree, registry: filteredRegistry, directory: directory}
    })
}

const filterDependencies = (item, tree, registry, filteredTree, filteredRegistry, dependencyType ) => {
    dependencyType.forEach((type) => {
        const depends = item[type]
        Object.keys(depends).forEach((dep) => {
            const found = _(tree.deps).thru(col => {
                return _.union(col, _.map(col, 'deps'))
            })
            .flatten()
            .find((o) => {
                return ((!_.includes(nodeCoreModules, dep) && o.name === dep && semver.satisfies(o.version, depends[dep])) || (o.name.startsWith('jspm-nodelibs') && o.name === dep))
            })
            if (found) {
                filteredTree['deps'].push(found)
                const versionName = found.name + '@' + found.version
                // We track the jspm shims so we can access them from the registry during systemjs config generation
                if (found.name.startsWith('jspm-nodelibs')) {
                    nodeJspmModules[found.name] = found.version
                }
                filteredRegistry[versionName] = registry[versionName]
                setTimeout( () => {
                    filterDependencies(registry[versionName].config, tree, registry, filteredTree, filteredRegistry, dependencyType)
                }, 0);
            }
        })
    })
}


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
const objectify = (key, array) => {
    return array.reduce((obj, arrayItem) => {
        obj[arrayItem[key]] = arrayItem
        return obj
    }, {})
}

/**
 * Given a registry of package.json files, use jspm/npm to augment them to be SystemJS compatible
 * @param registry
 * @returns {Promise.<TResult>}
 */
export const augmentRegistry = (registry) => {
    return Promise.all(Object.keys(registry)
        .map(key => {
            const depMap = registry[key]

            // Don't augment things that already have been (from the cache)
            let shouldAugment = !depMap.augmented

            // Don't augment things that specify config.jspmPackage
            if (depMap.config.jspmPackage != undefined && depMap.config.jspmPackage)
                shouldAugment = false

            // Don't augment things that specify config.jspmNodeConversion == false
            if (depMap.config.jspmNodeConversion !== undefined && !depMap.config.jspmNodeConversion)
                shouldAugment = false

            // Don't augment things that specify config.jspm.jspmNodeConversion == false
            if (depMap.config.jspm !== undefined
                && depMap.config.jspm.jspmNodeConversion !== undefined
                && !depMap.config.jspm.jspmNodeConversion)
                shouldAugment = false

            // Augment the package.json
            return shouldAugment ?
                convertPackage(depMap.config, ':' + key, depMap.location, console)
                    .then(config => Object.assign(depMap, {config, augmented: true}))
                    .catch(log) :
                depMap
        }))
        .then(objectify.bind(null, 'key'))
}

/**
 * Convenience method to allow easy chaining
 * @param tree
 * @param registry
 */
export const augmentModuleTree = ({tree, registry, directory}) => augmentRegistry(registry).then(registry => ({tree, registry, directory}))

/**
 * Only keep keys we are interested in for package config generation
 * @param registry
 * @returns {Promise.<*>}
 */
export const pruneRegistry = (registry) => {
    return Promise.resolve(
        objectify('key',
            Object.keys(registry)
                .map(key => {
                        return Object.assign({}, registry[key], {
                            config: _.pick(
                                registry[key].config, [
                                    'meta',
                                    'map',
                                    'main',
                                    'format',
                                    'defaultExtension',
                                    'defaultJSExtensions'
                                ])
                        })
                    }
                ))
    )
}

/**
 * Convenience method to allow easy chaining
 * @param tree
 * @param registry
 */
export const pruneModuleTree = ({tree, registry, directory}) => pruneRegistry(registry).then(registry => ({tree, registry, directory}))

/**
 * Walk the tree, call f on all nodes.
 * @param tree
 * @param registry
 * @param f - (versionName, deps, tree)
 * @param depth - How deep should we go
 * @param skip - How many levels should we skip
 */
export const walkTree = ({tree, registry}, f, depth = Infinity, skip = 0) => {
    if (depth >= 1) {
        const {name, deps, version} = tree
        if (skip <= 0) {
            if (!registry[name + '@' + version])
                console.log('Cant find module [' + name + '@' + version + '], Perhaps the depth tree walk was too shallow?')
            else
                f(registry[name + '@' + version], deps, tree)
        }

        if (depth >= 2)
            deps.forEach(tree => walkTree({tree, registry}, f, depth - 1, skip - 1))
    }
}

_.mixin({
    deeply: function (map) {
        return function(obj, fn) {
            return map(_.mapValues(obj, function (v) {
                return _.isPlainObject(v) ? _.deeply(map)(v, fn) : v;
            }), fn);
        }
    },
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
export const generateConfig = ({tree, registry, directory}) => {

    const systemConfig = {
        "map": {},
        "packages": {}
    }

    // get readable stream working
    // TODO: Fix this hack
    systemConfig['map']["_stream_transform"] = "node_modules/readable-stream/transform"

    // Walk first level of dependencies and map package name to location
    walkTree({tree, registry}, ({name, config, key, location}, deps) => {
        systemConfig['map'][name] = location
    }, 2, 1)

    // Walk full dep tree and assign package config entries
    walkTree({tree, registry}, ({name, config, key, location}, deps, tree) => {

        // Construct package entry based off config
        let packageEntry = Object.assign({
            map: {},
            meta: {}
        }, config)

        // Add mappings for it's deps.
        walkTree({tree, registry}, ({name, config, key, location}, deps) => {
            packageEntry['map'][name] = location
        }, 2, 1)

        // If there are no mappings, don't pollute the config
        if (Object.keys(packageEntry['map']).length == 0)
            delete packageEntry['map']

        // Assign package entry to config
        systemConfig['packages'][location] = packageEntry

        // Add mappings for all jspm-nodelibs
        // TODO: Fix this hack
        nodeCoreModules.forEach(lib => {
            var jspmNodelibVersion = nodeJspmModules['jspm-nodelibs-' + lib];
            if (jspmNodelibVersion != undefined) {
                systemConfig['map'][lib] = registry['jspm-nodelibs-' + lib + '@' + jspmNodelibVersion].location
            }
        })

    }, Infinity, 1)

    // TODO: Make the mappings here more universal
    // map nm: -> node_modules/ to make config smaller
    systemConfig['paths'] = {
        'nm:': 'node_modules/'
    }

    // map nm: -> node_modules/ to make config smaller
    Object.keys(systemConfig['map']).forEach(key => {
        systemConfig['map'][key] = systemConfig['map'][key].replace(/^node_modules\//, 'nm:')
    })

    // map nm: -> node_modules/ to make config smaller
    Object.keys(systemConfig['packages']).forEach(key => {
        if (key.startsWith('node_modules/')) {
            systemConfig['packages'][key.replace(/^node_modules\//, 'nm:')] = systemConfig['packages'][key]
            delete systemConfig['packages'][key]
        }
    })

    // TODO: double object walk is really hacky...
    var mySystemConfig = _.deeply(_.mapValues)(systemConfig, function (val, key) {
        if (typeof val === 'string' || val instanceof String) {
            return _.replace(val, path.join(directory, 'node_modules' + path.sep), 'nm:');
        }
        else {
            return val
        }
    });

    mySystemConfig = _.deeply(_.mapKeys)(mySystemConfig, function (val, key) {
        return _.replace(key, path.join(directory, 'node_modules' + path.sep), 'nm:');
    });

    return Promise.resolve(mySystemConfig)
}

// TODO: This needs to be done better (fails if locations of shit changes)
export const mergeCache = (registry, cachedRegistry) => {
    return Object.assign({}, registry, cachedRegistry)
}

export const fromCache = ({tree, registry, directory}) => {
    return dehydrateCache().then(cachedRegistry => {
        return {tree, registry: mergeCache(registry, cachedRegistry), directory}
    })
}

/**
 * Convenience method to allow easy chaining
 * @param tree
 * @param registry
 * @returns {Promise.<{tree: *, registry: *}>}
 */
export const toCache = ({tree, registry, directory}) => {
    return hydrateCache(registry)
        .then(() => ({tree, registry, directory}))
}

export const serializeConfig = config => {
    return 'SystemJS.config(' + JSON.stringify(config, null, 2) + ')'
}

/**
 * Write registry to ./systemjs.cache
 * @param registry
 * @returns {Promise.<TResult>}
 */
const hydrateCache = (registry) => {
    return Promise.resolve(JSON.stringify(registry))
        .then(pfs.writeFile.bind(null, './systemjs.cache'))
}

/**
 * Construct registry from ./systemjs.cache
 * @returns {Promise.<TResult>}
 */
const dehydrateCache = () => {
    return pfs.readFile('./systemjs.cache', 'utf8')
        .then(JSON.parse)
        .catch(e => {
            console.log("No cache, parsing node_modules. Warning this may take a while.")
            return {}
        })
}
