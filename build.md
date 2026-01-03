# need go,node-js
# ###### windows build ######
# set var
SET CGO_ENABLED=0
SET GOOS=windows
SET GOARCH=amd64

# build ui
cd ui && yarn install && yarn build && cd ..

# build go
go build -tags="netgo osusergo" -ldflags="-s -w -X main.version=dev -X main.commitHash=local -X main.mode=prod" -o screego.exe .