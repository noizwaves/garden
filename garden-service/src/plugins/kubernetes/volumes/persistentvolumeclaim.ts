/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { joiIdentifier, joi, joiArray } from "../../../config/common"
import { dedent } from "../../../util/string"
import { BaseVolumeSpec } from "../../base-volume"
import { V1PersistentVolumeClaimSpec, V1PersistentVolumeClaim } from "@kubernetes/client-node"
import { readFileSync } from "fs-extra"
import { join } from "path"
import { ModuleTypeDefinition } from "../../../types/plugin/plugin"
import { DOCS_BASE_URL, STATIC_DIR } from "../../../constants"
import { baseBuildSpecSchema } from "../../../config/module"
import { ConfigureModuleParams } from "../../../types/plugin/module/configure"
import { GetServiceStatusParams } from "../../../types/plugin/service/getServiceStatus"
import { Module } from "../../../types/module"
import { KubernetesModule, KubernetesModuleConfig, KubernetesService } from "../kubernetes-module/config"
import { KubernetesResource } from "../types"
import { getKubernetesServiceStatus, deployKubernetesService } from "../kubernetes-module/handlers"
import { DeployServiceParams } from "../../../types/plugin/service/deployService"
import { getModuleTypeUrl } from "../../../docs/common"

export interface PersistentVolumeClaimSpec extends BaseVolumeSpec {
  dependencies: string[]
  namespace: string
  spec: V1PersistentVolumeClaimSpec
}

type PersistentVolumeClaimModule = Module<PersistentVolumeClaimSpec, PersistentVolumeClaimSpec>

// Need to use a sync read to avoid having to refactor createGardenPlugin()
// The `persistentvolumeclaim.json` file is copied from the handy
// kubernetes-json-schema repo (https://github.com/instrumenta/kubernetes-json-schema/tree/master/v1.17.0-standalone).
const jsonSchema = JSON.parse(readFileSync(join(STATIC_DIR, "kubernetes", "persistentvolumeclaim.json")).toString())
const containerTypeUrl = getModuleTypeUrl("container")

export const pvcModuleDefinition: ModuleTypeDefinition = {
  name: "persistentvolumeclaim",
  docs: dedent`
    Creates a [PersistentVolumeClaim](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#persistentvolumeclaims) in your namespace, that can be referenced and mounted by other resources and [container modules](${containerTypeUrl}).

    See the [Mounting volumes](${DOCS_BASE_URL}/guides/container-modules#mounting-volumes) guide for more info and usage examples.
    `,
  schema: joi.object().keys({
    build: baseBuildSpecSchema(),
    dependencies: joiArray(joiIdentifier()).description(
      "List of services and tasks to deploy/run before deploying this PVC."
    ),
    namespace: joiIdentifier().description(
      "The namespace to deploy the PVC in. Note that any module referencing the PVC must be in the same namespace, so in most cases you should leave this unset."
    ),
    spec: joi
      .customObject()
      .jsonSchema({ ...jsonSchema.properties.spec, type: "object" })
      .required()
      .description(
        "The spec for the PVC. This is passed directly to the created PersistentVolumeClaim resource. Note that the spec schema may include (or even require) additional fields, depending on the used `storageClass`. See the [PersistentVolumeClaim docs](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#persistentvolumeclaims) for details."
      ),
  }),
  handlers: {
    async configure({ moduleConfig }: ConfigureModuleParams) {
      // No need to scan for files
      moduleConfig.include = []

      // Copy the access modes field to match the BaseVolumeSpec schema
      moduleConfig.spec.accessModes = moduleConfig.spec.spec.accessModes

      moduleConfig.serviceConfigs = [
        {
          dependencies: moduleConfig.spec.dependencies,
          disabled: moduleConfig.spec.disabled,
          hotReloadable: false,
          name: moduleConfig.name,
          spec: moduleConfig.spec,
        },
      ]

      return { moduleConfig }
    },

    async getServiceStatus(params: GetServiceStatusParams) {
      params.service = getKubernetesService(params.module)
      params.module = params.service.module

      return getKubernetesServiceStatus(params)
    },

    async deployService(params: DeployServiceParams) {
      params.service = getKubernetesService(params.module)
      params.module = params.service.module

      return deployKubernetesService(params)
    },
  },
}

/**
 * Maps a `persistentvolumeclaim` module to a `kubernetes` module (so we can re-use those handlers).
 */
function getKubernetesService(pvcModule: PersistentVolumeClaimModule): KubernetesService {
  const pvcManifest: KubernetesResource<V1PersistentVolumeClaim> = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: pvcModule.name,
    },
    spec: pvcModule.spec.spec,
  }

  const spec = {
    dependencies: pvcModule.spec.dependencies,
    files: [],
    manifests: [pvcManifest],
    tasks: [],
    tests: [],
  }

  const serviceConfig = {
    ...pvcModule.serviceConfigs[0],
    spec,
  }

  const config: KubernetesModuleConfig = {
    ...pvcModule,
    serviceConfigs: [serviceConfig],
    spec,
    taskConfigs: [],
    testConfigs: [],
  }

  const module: KubernetesModule = {
    ...pvcModule,
    _config: config,
    ...config,
    spec: {
      ...pvcModule.spec,
      files: [],
      manifests: [pvcManifest],
      tasks: [],
      tests: [],
    },
  }

  return {
    name: pvcModule.name,
    config: serviceConfig,
    disabled: pvcModule.disabled,
    module,
    sourceModule: module,
    spec,
  }
}
