import request = require('request-promise-native');

export async function getSecretsFromGardenCloud(project: string, env: string) {
    const response = await request({
        json: true,
        resolveWithFullResponse: true,
        simple: false,
        strictSSL: false,
        uri: `http://solomon-cloud-api.cloud.dev.garden.io/secrets/project/${project}`,
        method: "GET"
    })

    if (response && response.statusCode === 200 && response.body) {
        return response.body
    }
    return null

}
