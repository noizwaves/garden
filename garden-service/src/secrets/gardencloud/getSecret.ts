import request = require('request-promise-native');
const GARDEN_CLOUD_URL = "http://solomon-cloud-api.cloud.dev.garden.io/secrets/project"

export async function getSecretsFromGardenCloud(project: string, env: string) {
    const response = await request({
        json: true,
        resolveWithFullResponse: true,
        simple: false,
        strictSSL: false,
        uri: `${GARDEN_CLOUD_URL}/1/env/${env}`,
        method: "GET"
    })

    if (response && response.statusCode === 200 && response.body && response.body.status === "success") {
        return response.body["data"]
    }

    return {}

}
