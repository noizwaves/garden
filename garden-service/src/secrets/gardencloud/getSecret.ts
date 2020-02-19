import request = require('request-promise-native');
const GARDEN_CLOUD_HOSTNAME = process.env.GARDEN_CLOUD_URL || "https://cloud.garden.io"
// const GARDEN_CLOUD_VERSION = "v1"
const CLI_TOKEN = "THE_CLI_AUTH_TOKEN"

export async function getSecretsFromGardenCloud(project: string, env: string) {
    const response = await request({
        json: true,
        resolveWithFullResponse: true,
        simple: false,
        strictSSL: false,
        uri: `${GARDEN_CLOUD_HOSTNAME}/secrets/project/1/env/${env}`,
        method: "GET",
        qs: {
          cli_token: CLI_TOKEN,
        }
    })

    if (response && response.statusCode === 200 && response.body && response.body.status === "success") {
        return response.body["data"]
    }

    return {}

}
