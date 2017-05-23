
# mastodon-streaming-listener (not works yet)


This is a server to provide relay the notification from Mastodon's Streaming API to registered callback URL.

![slide1](https://cloud.githubusercontent.com/assets/333944/26376504/af071c76-4047-11e7-9308-2cd538be0439.jpg)

### Different things from Tusky-api.
- Separate streaming listener server and application server.
- Streaming listener server does not have application specific information. There is a possibility that it can correspond to multiple applications.
- Possible to replace the Streaming API URL to inside the LAN
- (It focus to make Streaming listener server by instance-owner)
- Since the application server does not handle WebSocket, it becomes easy to scale.
- Both the streaming listener server and the application server can be configured behaviors for each instance.
- Support only for a specific instance


## API

### POST /register 

(parameters)
- instanceUrl : URL of Mastodon instance you want to listen. ex) https://mastodon.juggler.jp .
- tag : any String that can be used for management in your app. this is also used for a part of unique key of registrations.
- appId,appSecret : ID and secret of the your app.
- accessToken : The access token you get from Mastodon's oAuth API.
- callbackUrl : The URL that will be called when new notification is arrived.

(notice)
Your app needs to call /register repeatly within 3 days to keep listening.

### POST /unregister

(parameters)
- instanceUrl : same of specified in /register.
- tag : same of specified in /register.
- appId : same of specified in /register.
- appSecret : secret of the your app.

(notice)
The unique key of listener registration is : instanceUrl + appId + tag.
If you want to certainly unregister registration, You have to make same these parameters.

### Callback
Callback is called with POST method.
Request body is Content-Type 'application/json' and it has following data.

- instanceUrl : same of specified in /register.
- tag : same of specified in /register.
- appId : same of specified in /register.
- payload : see document of Mastodon's Streaming API.


## installation (using docker-compose)

after git clone , you have to change some file.

```
# copy sample configuration files
cp db/app_map.hjson.sample db/app_map.hjson
cp db/instance_map.hjson.sample db/instance_map.hjson

(edit these .hjson files to configure for client app and instances)

# create new database file if not exists
sqlite db/streaming-listener.sqlite

# make database file that readable from 'app1' user in container
chown -R 1001:1001 db


docker-compose build

docker-compose up
```

default port is 4002. you can configure exposed port in docker-compose.yml.
You should make web frontend (nginx) to wrap with HTTPS.
