const { existsSync } = require('node:fs');
const { join } = require('node:path');

function getTestEntrypoint(utils) {
  const entryDirPath = utils.platform.getEntryDirPath();
  const testTsEntryPath = join(entryDirPath, 'test.ts');
  if (existsSync(testTsEntryPath)) return testTsEntryPath;
  const testJsEntryPath = join(entryDirPath, 'test.js');
  if (existsSync(testJsEntryPath)) return testJsEntryPath;
  return null;
}

/**
 * @param {typeof import("@nativescript/webpack").Utils} utils
 */
module.exports = (utils) => {
  return {
    name: '@nativescript/unit-test-runner',
    apply: 'build',
    
    config(config, env) {
      const isUnitTesting = process.env.NS_TESTING === '1';
      
      if (isUnitTesting) {
        return setupUnitTestBuild(config, utils);
      } else {
        return setupNonTestBuild(config, utils);
      }
    },
    
    resolveId(id) {
      // Alias bare vitest imports to the device-safe shim
      if (id === 'vitest') {
        const shimPath = join(__dirname, 'dist', 'runtime', 'shim.js');
        if (existsSync(shimPath)) {
          return shimPath;
        }
      }
      return null;
    },
  };
};

/**
 * Setup non-testing build configuration
 * @param {import("vite").UserConfig} config
 * @param {typeof import("@nativescript/webpack").Utils} utils
 */
function setupNonTestBuild(config, utils) {
  return {
    define: {
      'process.env.NS_TESTING': 'false',
    },
  };
}

/**
 * Setup unit testing build configuration
 * @param {import("vite").UserConfig} config
 * @param {typeof import("@nativescript/webpack").Utils} utils
 */
function setupUnitTestBuild(config, utils) {
  const testEntrypointPath = getTestEntrypoint(utils);
  if (!testEntrypointPath) {
    utils.log.error(
      'No test entrypoint (test.ts or test.js) found in the app source directory. Run `ns test init` to scaffold one.',
    );
    return {};
  }

  const shimPath = join(__dirname, 'dist', 'runtime', 'shim.js');
  if (!existsSync(shimPath)) {
    utils.log.error(
      '@nativescript/unit-test-runner is not built. Reinstall the package.',
    );
    return {};
  }

  const testRunnerPort = Number(process.env.NS_TEST_RUNNER_PORT);

  // Handle tsconfig backward compatibility
  if (process.env.NS_TEST_TS_CONFIG && !process.env.NS_TEST_TS_CONFIG_NORMALIZED) {
    utils.log.warn('Mapping NS_TEST_TS_CONFIG to NS_TEST_TS_CONFIG_NORMALIZED');
  }
  const customTsConfig = process.env.NS_TEST_TS_CONFIG || process.env.NS_TEST_TS_CONFIG_NORMALIZED;
  const defaultTsConfig = utils.project.getProjectFilePath('tsconfig.spec.json');
  const tsConfigPath =
    customTsConfig || (existsSync(defaultTsConfig) ? defaultTsConfig : undefined);

  const entryDirPath = utils.platform.getEntryDirPath();

  const viteConfig = {
    resolve: {
      alias: {
        'vitest$': shimPath,
      },
    },
    define: {
      'global.TNS_WEBPACK': true,
      '__NS_TEST_CONFIG__': JSON.stringify({
        port: Number.isInteger(testRunnerPort) ? testRunnerPort : undefined,
      }),
    },
  };

  // Configure TypeScript handling if tsconfig exists
  if (tsConfigPath) {
    viteConfig.esbuild = {
      tsconfigRaw: require(tsConfigPath),
    };
  }

  // Configure code coverage instrumentation
  if (process.env.NS_CODE_COVERAGE === '1') {
    viteConfig.plugins = viteConfig.plugins || [];
    viteConfig.plugins.push(
      createCoveragePlugin(entryDirPath)
    );
  }

  return viteConfig;
}

/**
 * Create coverage instrumentation plugin
 * @param {string} entryDirPath
 */
function createCoveragePlugin(entryDirPath) {
  return {
    name: '@nativescript/coverage-istanbul',
    resolveId(id) {
      return null;
    },
    async transform(code, id) {
      // Instrument files matching the same pattern as webpack plugin
      const isInAppDir = id.startsWith(entryDirPath);
      const isSpecFile = /\.spec\.[cm]?[jt]sx?$/.test(id);
      const isTestEntry = id.includes('test.ts') || id.includes('test.js');
      const isTestsDir = id.includes(join(entryDirPath, 'tests'));
      const isSourceFile = /\.[cm]?[jt]sx?$/.test(id);

      // Skip coverage instrumentation for excluded files
      if (isTestsDir || isSpecFile || isTestEntry || !isInAppDir || !isSourceFile) {
        return null;
      }

      // Apply babel-plugin-istanbul instrumentation
      // This requires @babel/core and babel-plugin-istanbul as devDependencies
      try {
        const babel = require('@babel/core');
        const result = babel.transformSync(code, {
          filename: id,
          plugins: [
            [
              require.resolve('babel-plugin-istanbul'),
              {
                coverageVariable: '__VITEST_COVERAGE__',
                coverageGlobalScope: 'globalThis',
                coverageGlobalScopeFunc: false,
              },
            ],
          ],
          sourceMaps: true,
        });
        return result;
      } catch (error) {
        console.warn(`Failed to instrument ${id} for coverage:`, error.message);
        return null;
      }
    },
  };
}
