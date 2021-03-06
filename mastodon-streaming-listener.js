import WebSocket from 'ws'
import express from 'express'
import axios from 'axios'
import bodyParser from 'body-parser'
import npmlog from 'npmlog'
import morgan from 'morgan'
import Sequelize from 'sequelize'
import Hjson from 'hjson'
import fs from 'fs'
import util from 'util'

const app = express()
const port = process.env.PORT || 4002
const wsStorage = {}

process.on('unhandledRejection', console.dir);

const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASS, {
        dialect: process.env.DB_DIALECT,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        logging: npmlog.verbose
    }
)

const appMap = Hjson.parse(fs.readFileSync('config/app_map.hjson', 'utf8'));

const instanceMap = Hjson.parse(fs.readFileSync('config/instance_map.hjson', 'utf8'));

const Registration = sequelize.define('stream_listener_registration', {

    lastUpdate: {
        type: Sequelize.BIGINT,
        defaultValue: 0
    },

    instanceUrl: {
        type: Sequelize.STRING
    },

    accessToken: {
        type: Sequelize.STRING
    },

    appId: {
        type: Sequelize.STRING
    },

    appSecret: {
        type: Sequelize.STRING
    },

    callbackUrl: {
        type: Sequelize.STRING
    },

    tag: {
        type: Sequelize.STRING
    }
})


const checkAppId = (appId, appSecret) => {
    if (!appId) {
        return 'missing app_id';
    }
    var appEntry = appMap[appId];
    if (!appEntry) {
        return 'missing app configuration for app: ' + appId
    }

    if (appEntry.secret !== appSecret) {
        return 'app_secret not match.'
    }

    return null;
}

const checkInstanceUrl = (instanceUrl) => {

    if (!instanceUrl) {
        return 'missing instance_url';
    }

    var instanceEntry = instanceMap[instanceUrl];
    if (!instanceEntry) {
        instanceEntry = instanceMap['*'];

        if (!instanceEntry) {
            return 'missing instance configuration for instance: ' + instanceUrl;
        }
    }

    return null;
}

const getReplaceUrl = (instanceUrl) => {

    if (instanceUrl) {
        var instanceEntry = instanceMap[instanceUrl];
        if (instanceEntry) {
            const replaceUrl = instanceEntry.replaceUrl;
            if (replaceUrl) return replaceUrl;
        }
    }
    return instanceUrl;
}

const checkAccessToken = (accessToken) => {
    if (!accessToken) {
        return 'missing access_token';
    }
    if (accessToken.match(/[?&=/]/)) {
        return 'access_token contains invalid character';
    }

    return null;
}


const connectForUser = (registration) => {

    const ws_key = `${registration.instanceUrl}:${registration.appId}:${registration.tag}`;

    const log = (level, message) => npmlog.log(level, ws_key, message)

    if (typeof wsStorage[ws_key] !== 'undefined') {
        log('info', 'Already registered')
        return true;
    }

    let heartbeat
    let last_check = 0

    const close = () => {
        clearInterval(heartbeat)
        disconnectForUser(registration);
    }

    var error = checkAppId(registration.appId, registration.appSecret);
    if (error) {
        log('error', error);
        close();
        return false;
    }

    error = checkInstanceUrl(registration.instanceUrl)
    if (error) {
        log('error', error);
        close();
        return false;
    }

    log('info', 'making WebSocket')

    const onMessage = data => {
        const json = JSON.parse(data)

        if (json.event !== 'notification') {
            return
        }

        log('info', `notification received: ${json.event}`)

        // send to callback

        const message = {
            instanceUrl: registration.instanceUrl,
            tag: registration.tag,
            appId: registration.appId,
            payload: json.payload
        }

        axios.post(
            registration.callbackUrl,
            JSON.stringify(message), {
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        ).then(response => {
            log('info', `Sent to Callback, status ${response.status}: ${JSON.stringify(response.data)}`)
        }).catch(error => {
            log('error', `Error sending to FCM, status: ${error.response.status}: ${JSON.stringify(error.response.data)}`)
        })
    }

    const onError = error => {
        log('error', error)
        setTimeout(() => reconnect(), 5000)
    }

    const onClose = code => {
        if (code === 1000) {
            log('info', 'Remote server closed connection')
            close()
            return
        }

        log('error', `Unexpected close: ${code}`)
        setTimeout(() => reconnect(), 5000)
    }

    const reconnect = () => {

        clearInterval(heartbeat)

        const url = getReplaceUrl(registration.instanceUrl);
        const ws = new WebSocket(`${url}/api/v1/streaming/?access_token=${registration.accessToken}&stream=user`)

        ws.on('open', () => {
            if (ws.readyState != 1) {
                log('error', `Client state is: ${ws.readyState}`)
            } else {
                log('info', 'Connected')
                heartbeat = setInterval(() => {

                    ws.ping();

                    const now = (new Date()).getTime();

                    if (now - last_check >= 86400000) {
                        last_check = now;
                        Registration.findOne({
                            where: {
                                instanceUrl: registration.instanceUrl,
                                appId: registration.appId,
                                tag: registration.tag
                            }
                        }).then((r) => {
                            if (!r) {
                                close();
                                return;
                            }
                            if (now - r.lastUpdate >= 86400000 * 3) {
                                log('error', 'registration expired.')
                                close();
                                return;
                            }
                        })

                    }
                }, 10000)
            }
        })

        ws.on('message', onMessage)
        ws.on('error', onError)
        ws.on('close', onClose)

        wsStorage[ws_key] = ws;
    }

    reconnect()
}

const disconnectForUser = (registration) => {

    const ws_key = `${registration.instanceUrl}:${registration.appId}:${registration.tag}`;

    const log = (level, message) => npmlog.log(level, ws_key, message)

    const ws = wsStorage[ws_key]
    if (typeof ws !== 'undefined') {
        ws.close()
        delete wsStorage[ws_key]
        log('info', 'WebSocket removed.')
    }

    registration.destroy();
    log('info', 'Registration destroyed.')
}

// DBに登録された項目のStreaming API 接続を復元する
Registration.sync()
    .then(() => Registration.findAll())
    .then(registrations => registrations.forEach(registration => {
        connectForUser(registration);
    }))


app.use(morgan('combined'));
app.use(bodyParser.urlencoded({
    extended: true
}))

app.get('/', (req, res) => {
    res.sendStatus(204)
})

app.post('/register', (req, res) => {

    const log = (level, message) => npmlog.log(level, "register", message)

    const now = (new Date()).getTime();

    var error;

    if (!req.body.instance_url) {
        log('info', util.inspect(req));
    }


    const instanceUrl = req.body.instance_url.toLowerCase();
    error = checkInstanceUrl(instanceUrl)
    if (error) {
        res.status(400).send(error);
        return;
    }

    const accessToken = req.body.access_token
    error = checkAccessToken(accessToken)
    if (error) {
        res.status(400).send(error);
        return;
    }

    const appId = req.body.app_id
    const appSecret = req.body.app_secret
    error = checkAppId(appId, appSecret)
    if (error) {
        res.status(400).send(error);
        return;
    }

    const callbackUrl = req.body.callback_url
    const tag = req.body.tag

    /////////////////////////////////////
    // check instance url 

    Registration.findOrCreate({
        where: {
            instanceUrl: instanceUrl,
            appId: appId,
            tag: tag
        }
    }).then((args) => {
        const model = args[0]
        // const created = args[1]
        if (model) {
            model.update({
                lastUpdate: now,
                accessToken: accessToken,
                callbackUrl: callbackUrl,
                appSecret: appSecret
            }).then((unused) => {
                connectForUser(model);
            })
        }
    }).catch(error => {
        log('error', error)
    })

    res.sendStatus(202)
})

app.post('/unregister', (req, res) => {

    const log = (level, message) => npmlog.log(level, "unregister", message)

    if (!req.body.instance_url) {
        log('info', util.inspect(req));
    }

    const instanceUrl = req.body.instance_url.toLowerCase();
    const tag = req.body.tag

    const appId = req.body.app_id
    const appSecret = req.body.app_secret
    var error = checkAppId(appId, appSecret)
    if (error) {
        res.status(400).send(error);
        return;
    }

    Registration.findOne({
        where: {
            instanceUrl: instanceUrl,
            appId: appId,
            tag: tag
        }
    }).then((registration) => {
        if (registration) {
            disconnectForUser(registration)
        }
    }).catch(error => {
        log('error', error)
    })

    res.sendStatus(202)
})

app.listen(port, () => {
    npmlog.log('info', `Listening on port ${port}`)
})