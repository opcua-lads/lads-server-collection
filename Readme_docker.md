# Docker

## Docker Compose
### Start PoCs via _docker compose_
Adjust the settings of your PoC services. The configs for the different device types
can be found in the `docker-compose.d` directory
```text
./docker-compose.d/config.balance.json
./docker-compose.d/config.atmoweb.json
```

modify the profile in your `.env` to specify which services shall be started by default.
If you only want to start the balance service, specify the specific profile instead of all
```text
#COMPOSE_PROFILES=all
COMPOSE_PROFILES=balance
```

Then start the services via docker-compose
```
docker compose up -d
```

## Rebuild docker containers
If you made code changes, that shall be applied to the docker containers,
you have to rebuild them by executing
```
docker compose build
```

To build the containers for other platforms, e.g. Raspberry Pi 3B+, specify the target platform
```
DOCKER_DEFAULT_PLATFORM=linux/arm/v7 docker compose build --no-cache
```


### Install on edge-device
Export the built container as file
```shell
docker save lads-server-collection | gzip > "./lads-server-collection.tar.gz"
```

Copy the required file to the edge device
```shell
 scp -r docker-compose.* root@my-server:/opt/lads-poc
 scp lads-server-collection.tar.gz root@my-server:/opt/lads-poc
 scp .env.example root@my-server:/opt/lads-poc/.env
```

Login into the edge device and add the container to the registry:

```shell
docker load -i ./opt/lads-poc/lads-server-collection.tar.gz
```

Adjust the configuration files on your edge device
```text
# files to adjust
.env
docker-compose.d/config.*.json
```
