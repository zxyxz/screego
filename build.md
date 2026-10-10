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

# Live playback regression check (Node.js + Playwright + Edge)
# Start an isolated test instance with SCREEGO_AUTH_MODE=none first.
# SCREEGO_TEST_URL defaults to http://127.0.0.1:5050.
# PLAYWRIGHT_MODULE may point to an existing Playwright installation.
node ui/tests/live.cjs
