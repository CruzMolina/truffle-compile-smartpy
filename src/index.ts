import path from "path";
import { exec, spawn } from "child_process";
import fs from "fs";
import { promisify } from "util";
const promisifiedMkdirp = promisify(require("mkdirp"));
import colors from "colors";
import minimatch from "minimatch";
import find_contracts from "@truffle/contract-sources";
import Profiler from "@truffle/compile-solidity/profiler";
import TruffleConfig from "@truffle/config";

const compiler = {
  name: "smartpy",
  version: "trufflesuite/smartpy-basic:0.0.2"
};

const SMARTPY_PATTERN = "**/*.py";

// -------- TODO: Common with truffle-compile --------

type CompileCallback = (
  error?: any,
  result?: any,
  contractPaths?: Array<string>,
  _compiler?: typeof compiler
) => void;

const compile: any = {};

// contracts_directory: String. Directory where .py files can be found.
// quiet: Boolean. Suppress output. Defaults to false.
// strict: Boolean. Return compiler warnings as errors. Defaults to false.
compile.all = (options: TruffleConfig, callback: CompileCallback) => {
  find_contracts(options.contracts_directory, (err: Error, files: Array<string>) => {
    if (err) return callback(err);

    options.paths = files;
    compile.with_dependencies(options, callback);
  });
};

// contracts_directory: String. Directory where .py files can be found.
// build_directory: String. Optional. Directory where .json files can be found. Only required if `all` is false.
// all: Boolean. Compile all sources found. Defaults to true. If false, will compare sources against built files
//      in the build directory to see what needs to be compiled.
// quiet: Boolean. Suppress output. Defaults to false.
// strict: Boolean. Return compiler warnings as errors. Defaults to false.
compile.necessary = (options: TruffleConfig, callback: CompileCallback) => {
  options.logger = options.logger || console;

  Profiler.updated(options, (err: Error, updated: Array<string>) => {
    if (err) return callback(err);

    if (updated.length === 0 && options.quiet !== true) {
      return callback(null, {}, []);
    }

    options.paths = updated;
    compile.with_dependencies(options, callback);
  });
};

compile.display = (paths: Array<string>, { quiet, working_directory, logger }: TruffleConfig) => {
  if (quiet !== true) {
    if (!Array.isArray(paths)) {
      paths = Object.keys(paths);
    }

    paths.sort().forEach(contract => {
      if (path.isAbsolute(contract)) {
        contract = `.${path.sep}${path.relative(working_directory, contract)}`;
      }
      logger.log(`> Compiling ${contract}`);
    });
  }
};

// -------- End of common with truffle-compile --------

// Check that SmartPy-Basic is available
function checkSmartPy(callback: CompileCallback) {
  exec(
    "docker run --rm -i trufflesuite/smartpy-basic:0.0.1 --help",
    (err, _stdout, stderr) => {
      if (err)
        return callback(
          `${colors.red("Error executing SmartPy-Basic:")}\n${stderr}`
        );

      callback(null);
    }
  );
}

// Execute SmartPy-Basic for single source file
function execSmartPy(sourcePath: string, entryPoint: string, options: TruffleConfig) {
  return new Promise((resolve, reject) => {
    // Note that the first volume parameter passed to docker needs to have a path
    // denoted in the format of of the host filesystem. The latter volume parameter,
    // as well as the entry point, needs to be denoted in the format of the VM.
    // We designate the VM paths to the current working directory.

    // In order to make this work on all platforms, we normalize every host path
    // (working directory, and source path). We also construct a VM internal sourch path
    // using the normalized source path. From there, we know this constructed
    // internal source path won't contain any "gotcha's", such as double-escaped path separators,
    // etc. From there, we replace all backslashes with forward slashes, which is the path
    // separator expected within the internal source.
    const currentProjectWorkingDirectory = path.normalize(
      options.working_directory
    );

    const fullInternalSourcePath = path
      .normalize(sourcePath)
      .replace(/\\/g, "/");

    // remove extension from filename
    const extension = path.extname(sourcePath);
    const basename = path.basename(sourcePath, extension);
    const contractName = basename;

    if (!fs.existsSync(options.contracts_build_directory))
      promisifiedMkdirp(options.contracts_build_directory);

    // Use spawn() instead of exec() here so that the OS can take care of escaping args.
    let docker = spawn("docker", [
      "run",
      "-v",
      `${currentProjectWorkingDirectory}:${currentProjectWorkingDirectory}`,
      "-w",
      `${currentProjectWorkingDirectory}`,
      "--rm",
      "-i",
      "trufflesuite/smartpy-basic:0.0.1",
      "compile",
      fullInternalSourcePath,
      `${entryPoint ? entryPoint : contractName}()`,
      options.contracts_build_directory
    ]);

    let stderr = "";

    docker.stderr.on("data", data => {
      stderr += data;
    });

    docker.on("close", code => {
      if (code != 0 || stderr != "") {
        reject(
          `${stderr}\n${colors.red(
            `Compilation of ${sourcePath} failed. See above.`
          )}`
        );
      }

      resolve(contractName);
    });
  });
}

// compile all options.paths
async function compileAll(options: TruffleConfig, callback: CompileCallback) {
  const callbackPassed = typeof callback === "function";
  const entryPoint = options._[0] || undefined;
  options.logger = options.logger || console;

  compile.display(options.paths, options);
  let contracts = [];

  for (const sourcePath of options.paths) {
    let contractName;
    try {
      contractName = await execSmartPy(sourcePath, entryPoint, options);
    } catch (error) {
      if (callbackPassed) return callback(error);
      throw error;
    }
    const sourceBuffer = fs.readFileSync(sourcePath);
    const sourceContents = sourceBuffer.toString();
    let michelson;
    let initialStorage;

    const currentBuildDirectoryContents = fs.readdirSync(
      options.contracts_build_directory
    );

    currentBuildDirectoryContents.forEach(file => {
      const currentFilePath = `${options.contracts_build_directory}/${file}`;
      if (file.includes(".py")) {
        return fs.unlinkSync(currentFilePath);
      }
      if (file.includes(".tz.json")) {
        const michelsonAsRawData = fs.readFileSync(currentFilePath, "utf-8");
        const michelsonJson = JSON.parse(michelsonAsRawData);

        michelson = JSON.stringify(michelsonJson);
        return fs.unlinkSync(currentFilePath);
      }

      if (file.includes(".tz")) {
        if (file === "contractStorage.tz") {
          const initialStorageRawData = fs.readFileSync(currentFilePath);
          initialStorage = initialStorageRawData.toString();
        }
        return fs.unlinkSync(currentFilePath);
      }
    });

    const contractDefinition = {
      contractName,
      abi: [], // TEMP!
      initialStorage,
      sourcePath,
      source: sourceContents,
      michelson,
      compiler
    };

    contracts.push(contractDefinition);
  }

  const result = contracts.reduce((result: any, contract: any) => {
    result[contract.contractName] = contract;

    return result;
  }, {});

  if (callbackPassed) return callback(null, result, options.paths, compiler);
  return { result, paths: options.paths, compiler };
}

// Check that SmartPy-Basic is available then forward to internal compile function
function compileSmartPy(options: TruffleConfig, callback: CompileCallback) {
  // filter out non-SmartPy paths
  options.paths = options.paths.filter((path: string) =>
    minimatch(path, SMARTPY_PATTERN)
  );

  // no SmartPy files found, no need to check SmartPy
  if (options.paths.length === 0) return callback(null, {}, []);

  checkSmartPy(err => {
    if (err) return callback(err);

    return compileAll(options, callback);
  });
}

// append .py pattern to contracts_directory in options and return updated options
function updateContractsDirectory(options: TruffleConfig) {
  return options.with({
    contracts_directory: path.join(options.contracts_directory, SMARTPY_PATTERN)
  });
}

// wrapper for compile.all. only updates contracts_directory to find .py
compileSmartPy.all = (options: TruffleConfig, callback: CompileCallback) =>
  compile.all(updateContractsDirectory(options), callback);

// wrapper for compile.necessary. only updates contracts_directory to find .py
compileSmartPy.necessary = (options: TruffleConfig, callback: CompileCallback) =>
  compile.necessary(updateContractsDirectory(options), callback);

compile.with_dependencies = compileSmartPy;
export = compileSmartPy;
module.exports = compileSmartPy;
