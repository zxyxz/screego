const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseURL = process.env.SCREEGO_TEST_URL || 'http://127.0.0.1:5050';

async function playback(page) {
    return page
        .locator('video')
        .first()
        .evaluate((video) => ({
            time: video.currentTime,
            frames: video.getVideoPlaybackQuality().totalVideoFrames,
            error: video.error?.message,
            readyState: video.readyState,
            buffered: Array.from({length: video.buffered.length}, (_, i) => [
                video.buffered.start(i),
                video.buffered.end(i),
            ]),
        }));
}

async function expectPlaying(page) {
    await page.waitForFunction(
        () => {
            const video = document.querySelector('video');
            return (
                video &&
                !video.paused &&
                video.currentTime > 0 &&
                video.readyState >= 3 &&
                video.getVideoPlaybackQuality().totalVideoFrames > 0
            );
        },
        undefined,
        {timeout: 15000}
    );
    const before = await playback(page);
    await page.waitForFunction(
        ({time, frames}) => {
            const video = document.querySelector('video');
            return (
                video?.currentTime > time + 0.5 &&
                video.getVideoPlaybackQuality().totalVideoFrames > frames
            );
        },
        before,
        {timeout: 5000}
    );
    const after = await playback(page);
    assert.equal(after.error, undefined);
    assert.ok(after.frames > before.frames, JSON.stringify({before, after}));
    const pixel = await page
        .locator('video')
        .first()
        .evaluate((video) => {
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext('2d');
            context.drawImage(video, 0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data];
        });
    assert.ok(pixel[0] + pixel[1] + pixel[2] > 100, `Blank video: ${pixel}`);
    return after;
}

async function runCase(browser, {name, sampleRate, staticImage, unsupportedAudio}) {
    const context = await browser.newContext({ignoreHTTPSErrors: true});
    const host = await context.newPage();
    const errors = [];
    const messages = [];
    host.on('console', (message) => {
        if (
            message.type() === 'error' ||
            message.type() === 'warn' ||
            message.text().startsWith('live encoder:')
        )
            messages.push(message.text());
    });
    host.on('pageerror', (error) => errors.push(String(error)));
    await host.addInitScript(
        ({sampleRate, staticImage, unsupportedAudio}) => {
            for (const [kind, Encoder] of [
                ['video', VideoEncoder],
                ['audio', AudioEncoder],
            ]) {
                const encode = Encoder.prototype.encode;
                Encoder.prototype.encode = function (frame, ...args) {
                    const samples = window.testSamples?.[kind];
                    if (samples && samples.length < 5) samples.push(frame.timestamp);
                    return encode.call(this, frame, ...args);
                };
            }
            localStorage.setItem('screegoSettingsVersion', '2');
            localStorage.setItem(
                'screegoSettings',
                JSON.stringify({
                    liveBitrateAuto: false,
                    liveBitrateMbps: 2,
                    framerate: 30,
                    preferCodec: {mimeType: 'video/H264'},
                })
            );
            if (unsupportedAudio) {
                const NativeProcessor = window.MediaStreamTrackProcessor;
                window.MediaStreamTrackProcessor = class extends NativeProcessor {
                    constructor(options) {
                        if (options.track.kind === 'audio')
                            throw new TypeError('Audio capture unsupported');
                        super(options);
                    }
                };
            }
            navigator.mediaDevices.getDisplayMedia = async () => {
                window.testSamples = {video: [], audio: []};
                const canvas = document.createElement('canvas');
                canvas.width = 640;
                canvas.height = 360;
                const drawing = canvas.getContext('2d');
                let frame = 0;
                const paint = () => {
                    drawing.fillStyle = frame++ % 2 ? '#cc4444' : '#44cc66';
                    drawing.fillRect(0, 0, 640, 360);
                };
                const stream = canvas.captureStream(30);
                paint();
                let timer = staticImage ? undefined : setInterval(paint, 33);
                const track = stream.getVideoTracks()[0];
                let audio;
                if (sampleRate) {
                    audio = new AudioContext({sampleRate});
                    const output = audio.createMediaStreamDestination();
                    const oscillator = audio.createOscillator();
                    oscillator.connect(output);
                    oscillator.start();
                    await audio.resume();
                    stream.addTrack(output.stream.getAudioTracks()[0]);
                }
                const stop = track.stop.bind(track);
                track.stop = () => {
                    clearInterval(timer);
                    void audio?.close();
                    stop();
                };
                window.testCapture = {
                    setMoving(moving) {
                        clearInterval(timer);
                        timer = moving ? setInterval(paint, 33) : undefined;
                    },
                };
                return stream;
            };
        },
        {sampleRate, staticImage, unsupportedAudio}
    );
    const room = `live-test-${name}-${Date.now()}`;
    let viewer;
    try {
        await host.goto(`${baseURL}/?room=${room}&create=true`);
        await host.getByText('暂无可观看的画面（等待主播开始共享）').waitFor();
        await host.keyboard.press('s');
        await host.getByRole('button', {name: /直播共享/}).click();
        await host.waitForFunction(() => document.body.textContent.includes('推流：'));

        viewer = await context.newPage();
        viewer.on('console', (message) => {
            if (message.type() === 'error' || message.type() === 'warn')
                messages.push(message.text());
        });
        viewer.on('pageerror', (error) => errors.push(String(error)));
        await viewer.goto(`${baseURL}/?room=${room}`);
        const initial = await expectPlaying(viewer);

        // Exercise cached init + rewind, after enough fragments for eviction.
        await host.waitForTimeout(3000);
        const late = await context.newPage();
        late.on('pageerror', (error) => errors.push(String(error)));
        await late.goto(`${baseURL}/?room=${room}`);
        const joinedLate = await expectPlaying(late);
        assert.ok(joinedLate.time > 2, `Late viewer did not seek into rewind: ${joinedLate.time}`);

        if (!staticImage) {
            await host.evaluate(() => window.testCapture.setMoving(false));
            await host.waitForTimeout(5000);
            await expectPlaying(viewer);
            await host.evaluate(() => window.testCapture.setMoving(true));
            await expectPlaying(viewer);
        }

        await host.keyboard.press('s');
        await viewer.getByText('暂无可观看的画面（等待主播开始共享）').waitFor();
        await late.getByText('暂无可观看的画面（等待主播开始共享）').waitFor();
        await host.keyboard.press('s');
        await host.getByRole('button', {name: /直播共享/}).click();
        const restarted = await expectPlaying(viewer);
        await host.keyboard.press('s');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({name, initial, joinedLate, restarted}));
    } catch (error) {
        console.error(
            JSON.stringify({
                name,
                errors,
                messages,
                host: await host.locator('body').innerText(),
                samples: await host.evaluate(() => window.testSamples),
                viewer: await viewer?.locator('body').innerText(),
                playback: viewer && (await playback(viewer).catch(() => null)),
            })
        );
        throw error;
    } finally {
        await context.close();
    }
}

(async () => {
    const config = await (await fetch(`${baseURL}/config`)).json();
    assert.equal(
        config.authMode,
        'none',
        'Run this test against an isolated authMode=none instance'
    );
    const browser = await chromium.launch({
        channel: process.env.SCREEGO_TEST_BROWSER || 'msedge',
        headless: true,
        args: ['--disable-features=LocalNetworkAccessChecks'],
    });
    try {
        for (const testCase of [
            {name: 'static', staticImage: true},
            {name: 'video'},
            {name: 'opus-44100', sampleRate: 44100},
            {name: 'opus-48000', sampleRate: 48000},
            {name: 'audio-unavailable', sampleRate: 44100, unsupportedAudio: true},
        ].filter(
            (testCase) => process.argv.length < 3 || process.argv.slice(2).includes(testCase.name)
        )) {
            await runCase(browser, testCase);
        }
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
