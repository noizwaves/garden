/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"

import { CommandError, ParameterError } from "../../exceptions"
import { printHeader } from "../../logger/util"
import { prepareRuntimeContext } from "../../runtime-context"
import { getRunTaskResults, getServiceStatuses } from "../../tasks/base"
import { TestTask } from "../../tasks/test"
import { RunResult } from "../../types/plugin/base"
import { testFromConfig } from "../../types/test"
import { dedent, deline } from "../../util/string"
import { findByName, getNames } from "../../util/util"
import { BooleanParameter, Command, CommandParams, CommandResult, handleActionResult, StringParameter } from "../base"
import { printRuntimeContext } from "./run"

const runArgs = {
  module: new StringParameter({
    help: "The name of the module to run.",
    required: true,
  }),
  test: new StringParameter({
    help: "The name of the test to run in the module.",
    required: true,
  }),
}

const runOpts = {
  "interactive": new BooleanParameter({
    help: "Set to false to skip interactive mode and just output the command result.",
    defaultValue: false,
    cliDefault: true,
    cliOnly: true,
  }),
  "force": new BooleanParameter({
    help: "Run the test even if it's disabled for the environment.",
  }),
  "force-build": new BooleanParameter({
    help: "Force rebuild of module before running.",
  }),
}

type Args = typeof runArgs
type Opts = typeof runOpts

export class RunTestCommand extends Command<Args, Opts> {
  name = "test"
  help = "Run the specified module test."

  description = dedent`
    This can be useful for debugging tests, particularly integration/end-to-end tests.

    Examples:

        garden run test my-module integ            # run the test named 'integ' in my-module
        garden run test my-module integ --i=false  # do not attach to the test run, just output results when completed
  `

  arguments = runArgs
  options = runOpts

  async action({ garden, log, headerLog, args, opts }: CommandParams<Args, Opts>): Promise<CommandResult<RunResult>> {
    const moduleName = args.module
    const testName = args.test

    const graph = await garden.getConfigGraph(log)
    const module = graph.getModule(moduleName, true)

    const testConfig = findByName(module.testConfigs, testName)

    if (!testConfig) {
      throw new ParameterError(`Could not find test "${testName}" in module ${moduleName}`, {
        moduleName,
        testName,
        availableTests: getNames(module.testConfigs),
      })
    }

    const test = testFromConfig(module, testConfig)

    if ((module.disabled || test.disabled) && !opts.force) {
      throw new CommandError(
        chalk.red(deline`
          Test ${chalk.redBright(`${module.name}.${test.name}`)} is disabled for the
          ${chalk.redBright(garden.environmentName)} environment. If you're sure you want to run it anyway,
          please run the command again with the ${chalk.redBright("--force")} flag.
        `),
        { moduleName: module.name, testName: test.name, environmentName: garden.environmentName }
      )
    }

    printHeader(headerLog, `Running test ${chalk.cyan(testName)} in module ${chalk.cyan(moduleName)}`, "runner")

    const actions = await garden.getActionRouter()

    // Make sure all dependencies are ready and collect their outputs for the runtime context
    const testTask = await TestTask.factory({
      force: true,
      forceBuild: opts["force-build"],
      garden,
      graph,
      log,
      module,
      testConfig,
    })
    const dependencyResults = await garden.processTasks(await testTask.getDependencies())

    const interactive = opts.interactive
    const dependencies = graph.getDependencies({ nodeType: "test", name: test.name, recursive: false })

    const serviceStatuses = getServiceStatuses(dependencyResults)
    const taskResults = getRunTaskResults(dependencyResults)

    const runtimeContext = await prepareRuntimeContext({
      garden,
      graph,
      dependencies,
      version: module.version,
      serviceStatuses,
      taskResults,
    })

    printRuntimeContext(log, runtimeContext)

    const result = await actions.testModule({
      log,
      module,
      interactive,
      runtimeContext,
      silent: false,
      testConfig,
      testVersion: testTask.version,
    })

    return handleActionResult(`Test ${test.name} in module ${module.name}`, result)
  }
}
