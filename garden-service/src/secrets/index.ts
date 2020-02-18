import { getSecretsFromGardenCloud } from "./gardencloud/getSecret"

export async function getSecrets(config: any) {
    const secrets = await getSecretsFromGardenCloud("hello", "")
    return secrets
}