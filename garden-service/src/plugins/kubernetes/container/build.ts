/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import pRetry from "p-retry"
import split2 = require("split2")
import { ContainerModule, ContainerRegistryConfig } from "../../container/config"
import { containerHelpers } from "../../container/helpers"
import { buildContainerModule, getContainerBuildStatus, getDockerBuildFlags } from "../../container/build"
import { GetBuildStatusParams, BuildStatus } from "../../../types/plugin/module/getBuildStatus"
import { BuildModuleParams, BuildResult } from "../../../types/plugin/module/build"
import { millicpuToString, megabytesToString, getRunningPodInDeployment, makePodName } from "../util"
import { RSYNC_PORT, dockerAuthSecretName, inClusterRegistryHostname } from "../constants"
import { posix, resolve } from "path"
import { KubeApi } from "../api"
import { kubectl } from "../kubectl"
import { LogEntry } from "../../../logger/log-entry"
import { getDockerAuthVolume } from "../util"
import { KubernetesProvider, ContainerBuildMode, KubernetesPluginContext } from "../config"
import { PluginError, InternalError, RuntimeError, BuildError } from "../../../exceptions"
import { PodRunner } from "../run"
import { getRegistryHostname, getKubernetesSystemVariables } from "../init"
import { normalizeLocalRsyncPath } from "../../../util/fs"
import { getPortForward } from "../port-forward"
import { Writable } from "stream"
import { LogLevel } from "../../../logger/log-node"
import { exec, renderOutputStream } from "../../../util/util"
import { loadImageToKind } from "../local/kind"
import { getSystemNamespace, getAppNamespace } from "../namespace"
import { dedent } from "../../../util/string"
import chalk = require("chalk")
import { loadImageToMicrok8s, getMicrok8sImageStatus } from "../local/microk8s"

const dockerDaemonDeploymentName = "garden-docker-daemon"
const dockerDaemonContainerName = "docker-daemon"

const kanikoImage = "gcr.io/kaniko-project/executor:debug-v0.19.0"
const skopeoImage = "gardendev/skopeo:1.41.0-1"

const registryPort = 5000

export const buildSyncDeploymentName = "garden-build-sync"

export async function k8sGetContainerBuildStatus(params: GetBuildStatusParams<ContainerModule>): Promise<BuildStatus> {
  const { ctx, module } = params
  const provider = <KubernetesProvider>ctx.provider

  const hasDockerfile = await containerHelpers.hasDockerfile(module)

  if (!hasDockerfile) {
    // Nothing to build
    return { ready: true }
  }

  const handler = buildStatusHandlers[provider.config.buildMode]
  return handler(params)
}

export async function k8sBuildContainer(params: BuildModuleParams<ContainerModule>): Promise<BuildResult> {
  const { ctx } = params
  const provider = <KubernetesProvider>ctx.provider
  const handler = buildHandlers[provider.config.buildMode]
  return handler(params)
}

type BuildStatusHandler = (params: GetBuildStatusParams<ContainerModule>) => Promise<BuildStatus>

const buildStatusHandlers: { [mode in ContainerBuildMode]: BuildStatusHandler } = {
  "local-docker": async (params) => {
    const { ctx, module, log } = params
    const k8sCtx = ctx as KubernetesPluginContext
    const deploymentRegistry = k8sCtx.provider.config.deploymentRegistry

    if (deploymentRegistry) {
      const args = await getManifestInspectArgs(module, deploymentRegistry)
      const res = await containerHelpers.dockerCli(module.buildPath, args, log, { ignoreError: true })

      // Non-zero exit code can both mean the manifest is not found, and any other unexpected error
      if (res.code !== 0 && !res.output.includes("no such manifest")) {
        throw new RuntimeError(`Unable to query registry for image status: ${res.output}`, {
          command: "docker " + args.join(" "),
          output: res.output,
        })
      }

      return { ready: res.code === 0 }
    } else if (k8sCtx.provider.config.clusterType === "microk8s") {
      const localId = await containerHelpers.getLocalImageId(module)
      return getMicrok8sImageStatus(localId)
    } else {
      return getContainerBuildStatus(params)
    }
  },

  // TODO: make these handlers faster by running a simple in-cluster service
  // that wraps https://github.com/containers/image
  "cluster-docker": async (params) => {
    const { ctx, module, log } = params
    const k8sCtx = ctx as KubernetesPluginContext
    const provider = k8sCtx.provider
    const deploymentRegistry = provider.config.deploymentRegistry

    if (!deploymentRegistry) {
      // This is validated in the provider configure handler, so this is an internal error if it happens
      throw new InternalError(`Expected configured deploymentRegistry for remote build`, { config: provider.config })
    }

    const args = await getManifestInspectArgs(module, deploymentRegistry)
    const pushArgs = ["/bin/sh", "-c", "DOCKER_CLI_EXPERIMENTAL=enabled docker " + args.join(" ")]

    const podName = await getBuilderPodName(provider, log)
    const res = await execInBuilder({ provider, log, args: pushArgs, timeout: 300, podName, ignoreError: true })

    // Non-zero exit code can both mean the manifest is not found, and any other unexpected error
    if (res.exitCode !== 0 && !res.stderr.includes("no such manifest")) {
      throw new RuntimeError(`Unable to query registry for image status: ${res.all || res.stderr}`, {
        command: res.command,
        stdout: res.stdout,
        stderr: res.stderr,
      })
    }

    return { ready: res.exitCode === 0 }
  },

  "kaniko": async (params) => {
    const { ctx, module, log } = params
    const k8sCtx = ctx as KubernetesPluginContext
    const provider = k8sCtx.provider
    const deploymentRegistry = provider.config.deploymentRegistry

    if (!deploymentRegistry) {
      // This is validated in the provider configure handler, so this is an internal error if it happens
      throw new InternalError(`Expected configured deploymentRegistry for remote build`, { config: provider.config })
    }

    const api = await KubeApi.factory(log, provider)
    const namespace = await getAppNamespace(ctx, log, provider)
    const systemNamespace = await getSystemNamespace(provider, log)
    const podName = makePodName("skopeo", namespace, module.name)
    const registryHostname = getRegistryHostname(provider.config)

    const remoteId = await containerHelpers.getDeploymentImageId(module, deploymentRegistry)
    const inClusterRegistry = deploymentRegistry?.hostname === inClusterRegistryHostname
    const skopeoCommand = ["skopeo", "--command-timeout=30s", "inspect", "--raw"]
    if (inClusterRegistry) {
      // The in-cluster registry is not exposed, so we don't configure TLS on it.
      skopeoCommand.push("--tls-verify=false")
    }

    skopeoCommand.push(`docker://${remoteId}`)

    const containers = getKanikoContainers(registryHostname, inClusterRegistry, skopeoCommand)

    const runner = new PodRunner({
      api,
      podName,
      provider,
      image: kanikoImage,
      module,
      namespace: systemNamespace,
      spec: {
        shareProcessNamespace: true,
        volumes: [
          // Mount the docker auth secret, so skopeo can inspect private registries.
          getDockerAuthVolume(),
        ],
        containers,
      },
    })

    const res = await runner.startAndWait({
      ignoreError: true,
      interactive: false,
      log,
      // The timeout set on the skopeo command should kick in first
      timeout: 60,
    })

    // Non-zero exit code can both mean the manifest is not found, and any other unexpected error
    if (!res.success && !res.log.includes("manifest unknown")) {
      throw new RuntimeError(`Unable to query registry for image status: ${res.log}`, {
        command: skopeoCommand,
        output: res.log,
      })
    }

    return { ready: res.success }
  },
}

function getKanikoContainers(registryHostname: string, inClusterRegistry: boolean, skopeoCommand: string[]) {
  let commandStr: string
  if (inClusterRegistry) {
    commandStr = dedent`
      while true; do
        if pidof socat > /dev/null; then
          ${skopeoCommand.join(" ")};
          export exitcode=$?
          killall socat;
          exit $exitcode;
        else
          sleep 0.3;
        fi
      done
    `
  } else {
    commandStr = skopeoCommand.join(" ")
  }

  // Have to ensure the registry proxy is up before querying, in case the in-cluster registry is being used
  const containers: any = [
    {
      name: "skopeo",
      image: skopeoImage,
      command: ["sh", "-c", commandStr],
      volumeMounts: [
        {
          name: dockerAuthSecretName,
          mountPath: "/root/.docker",
          readOnly: true,
        },
      ],
    },
  ]

  // we only need the socat container if we're using the in cluster registry
  if (inClusterRegistry) {
    containers.push(getSocatContainer(registryHostname))
  }

  return containers
}

type BuildHandler = (params: BuildModuleParams<ContainerModule>) => Promise<BuildResult>

const localBuild: BuildHandler = async (params) => {
  const { ctx, module, log } = params
  const provider = ctx.provider as KubernetesProvider
  const buildResult = await buildContainerModule(params)

  if (!provider.config.deploymentRegistry) {
    if (provider.config.clusterType === "kind") {
      await loadImageToKind(buildResult, provider.config)
    } else if (provider.config.clusterType === "microk8s") {
      const imageId = await containerHelpers.getLocalImageId(module)
      await loadImageToMicrok8s({ module, imageId, log })
    }
    return buildResult
  }

  if (!(await containerHelpers.hasDockerfile(module))) {
    return buildResult
  }

  const localId = await containerHelpers.getLocalImageId(module)
  const remoteId = await containerHelpers.getDeploymentImageId(module, ctx.provider.config.deploymentRegistry)

  log.setState({ msg: `Pushing image ${remoteId} to cluster...` })

  await containerHelpers.dockerCli(module.buildPath, ["tag", localId, remoteId], log)
  await containerHelpers.dockerCli(module.buildPath, ["push", remoteId], log)

  return buildResult
}

const remoteBuild: BuildHandler = async (params) => {
  const { ctx, module, log } = params
  const provider = <KubernetesProvider>ctx.provider
  const namespace = await getAppNamespace(ctx, log, provider)
  const systemNamespace = await getSystemNamespace(provider, log)

  if (!(await containerHelpers.hasDockerfile(module))) {
    return {}
  }

  // Sync the build context to the remote sync service
  // -> Get a tunnel to the service
  log.setState("Syncing sources to cluster...")
  const syncFwd = await getPortForward({
    ctx,
    log,
    namespace: systemNamespace,
    targetResource: `Deployment/${buildSyncDeploymentName}`,
    port: RSYNC_PORT,
  })

  // -> Run rsync
  const buildRoot = resolve(module.buildPath, "..")
  // The '/./' trick is used to automatically create the correct target directory with rsync:
  // https://stackoverflow.com/questions/1636889/rsync-how-can-i-configure-it-to-create-target-directory-on-server
  let src = normalizeLocalRsyncPath(`${buildRoot}`) + `/./${module.name}/`
  const destination = `rsync://localhost:${syncFwd.localPort}/volume/${ctx.workingCopyId}/`
  const syncArgs = [
    "--recursive",
    "--relative",
    // Copy symlinks (Note: These are sanitized while syncing to the build staging dir)
    "--links",
    // Preserve permissions
    "--perms",
    // Preserve modification times
    "--times",
    "--compress",
    "--delete",
    "--temp-dir",
    "/tmp",
    src,
    destination,
  ]

  log.debug(`Syncing from ${src} to ${destination}`)

  // TODO: remove this after a few releases (from 0.10.15), since this is only necessary for environments initialized
  // with 0.10.14 or earlier.
  const buildSyncPod = await getRunningPodInDeployment(buildSyncDeploymentName, provider, log)

  if (!buildSyncPod) {
    throw new PluginError(`Could not find running build sync Pod`, {
      deploymentName: buildSyncDeploymentName,
      systemNamespace,
    })
  }

  // We retry a couple of times, because we may get intermittent connection issues or concurrency issues
  await pRetry(() => exec("rsync", syncArgs), {
    retries: 3,
    minTimeout: 500,
  })

  const localId = await containerHelpers.getLocalImageId(module)
  const deploymentImageId = await containerHelpers.getDeploymentImageId(module, provider.config.deploymentRegistry)
  const dockerfile = module.spec.dockerfile || "Dockerfile"

  // Because we're syncing to a shared volume, we need to scope by a unique ID
  const contextPath = `/garden-build/${ctx.workingCopyId}/${module.name}/`

  log.setState(`Building image ${localId}...`)

  let buildLog = ""

  // Stream debug log to a status line
  const stdout = split2()
  const statusLine = log.placeholder(LogLevel.verbose)

  stdout.on("error", () => {})
  stdout.on("data", (line: Buffer) => {
    statusLine.setState(renderOutputStream(line.toString()))
  })

  if (provider.config.buildMode === "cluster-docker") {
    // Prepare the build command
    const dockerfilePath = posix.join(contextPath, dockerfile)

    let args = [
      "docker",
      "build",
      "-t",
      deploymentImageId,
      "-f",
      dockerfilePath,
      contextPath,
      ...getDockerBuildFlags(module),
    ]

    // Execute the build
    const podName = await getBuilderPodName(provider, log)
    const buildTimeout = module.spec.build.timeout

    if (provider.config.clusterDocker && provider.config.clusterDocker.enableBuildKit) {
      args = ["/bin/sh", "-c", "DOCKER_BUILDKIT=1 " + args.join(" ")]
    }

    const buildRes = await execInBuilder({ provider, log, args, timeout: buildTimeout, podName, stdout })
    buildLog = buildRes.stdout + buildRes.stderr

    // Push the image to the registry
    log.setState({ msg: `Pushing image ${localId} to registry...` })

    const dockerCmd = ["docker", "push", deploymentImageId]
    const pushArgs = ["/bin/sh", "-c", dockerCmd.join(" ")]

    const pushRes = await execInBuilder({ provider, log, args: pushArgs, timeout: 300, podName, stdout })
    buildLog += pushRes.stdout + pushRes.stderr
  } else {
    // build with Kaniko
    const args = [
      "--context",
      "dir://" + contextPath,
      "--dockerfile",
      dockerfile,
      "--destination",
      deploymentImageId,
      "--cache=true",
    ]

    if (provider.config.deploymentRegistry?.hostname === inClusterRegistryHostname) {
      // The in-cluster registry is not exposed, so we don't configure TLS on it.
      args.push("--insecure")
    }

    args.push(...getDockerBuildFlags(module))

    // Execute the build
    const buildRes = await runKaniko({ provider, namespace, log, module, args, outputStream: stdout })
    buildLog = buildRes.log

    if (!buildRes.success) {
      throw new BuildError(`Failed building module ${chalk.bold(module.name)}:\n\n${buildLog}`, { buildLog })
    }
  }

  log.silly(buildLog)

  return {
    buildLog,
    fetched: false,
    fresh: true,
    version: module.version.versionString,
  }
}

export interface BuilderExecParams {
  provider: KubernetesProvider
  log: LogEntry
  args: string[]
  env?: { [key: string]: string }
  ignoreError?: boolean
  timeout: number
  podName: string
  stdout?: Writable
  stderr?: Writable
}

const buildHandlers: { [mode in ContainerBuildMode]: BuildHandler } = {
  "local-docker": localBuild,
  "cluster-docker": remoteBuild,
  "kaniko": remoteBuild,
}

// TODO: we should make a simple service around this instead of execing into containers
export async function execInBuilder({
  provider,
  log,
  args,
  ignoreError,
  timeout,
  podName,
  stdout,
  stderr,
}: BuilderExecParams) {
  const execCmd = ["exec", "-i", podName, "-c", dockerDaemonContainerName, "--", ...args]
  const systemNamespace = await getSystemNamespace(provider, log)

  log.verbose(`Running: kubectl ${execCmd.join(" ")}`)

  return kubectl.exec({
    args: execCmd,
    ignoreError,
    provider,
    log,
    namespace: systemNamespace,
    timeout,
    stdout,
    stderr,
  })
}

export async function getBuilderPodName(provider: KubernetesProvider, log: LogEntry) {
  const pod = await getRunningPodInDeployment(dockerDaemonDeploymentName, provider, log)
  const systemNamespace = await getSystemNamespace(provider, log)

  if (!pod) {
    throw new PluginError(`Could not find running image builder`, {
      builderDeploymentName: dockerDaemonDeploymentName,
      systemNamespace,
    })
  }

  return pod.metadata.name
}

interface RunKanikoParams {
  provider: KubernetesProvider
  namespace: string
  log: LogEntry
  module: ContainerModule
  args: string[]
  outputStream: Writable
}

async function runKaniko({ provider, namespace, log, module, args, outputStream }: RunKanikoParams) {
  const api = await KubeApi.factory(log, provider)
  const systemNamespace = await getSystemNamespace(provider, log)

  const podName = makePodName("kaniko", namespace, module.name)
  const registryHostname = getRegistryHostname(provider.config)
  const k8sSystemVars = getKubernetesSystemVariables(provider.config)
  const syncDataVolumeName = k8sSystemVars["sync-volume-name"]
  const commsVolumeName = "comms"
  const commsMountPath = "/.garden/comms"

  // Escape the args so that we can safely interpolate them into the kaniko command
  const argsStr = args.map((arg) => JSON.stringify(arg)).join(" ")

  // This may seem kind of insane but we have to wait until the socat proxy is up (because Kaniko immediately tries to
  // reach the registry we plan on pushing to). See the support container in the Pod spec below for more on this
  // hackery.
  const commandStr = dedent`
    while true; do
      if ls ${commsMountPath}/socatStarted > /dev/null; then
        /kaniko/executor ${argsStr};
        export exitcode=$?;
        touch ${commsMountPath}/done;
        exit $exitcode;
      else
        sleep 0.3;
      fi
    done
  `

  const runner = new PodRunner({
    api,
    podName,
    provider,
    image: kanikoImage,
    module,
    namespace: systemNamespace,
    spec: {
      shareProcessNamespace: true,
      volumes: [
        // Mount the build sync volume, to get the build context from.
        {
          name: syncDataVolumeName,
          persistentVolumeClaim: { claimName: syncDataVolumeName },
        },
        // Mount the docker auth secret, so Kaniko can pull from private registries.
        getDockerAuthVolume(),
        // Mount a volume to communicate between the containers in the Pod.
        {
          name: commsVolumeName,
          emptyDir: {},
        },
      ],
      containers: [
        {
          name: "kaniko",
          image: kanikoImage,
          command: ["sh", "-c", commandStr],
          volumeMounts: [
            {
              name: syncDataVolumeName,
              mountPath: "/garden-build",
            },
            {
              name: dockerAuthSecretName,
              mountPath: "/kaniko/.docker",
              readOnly: true,
            },
            {
              name: commsVolumeName,
              mountPath: commsMountPath,
            },
          ],
          resources: {
            limits: {
              cpu: millicpuToString(provider.config.resources.builder.limits.cpu),
              memory: megabytesToString(provider.config.resources.builder.limits.memory),
            },
            requests: {
              cpu: millicpuToString(provider.config.resources.builder.requests.cpu),
              memory: megabytesToString(provider.config.resources.builder.requests.memory),
            },
          },
        },
        getSocatContainer(registryHostname),
        // This is a workaround so that the kaniko executor can wait until socat starts, and so that the socat proxy
        // doesn't just keep running after the build finishes. Doing this in the kaniko Pod is currently not possible
        // because of https://github.com/GoogleContainerTools/distroless/issues/225
        {
          name: "support",
          image: "busybox:1.31.1",
          command: [
            "sh",
            "-c",
            dedent`
              while true; do
                if pidof socat > /dev/null; then
                  touch ${commsMountPath}/socatStarted;
                  break;
                else
                  sleep 0.3;
                fi
              done
              while true; do
                if ls ${commsMountPath}/done > /dev/null; then
                  killall socat; exit 0;
                else
                  sleep 0.3;
                fi
              done
            `,
          ],
          volumeMounts: [
            {
              name: commsVolumeName,
              mountPath: commsMountPath,
            },
          ],
        },
      ],
    },
  })

  return runner.startAndWait({
    ignoreError: true,
    interactive: false,
    log,
    timeout: module.spec.build.timeout,
    stdout: outputStream,
  })
}

async function getManifestInspectArgs(module: ContainerModule, deploymentRegistry: ContainerRegistryConfig) {
  const remoteId = await containerHelpers.getDeploymentImageId(module, deploymentRegistry)

  const dockerArgs = ["manifest", "inspect", remoteId]
  if (isLocalHostname(deploymentRegistry.hostname)) {
    dockerArgs.push("--insecure")
  }

  return dockerArgs
}

function isLocalHostname(hostname: string) {
  return hostname === "localhost" || hostname.startsWith("127.")
}

function getSocatContainer(registryHostname: string) {
  return {
    name: "proxy",
    image: "basi/socat:v0.1.0",
    command: ["/bin/sh", "-c", `socat TCP-LISTEN:5000,fork TCP:${registryHostname}:5000 || exit 0`],
    ports: [
      {
        name: "proxy",
        containerPort: registryPort,
        protocol: "TCP",
      },
    ],
    readinessProbe: {
      tcpSocket: { port: <any>registryPort },
    },
  }
}
