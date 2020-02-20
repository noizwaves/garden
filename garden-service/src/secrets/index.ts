import { getSecretsFromGardenCloud } from "./gardencloud/getSecret"

export async function getSecrets(config: any, environmentName: string) {
  const secrets = await getSecretsFromGardenCloud("hello", environmentName)
  return secrets
}