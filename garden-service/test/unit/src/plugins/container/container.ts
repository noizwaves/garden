/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { expect } from "chai"
import { resolve, join } from "path"
import { cloneDeep } from "lodash"
import td from "testdouble"

import { Garden } from "../../../../../src/garden"
import { PluginContext } from "../../../../../src/plugin-context"
import { gardenPlugin } from "../../../../../src/plugins/container/container"
import { dataDir, expectError, makeTestGarden } from "../../../../helpers"
import { moduleFromConfig } from "../../../../../src/types/module"
import { ModuleConfig } from "../../../../../src/config/module"
import { LogEntry } from "../../../../../src/logger/log-entry"
import {
  ContainerModuleSpec,
  ContainerModuleConfig,
  defaultContainerLimits,
} from "../../../../../src/plugins/container/config"
import {
  containerHelpers as helpers,
  minDockerVersion,
  DEFAULT_BUILD_TIMEOUT,
} from "../../../../../src/plugins/container/helpers"

describe("plugins.container", () => {
  const projectRoot = resolve(dataDir, "test-project-container")
  const modulePath = resolve(dataDir, "test-project-container", "module-a")
  const relDockerfilePath = "docker-dir/Dockerfile"

  const plugin = gardenPlugin
  const handlers = plugin.createModuleTypes![0].handlers
  const configure = handlers.configure!
  const build = handlers.build!
  const publishModule = handlers.publish!
  const getBuildStatus = handlers.getBuildStatus!

  const baseConfig: ModuleConfig<ContainerModuleSpec, any, any> = {
    allowPublish: false,
    build: {
      dependencies: [],
    },
    disabled: false,
    apiVersion: "garden.io/v0",
    name: "test",
    outputs: {},
    path: modulePath,
    type: "container",

    spec: {
      build: {
        dependencies: [],
        timeout: DEFAULT_BUILD_TIMEOUT,
      },
      buildArgs: {},
      extraFlags: [],
      services: [],
      tasks: [],
      tests: [],
    },

    serviceConfigs: [],
    taskConfigs: [],
    testConfigs: [],
  }

  let garden: Garden
  let ctx: PluginContext
  let log: LogEntry

  beforeEach(async () => {
    garden = await makeTestGarden(projectRoot, { plugins: [gardenPlugin] })
    log = garden.log
    const provider = await garden.resolveProvider("container")
    ctx = garden.getPluginContext(provider)

    td.replace(garden.buildDir, "syncDependencyProducts", () => null)

    td.replace(Garden.prototype, "resolveVersion", async () => ({
      versionString: "1234",
      dependencyVersions: {},
      files: [],
    }))
  })

  async function getTestModule(moduleConfig: ContainerModuleConfig) {
    const parsed = await configure({ ctx, moduleConfig, log })
    return moduleFromConfig(garden, parsed.moduleConfig, [])
  }

  describe("configureContainerModule", () => {
    it("should validate and parse a container module", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: "garden.io/v0",
        name: "module-a",
        outputs: {},
        path: modulePath,
        type: "container",

        spec: {
          build: {
            dependencies: [],
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [
                {
                  annotations: {},
                  path: "/",
                  port: "http",
                },
              ],
              env: {
                SOME_ENV_VAR: "value",
              },
              healthCheck: {
                httpGet: {
                  path: "/health",
                  port: "http",
                },
              },
              limits: {
                cpu: 123,
                memory: 456,
              },
              ports: [
                {
                  name: "http",
                  protocol: "TCP",
                  containerPort: 8080,
                  servicePort: 8080,
                },
              ],
              replicas: 1,
              volumes: [],
            },
          ],
          tasks: [
            {
              name: "task-a",
              args: ["echo", "OK"],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {
                TASK_ENV_VAR: "value",
              },
              timeout: null,
              volumes: [],
            },
          ],
          tests: [
            {
              name: "unit",
              args: ["echo", "OK"],
              artifacts: [],
              dependencies: [],
              disabled: false,
              env: {
                TEST_ENV_VAR: "value",
              },
              timeout: null,
              volumes: [],
            },
          ],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      const result = await configure({ ctx, moduleConfig, log })

      expect(result).to.eql({
        moduleConfig: {
          allowPublish: false,
          build: { dependencies: [] },
          disabled: false,
          apiVersion: "garden.io/v0",
          name: "module-a",
          include: ["Dockerfile"],
          outputs: {
            "local-image-name": "module-a",
            "deployment-image-name": "module-a",
          },
          path: modulePath,
          type: "container",
          spec: {
            build: {
              dependencies: [],
              timeout: DEFAULT_BUILD_TIMEOUT,
            },
            buildArgs: {},
            extraFlags: [],
            services: [
              {
                name: "service-a",
                annotations: {},
                args: ["echo"],
                dependencies: [],
                disabled: false,
                daemon: false,
                ingresses: [
                  {
                    annotations: {},
                    path: "/",
                    port: "http",
                  },
                ],
                env: {
                  SOME_ENV_VAR: "value",
                },
                healthCheck: { httpGet: { path: "/health", port: "http" } },
                limits: {
                  cpu: 123,
                  memory: 456,
                },
                ports: [{ name: "http", protocol: "TCP", containerPort: 8080, servicePort: 8080 }],
                replicas: 1,
                volumes: [],
              },
            ],
            tasks: [
              {
                name: "task-a",
                args: ["echo", "OK"],
                artifacts: [],
                cacheResult: true,
                dependencies: [],
                disabled: false,
                env: {
                  TASK_ENV_VAR: "value",
                },
                timeout: null,
                volumes: [],
              },
            ],
            tests: [
              {
                name: "unit",
                args: ["echo", "OK"],
                artifacts: [],
                dependencies: [],
                disabled: false,
                env: {
                  TEST_ENV_VAR: "value",
                },
                timeout: null,
                volumes: [],
              },
            ],
          },
          serviceConfigs: [
            {
              name: "service-a",
              dependencies: [],
              disabled: false,
              hotReloadable: false,
              spec: {
                name: "service-a",
                annotations: {},
                args: ["echo"],
                dependencies: [],
                disabled: false,
                daemon: false,
                ingresses: [
                  {
                    annotations: {},
                    path: "/",
                    port: "http",
                  },
                ],
                env: {
                  SOME_ENV_VAR: "value",
                },
                healthCheck: { httpGet: { path: "/health", port: "http" } },
                limits: {
                  cpu: 123,
                  memory: 456,
                },
                ports: [{ name: "http", protocol: "TCP", containerPort: 8080, servicePort: 8080 }],
                replicas: 1,
                volumes: [],
              },
            },
          ],
          taskConfigs: [
            {
              cacheResult: true,
              dependencies: [],
              disabled: false,
              name: "task-a",
              spec: {
                args: ["echo", "OK"],
                artifacts: [],
                cacheResult: true,
                dependencies: [],
                disabled: false,
                env: {
                  TASK_ENV_VAR: "value",
                },
                name: "task-a",
                timeout: null,
                volumes: [],
              },
              timeout: null,
            },
          ],
          testConfigs: [
            {
              name: "unit",
              dependencies: [],
              disabled: false,
              spec: {
                name: "unit",
                args: ["echo", "OK"],
                artifacts: [],
                dependencies: [],
                disabled: false,
                env: {
                  TEST_ENV_VAR: "value",
                },
                timeout: null,
                volumes: [],
              },
              timeout: null,
            },
          ],
        },
      })
    })

    it("should add service volume modules as build and runtime dependencies", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: "garden.io/v0",
        name: "module-a",
        outputs: {},
        path: modulePath,
        type: "container",

        spec: {
          build: {
            dependencies: [],
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [],
              env: {},
              healthCheck: {},
              limits: {
                cpu: 123,
                memory: 456,
              },
              ports: [],
              replicas: 1,
              volumes: [
                {
                  name: "test",
                  containerPath: "/",
                  module: "volume-module",
                },
              ],
            },
          ],
          tasks: [],
          tests: [],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      const result = await configure({ ctx, moduleConfig, log })

      expect(result.moduleConfig.build.dependencies).to.eql([{ name: "volume-module", copy: [] }])
      expect(result.moduleConfig.serviceConfigs[0].dependencies).to.eql(["volume-module"])
    })

    it("should add task volume modules as build and runtime dependencies", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: "garden.io/v0",
        name: "module-a",
        outputs: {},
        path: modulePath,
        type: "container",

        spec: {
          build: {
            dependencies: [],
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [],
          tasks: [
            {
              name: "task-a",
              args: [],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {},
              timeout: null,
              volumes: [
                {
                  name: "test",
                  containerPath: "/",
                  module: "volume-module",
                },
              ],
            },
          ],
          tests: [],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      const result = await configure({ ctx, moduleConfig, log })

      expect(result.moduleConfig.build.dependencies).to.eql([{ name: "volume-module", copy: [] }])
      expect(result.moduleConfig.taskConfigs[0].dependencies).to.eql(["volume-module"])
    })

    it("should add test volume modules as build and runtime dependencies", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: "garden.io/v0",
        name: "module-a",
        outputs: {},
        path: modulePath,
        type: "container",

        spec: {
          build: {
            dependencies: [],
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [],
          tasks: [],
          tests: [
            {
              name: "test-a",
              args: [],
              artifacts: [],
              dependencies: [],
              disabled: false,
              env: {},
              timeout: null,
              volumes: [
                {
                  name: "test",
                  containerPath: "/",
                  module: "volume-module",
                },
              ],
            },
          ],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      const result = await configure({ ctx, moduleConfig, log })

      expect(result.moduleConfig.build.dependencies).to.eql([{ name: "volume-module", copy: [] }])
      expect(result.moduleConfig.testConfigs[0].dependencies).to.eql(["volume-module"])
    })

    it("should fail with invalid port in ingress spec", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: "garden.io/v0",
        name: "module-a",
        outputs: {},
        path: modulePath,
        type: "test",

        spec: {
          build: {
            dependencies: [],
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [
                {
                  annotations: {},
                  path: "/",
                  port: "bla",
                },
              ],
              limits: defaultContainerLimits,
              env: {},
              ports: [],
              replicas: 1,
              volumes: [],
            },
          ],
          tasks: [
            {
              name: "task-a",
              args: ["echo"],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {},
              timeout: null,
              volumes: [],
            },
          ],
          tests: [
            {
              name: "unit",
              args: ["echo", "OK"],
              artifacts: [],
              dependencies: [],
              disabled: false,
              env: {},
              timeout: null,
              volumes: [],
            },
          ],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      await expectError(() => configure({ ctx, moduleConfig, log }), "configuration")
    })

    it("should fail with invalid port in httpGet healthcheck spec", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: "garden.io/v0",
        name: "module-a",
        outputs: {},
        path: modulePath,
        type: "test",

        spec: {
          build: {
            dependencies: [],
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [],
              env: {},
              healthCheck: {
                httpGet: {
                  path: "/",
                  port: "bla",
                },
              },
              limits: defaultContainerLimits,
              ports: [],
              replicas: 1,
              volumes: [],
            },
          ],
          tasks: [
            {
              name: "task-a",
              args: ["echo"],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {},
              timeout: null,
              volumes: [],
            },
          ],
          tests: [],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      await expectError(() => configure({ ctx, moduleConfig, log }), "configuration")
    })

    it("should fail with invalid port in tcpPort healthcheck spec", async () => {
      const moduleConfig: ContainerModuleConfig = {
        allowPublish: false,
        build: {
          dependencies: [],
        },
        disabled: false,
        apiVersion: "garden.io/v0",
        name: "module-a",
        outputs: {},
        path: modulePath,
        type: "test",

        spec: {
          build: {
            dependencies: [],
            timeout: DEFAULT_BUILD_TIMEOUT,
          },
          buildArgs: {},
          extraFlags: [],
          services: [
            {
              name: "service-a",
              annotations: {},
              args: ["echo"],
              dependencies: [],
              daemon: false,
              disabled: false,
              ingresses: [],
              env: {},
              healthCheck: {
                tcpPort: "bla",
              },
              limits: defaultContainerLimits,
              ports: [],
              replicas: 1,
              volumes: [],
            },
          ],
          tasks: [
            {
              name: "task-a",
              args: ["echo"],
              artifacts: [],
              cacheResult: true,
              dependencies: [],
              disabled: false,
              env: {},
              timeout: null,
              volumes: [],
            },
          ],
          tests: [],
        },

        serviceConfigs: [],
        taskConfigs: [],
        testConfigs: [],
      }

      await expectError(() => configure({ ctx, moduleConfig, log }), "configuration")
    })
  })

  describe("getBuildStatus", () => {
    it("should return ready:true if build exists locally", async () => {
      const module = td.object(await getTestModule(baseConfig))

      td.replace(helpers, "imageExistsLocally", async () => true)

      const result = await getBuildStatus({ ctx, log, module })
      expect(result).to.eql({ ready: true })
    })

    it("should return ready:false if build does not exist locally", async () => {
      const module = td.object(await getTestModule(baseConfig))

      td.replace(helpers, "imageExistsLocally", async () => false)

      const result = await getBuildStatus({ ctx, log, module })
      expect(result).to.eql({ ready: false })
    })
  })

  describe("build", () => {
    it("should pull image if image tag is set and the module doesn't container a Dockerfile", async () => {
      const config = cloneDeep(baseConfig)
      config.spec.image = "some/image"
      const module = td.object(await getTestModule(config))

      td.replace(helpers, "hasDockerfile", async () => false)
      td.replace(helpers, "pullImage", async () => null)
      td.replace(helpers, "imageExistsLocally", async () => false)

      const result = await build({ ctx, log, module })

      expect(result).to.eql({ fetched: true })
    })

    it("should build image if module contains Dockerfile", async () => {
      const config = cloneDeep(baseConfig)
      config.spec.image = "some/image"
      const module = td.object(await getTestModule(config))

      td.replace(helpers, "hasDockerfile", async () => true)
      td.replace(helpers, "imageExistsLocally", async () => false)
      td.replace(helpers, "getLocalImageId", async () => "some/image")

      const cmdArgs = ["build", "-t", "some/image", module.buildPath]

      td.replace(helpers, "dockerCli", async (path: string, args: string[]) => {
        expect(path).to.equal(module.buildPath)
        expect(args).to.eql(cmdArgs)
        return { output: "log" }
      })

      const result = await build({ ctx, log, module })

      expect(result).to.eql({
        buildLog: "log",
        fresh: true,
        details: { identifier: "some/image" },
      })
    })

    it("should set build target image parameter if configured", async () => {
      const config = cloneDeep(baseConfig)
      config.spec.image = "some/image"
      config.spec.build.targetImage = "foo"
      const module = td.object(await getTestModule(config))

      td.replace(helpers, "hasDockerfile", async () => true)
      td.replace(helpers, "imageExistsLocally", async () => false)
      td.replace(helpers, "getLocalImageId", async () => "some/image")

      const cmdArgs = ["build", "-t", "some/image", "--target", "foo", module.buildPath]

      td.replace(helpers, "dockerCli", async (path: string, args: string[]) => {
        expect(path).to.equal(module.buildPath)
        expect(args).to.eql(cmdArgs)
        return { output: "log" }
      })

      const result = await build({ ctx, log, module })

      expect(result).to.eql({
        buildLog: "log",
        fresh: true,
        details: { identifier: "some/image" },
      })
    })

    it("should build image using the user specified Dockerfile path", async () => {
      const config = cloneDeep(baseConfig)
      config.spec.dockerfile = relDockerfilePath

      td.replace(helpers, "hasDockerfile", async () => true)

      const module = td.object(await getTestModule(config))

      td.replace(helpers, "imageExistsLocally", async () => false)
      td.replace(helpers, "getLocalImageId", async () => "some/image")

      const cmdArgs = [
        "build",
        "-t",
        "some/image",
        "--file",
        join(module.buildPath, relDockerfilePath),
        module.buildPath,
      ]

      td.replace(helpers, "dockerCli", async (path: string, args: string[]) => {
        expect(path).to.equal(module.buildPath)
        expect(args).to.eql(cmdArgs)
        return { output: "log" }
      })

      const result = await build({ ctx, log, module })

      expect(result).to.eql({
        buildLog: "log",
        fresh: true,
        details: { identifier: "some/image" },
      })
    })
  })

  describe("publishModule", () => {
    it("should not publish image if module doesn't container a Dockerfile", async () => {
      const config = cloneDeep(baseConfig)
      config.spec.image = "some/image"
      const module = td.object(await getTestModule(config))

      td.replace(helpers, "hasDockerfile", async () => false)

      const result = await publishModule({ ctx, log, module })
      expect(result).to.eql({ published: false })
    })

    it("should publish image if module contains a Dockerfile", async () => {
      const config = cloneDeep(baseConfig)
      config.spec.image = "some/image:1.1"
      const module = td.object(await getTestModule(config))

      td.replace(helpers, "hasDockerfile", async () => true)
      td.replace(helpers, "getLocalImageId", async () => "some/image:12345")
      td.replace(helpers, "getPublicImageId", async () => "some/image:12345")

      const dockerCli = td.replace(helpers, "dockerCli")

      const result = await publishModule({ ctx, log, module })
      expect(result).to.eql({ message: "Published some/image:12345", published: true })

      td.verify(dockerCli(module.buildPath, ["tag", "some/image:12345", "some/image:12345"]), {
        ignoreExtraArgs: true,
        times: 0,
      })
      td.verify(dockerCli(module.buildPath, ["push", "some/image:12345"]), { ignoreExtraArgs: true })
    })

    it("should tag image if remote id differs from local id", async () => {
      const config = cloneDeep(baseConfig)
      config.spec.image = "some/image:1.1"
      const module = td.object(await getTestModule(config))

      td.replace(helpers, "hasDockerfile", async () => true)
      td.replace(helpers, "getLocalImageId", () => "some/image:12345")
      td.replace(helpers, "getPublicImageId", () => "some/image:1.1")

      const dockerCli = td.replace(helpers, "dockerCli")

      const result = await publishModule({ ctx, log, module })
      expect(result).to.eql({ message: "Published some/image:1.1", published: true })

      td.verify(dockerCli(module.buildPath, ["tag", "some/image:12345", "some/image:1.1"]), { ignoreExtraArgs: true })
      td.verify(dockerCli(module.buildPath, ["push", "some/image:1.1"]), { ignoreExtraArgs: true })
    })
  })

  describe("checkDockerClientVersion", () => {
    it("should return if client version is equal to the minimum version", async () => {
      helpers.checkDockerClientVersion(minDockerVersion)
    })

    it("should return if client version is greater than the minimum version", async () => {
      const version = {
        client: "99.99",
        server: "99.99",
      }

      helpers.checkDockerClientVersion(version)
    })

    it("should throw if client is not installed (version is undefined)", async () => {
      const version = {
        client: undefined,
        server: minDockerVersion.server,
      }

      await expectError(
        () => helpers.checkDockerClientVersion(version),
        (err) => {
          expect(err.message).to.equal("Docker client is not installed.")
        }
      )
    })

    it("should throw if client version is too old", async () => {
      const version = {
        client: "17.06",
        server: minDockerVersion.server,
      }

      await expectError(
        () => helpers.checkDockerClientVersion(version),
        (err) => {
          expect(err.message).to.equal("Docker client needs to be version 19.03.0 or newer (got 17.06)")
        }
      )
    })
  })

  describe("checkDockerServerVersion", () => {
    it("should return if server version is equal to the minimum version", async () => {
      helpers.checkDockerServerVersion(minDockerVersion)
    })

    it("should return if server version is greater than the minimum version", async () => {
      const version = {
        client: "99.99",
        server: "99.99",
      }

      helpers.checkDockerServerVersion(version)
    })

    it("should throw if server is not reachable (version is undefined)", async () => {
      const version = {
        client: minDockerVersion.client,
        server: undefined,
      }

      await expectError(
        () => helpers.checkDockerServerVersion(version),
        (err) => {
          expect(err.message).to.equal("Docker server is not running or cannot be reached.")
        }
      )
    })

    it("should throw if server version is too old", async () => {
      const version = {
        client: minDockerVersion.client,
        server: "17.06",
      }

      await expectError(
        () => helpers.checkDockerServerVersion(version),
        (err) => {
          expect(err.message).to.equal("Docker server needs to be version 17.07.0 or newer (got 17.06)")
        }
      )
    })
  })
})
