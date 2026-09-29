import {Muxer, StreamTarget} from 'mp4-muxer';
import {loadSettings} from '../settings';
import {liveMimeType, LiveInfo, liveWsURL, resolveLiveCodecCandidates} from './shared';

export interface LivePushStats {
    /** Frames encoded per second. */
    fps: number;
    /** Frames delivered by the capture track per second. */
    capturedFps: number;
    /** Frames discarded per second (framerate thinning or encoder backlog). */
    droppedFps: number;
    /** 5s rolling average of the actually sent rate. */
    mbps: number;
    /** Instantaneous rate (bursty: fragments are emitted in batches). */
    instantMbps: number;
    /** Bitrate the encoder is currently targeting. */
    targetMbps: number;
    queue: number;
    backlogMB: number;
    sentMB: number;
}

export interface LivePushCallbacks {
    /** Resolved live bitrate in Mbps (server bandwidth or manual override). */
    liveBitrateMbps: number;
    /** Resolved capture framerate in fps (auto rule applied by the caller). */
    framerate: number;
    onFail: (message: string) => void;
    onStats: (stats: LivePushStats) => void;
    /** Called when the encoder had to lower its target to fit the pipe. */
    onBitrateAdjusted?: (targetMbps: number) => void;
    /** Called when the encoder could not sustain the target framerate. */
    onFpsAdjusted?: (fps: number) => void;
}

// Pushes a captured MediaStream to the live relay: WebCodecs encode (hardware
// preferred, quality latency mode) -> fMP4 fragments -> websocket. Returns a
// stop function; the caller keeps ownership of the stream.
export const startLivePush = async (
    media: MediaStream,
    session: {id: string; token: string},
    callbacks: LivePushCallbacks
): Promise<{stop: () => void}> => {
    const settings = loadSettings();
    let running = true;
    let failed = false;

    const fail = (message: string) => {
        if (failed) {
            return;
        }
        failed = true;
        running = false;
        callbacks.onFail(message);
    };

    const videoTrack = media.getVideoTracks()[0];
    const audioTrack = media.getAudioTracks()[0] ?? null;
    if (!videoTrack) {
        throw new Error('未找到视频轨道');
    }

    const vSettings = videoTrack.getSettings();
    // H.264 4:2:0 requires even dimensions, and right after gDM the capture
    // track sometimes reports nothing usable yet — fall back to 1080p then.
    const sanitizeEven = (v: number | undefined, fallback: number): number => {
        if (v === undefined || !Number.isFinite(v) || v < 2) {
            return fallback;
        }
        return v - (v % 2);
    };
    const width = sanitizeEven(vSettings.width, 1920);
    const height = sanitizeEven(vSettings.height, 1080);

    // The caller resolved the framerate (manual choice or the bandwidth-based
    // auto rule) and already captures at this exact rate: smoothness matters
    // more than per-frame sharpness, and CBR keeps the pipe safe by trading
    // quality per frame instead of raising the bitrate.
    const framerate = callbacks.framerate;

    // Encoder configuration preference order:
    // 1. CBR + realtime: the throughput path WebRTC itself uses for screen
    //    share; CBR holds the server's bitrate. 'quality' invites encoders to
    //    buffer frames (lookahead), which silently collapses the effective
    //    framerate when the hardware encoder does not engage.
    // 2. CBR + quality: for encoders that only accept it.
    // 3. VBR + realtime: last resort, guarded by the auto-adjust loop below.
    const combos: Array<{latencyMode: LatencyMode; bitrateMode: BitrateMode}> = [
        {latencyMode: 'realtime', bitrateMode: 'constant'},
        {latencyMode: 'quality', bitrateMode: 'constant'},
        {latencyMode: 'realtime', bitrateMode: 'variable'},
    ];
    let chosen: VideoEncoderConfig | undefined;
    let candidate:
        | {webCodecs: string; muxer: 'avc' | 'hevc' | 'av1' | 'vp9'; label: string}
        | undefined;
    if (typeof VideoEncoder === 'undefined') {
        throw new Error('当前浏览器不支持 WebCodecs，直播共享需要较新的 Chrome/Edge');
    }
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Probing only ranks candidates; the winner is decided by configure()
    // below, walking down this list.
    const viable: Array<{
        config: VideoEncoderConfig;
        candidate: {webCodecs: string; muxer: 'avc' | 'hevc' | 'av1' | 'vp9'; label: string};
    }> = [];
    const probeOnce = async (): Promise<void> => {
        // Two passes: when the hardware encoder is momentarily unavailable
        // some Chrome builds report prefer-hardware as unsupported instead of
        // falling back, so retry everything without a preference afterwards.
        const accels: Array<'prefer-hardware' | undefined> = ['prefer-hardware', undefined];
        for (const accel of accels) {
            for (const c of resolveLiveCodecCandidates(settings.preferCodec)) {
                if (viable.some((v) => v.candidate.webCodecs === c.webCodecs)) {
                    continue;
                }
                for (const combo of combos) {
                    const config: VideoEncoderConfig = {
                        codec: c.webCodecs,
                        width,
                        height,
                        bitrate: callbacks.liveBitrateMbps * 1_000_000,
                        framerate,
                        latencyMode: combo.latencyMode,
                        ...(accel ? {hardwareAcceleration: accel} : {}),
                        bitrateMode: combo.bitrateMode,
                    };
                    let support: VideoEncoderSupport | undefined;
                    try {
                        support = await VideoEncoder.isConfigSupported(config);
                    } catch (e) {
                        // Transient GPU/codec-system failures throw instead of
                        // reporting supported:false — retry each combo once.
                        console.warn(
                            'live codec probe error',
                            c.webCodecs,
                            combo.latencyMode,
                            combo.bitrateMode,
                            e
                        );
                        await delay(250);
                        try {
                            support = await VideoEncoder.isConfigSupported(config);
                        } catch (e2) {
                            console.warn('live codec probe still failing', c.webCodecs, e2);
                            continue;
                        }
                    }
                    if (support.supported) {
                        viable.push({config, candidate: c});
                        break;
                    }
                }
            }
        }
    };
    await probeOnce();
    // A busy GPU process or an encoder session that was just released can
    // fail the whole scan; rescan a couple of times before giving up.
    for (let scan = 1; viable.length === 0 && scan <= 2; scan++) {
        console.warn(`live codec probe: no encoder found (scan ${scan}), retrying…`);
        await delay(400);
        await probeOnce();
    }
    if (viable.length === 0) {
        throw new Error('没有可用的视频编码器（偶发失败重试即可；反复出现请更新 Chrome/Edge）');
    }

    const socket = new WebSocket(liveWsURL(session.id, 'host', session.token));
    socket.binaryType = 'arraybuffer';
    try {
        await new Promise<void>((resolve, reject) => {
            socket.onopen = () => resolve();
            socket.onclose = (e) =>
                reject(new Error(e.reason || `直播服务器拒绝连接（${e.code}）`));
            socket.onerror = () => reject(new Error('无法连接直播服务器'));
        });
    } catch (e) {
        fail((e as Error).message);
        throw e;
    }

    // The muxer writes mostly sequentially, but be defensive: buffer
    // out-of-order writes until the gap fills. On top of that the byte stream
    // is split at box boundaries: everything before the first moof/styp box is
    // the fMP4 init segment (ftyp+moov) and MUST be sent as one dedicated,
    // never-evicted message — the muxer happily batches moov together with the
    // first fragments, and a truncated init breaks every late-joining viewer.
    const binaryTagInit = 0x00;
    const binaryTagMedia = 0x01;
    type LooseBytes = Uint8Array<ArrayBufferLike>;
    let nextPosition = 0;
    let sentBytes = 0;
    let stopping = false;
    let initPhase = true;
    let initBytes: LooseBytes = new Uint8Array(0);
    let parseBytes: LooseBytes = new Uint8Array(0);
    const pending = new Map<number, LooseBytes>();

    const copyOf = (view: LooseBytes): LooseBytes => {
        const out = new Uint8Array(view.byteLength);
        out.set(view, 0);
        return out;
    };

    const concat = (a: LooseBytes, b: LooseBytes): LooseBytes => {
        const out = new Uint8Array(a.byteLength + b.byteLength);
        out.set(a, 0);
        out.set(b, a.byteLength);
        return out;
    };

    const sendTagged = (tag: number, payload: LooseBytes) => {
        if (stopping || payload.byteLength === 0 || socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const message = new Uint8Array(payload.byteLength + 1);
        message[0] = tag;
        message.set(payload, 1);
        socket.send(message);
    };

    const onInitPhaseBytes = (chunk: LooseBytes) => {
        parseBytes = concat(parseBytes, chunk);
        let offset = 0;
        while (parseBytes.byteLength - offset >= 8) {
            const view = new DataView(parseBytes.buffer, parseBytes.byteOffset + offset, 8);
            let size = view.getUint32(0);
            const type = String.fromCharCode(
                parseBytes[offset + 4],
                parseBytes[offset + 5],
                parseBytes[offset + 6],
                parseBytes[offset + 7]
            );
            let headerSize = 8;
            if (size === 1) {
                if (parseBytes.byteLength - offset < 16) {
                    break;
                }
                size = Number(
                    new DataView(
                        parseBytes.buffer,
                        parseBytes.byteOffset + offset,
                        16
                    ).getBigUint64(8)
                );
                headerSize = 16;
            }
            if (size < headerSize || offset + size > parseBytes.byteLength) {
                break; // incomplete box, wait for more bytes
            }
            if (type === 'moof' || type === 'styp' || type === 'mdat') {
                // The init segment ends right here.
                const init = concat(initBytes, copyOf(parseBytes.subarray(0, offset)));
                const media = copyOf(parseBytes.subarray(offset));
                initBytes = new Uint8Array(0);
                parseBytes = new Uint8Array(0);
                initPhase = false;
                sendTagged(binaryTagInit, init);
                sendTagged(binaryTagMedia, media);
                return;
            }
            offset += size;
        }
        if (offset > 0) {
            initBytes = concat(initBytes, copyOf(parseBytes.subarray(0, offset)));
            parseBytes = copyOf(parseBytes.subarray(offset));
        }
    };

    const onData = (data: LooseBytes, position: number) => {
        pending.set(position, data);
        while (pending.has(nextPosition)) {
            const chunk = pending.get(nextPosition)!;
            pending.delete(nextPosition);
            nextPosition += chunk.byteLength;
            sentBytes += chunk.byteLength;
            if (initPhase) {
                onInitPhaseBytes(chunk);
            } else {
                sendTagged(binaryTagMedia, chunk);
            }
        }
        if (pending.size > 8) {
            console.warn('live muxer wrote out of order, positions:', [...pending.keys()]);
        }
    };

    let muxer: Muxer<StreamTarget> | undefined;
    let audioEncoder: AudioEncoder | undefined;
    let audioConfigured = false;
    let channels = 2;
    let sampleRate = 48000;
    if (audioTrack) {
        const aSettings = audioTrack.getSettings();
        channels = Math.min(2, aSettings.channelCount ?? 2);
        sampleRate = aSettings.sampleRate ?? 48000;
        audioEncoder = new AudioEncoder({
            output: (chunk, meta) => muxer?.addAudioChunk(chunk, meta),
            error: (e) => fail(`音频编码器错误：${e}`),
        });
        try {
            audioEncoder.configure({
                codec: 'opus',
                sampleRate,
                numberOfChannels: channels,
                bitrate: 128_000,
            });
            audioConfigured = true;
        } catch (e) {
            console.warn('audio encoder unavailable, streaming video only', e);
            audioEncoder.close();
            audioEncoder = undefined;
        }
    }

    // Created before the muxer exists, but nothing encodes until the pump at
    // the bottom starts — by then `muxer` is assigned.
    const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
        error: (e) => fail(`视频编码器错误：${e}`),
    });
    let configureError: unknown;
    for (const v of viable) {
        try {
            videoEncoder.configure(v.config);
            chosen = v.config;
            candidate = v.candidate;
            break;
        } catch (e) {
            configureError = e;
            console.warn('live encoder configure failed', v.candidate.webCodecs, e);
        }
    }
    if (!chosen || !candidate) {
        throw configureError instanceof Error
            ? configureError
            : new Error('视频编码器配置失败');
    }
    console.log(
        'live encoder:',
        chosen.codec,
        chosen.bitrateMode ?? 'variable',
        chosen.latencyMode ?? 'quality',
        `${callbacks.liveBitrateMbps} Mbps`,
        `${framerate} fps`,
        `${width}x${height}`
    );

    muxer = new Muxer({
        target: new StreamTarget({onData}),
        fastStart: 'fragmented',
        minFragmentDuration: 1,
        firstTimestampBehavior: 'cross-track-offset',
        video: {codec: candidate.muxer, width, height},
        ...(audioConfigured
            ? {audio: {codec: 'opus' as const, numberOfChannels: channels, sampleRate}}
            : {}),
    });

    const info: LiveInfo = {
        type: 'info',
        mimeType: liveMimeType(candidate.webCodecs, audioConfigured),
        videoCodec: candidate.label,
        width,
        height,
        hasAudio: audioConfigured,
        fps: framerate,
    };
    socket.send(JSON.stringify(info));

    const cleanup = () => {
        // finalize() emits a trailing mfra box; drop anything from here on so
        // no stray bytes reach the viewers.
        stopping = true;
        try {
            videoEncoder.close();
        } catch {
            // already closed
        }
        try {
            audioEncoder?.close();
        } catch {
            // already closed
        }
        try {
            muxer?.finalize();
        } catch {
            // stream is gone, nothing to finalize
        }
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1000, 'host stopped');
        }
    };

    socket.onmessage = () => {
        // viewer count messages are not surfaced in room mode
    };
    socket.onclose = (event) => {
        if (running) {
            fail(`与服务器的连接断开：${event.reason || event.code}`);
        }
    };

    // Video pump: MediaStreamTrackProcessor -> VideoEncoder -> muxer.
    let lastKeyTimestamp = -1e12;
    let recentFrames = 0;
    // Capture-side counters: what the track delivers vs what we discard. A
    // capture that only delivers 30fps is the most common reason a "60fps"
    // live share looks identical at 4 and 20 Mbps.
    let recentCaptured = 0;
    let recentDropped = 0;
    // The thinning gate and the meter share this: the meter may lower it when
    // the encoder proves unable to sustain the target framerate.
    let activeFramerate = framerate;
    let lastSentBytes = 0;
    // The muxer emits fragments in batches, so the instantaneous rate swings
    // wildly (a ~1MB fragment inside one window reads ~8 Mbps, the next window
    // reads 0). Track a 5s rolling average instead, and use it to close the
    // loop on the encoder when it overshoots the server's pipe.
    const rateHistory: number[] = [];
    let targetMbps = callbacks.liveBitrateMbps;
    let overshootStreak = 0;
    let adjustments = 0;
    // Sustained encoder overload: when the queue keeps growing while frames
    // are being dropped, the encoder cannot sustain the target framerate —
    // halve it cleanly instead of stutter-dropping every other frame.
    let overloadStreak = 0;
    const meter = window.setInterval(() => {
        const instantMbps = ((sentBytes - lastSentBytes) * 8) / 1_000_000;
        rateHistory.push(instantMbps);
        if (rateHistory.length > 5) {
            rateHistory.shift();
        }
        const avgMbps = rateHistory.reduce((a, b) => a + b, 0) / rateHistory.length;
        callbacks.onStats({
            fps: recentFrames,
            capturedFps: recentCaptured,
            droppedFps: recentDropped,
            mbps: avgMbps,
            instantMbps,
            targetMbps,
            queue: videoEncoder.encodeQueueSize,
            backlogMB: socket.bufferedAmount / (1024 * 1024),
            sentMB: sentBytes / (1024 * 1024),
        });
        if (socket.bufferedAmount > 4 * 1024 * 1024) {
            console.warn('live push backlog:', (socket.bufferedAmount / 1048576).toFixed(1), 'MB');
        }
        // Only bitrate changes are pushed: resolution/profile stay untouched,
        // so the fMP4 init segment (and every viewer's decoder) stays valid.
        if (rateHistory.length >= 3 && avgMbps > targetMbps * 1.25) {
            overshootStreak += 1;
        } else {
            overshootStreak = 0;
        }
        if (overshootStreak >= 3 && adjustments < 3) {
            const nextTarget = Math.max(1.5, Math.round(targetMbps * 0.8 * 10) / 10);
            if (nextTarget < targetMbps) {
                targetMbps = nextTarget;
                adjustments += 1;
                overshootStreak = 0;
                try {
                    videoEncoder.configure({...chosen!, bitrate: targetMbps * 1_000_000});
                    console.warn(
                        'live bitrate auto-reduced to',
                        targetMbps,
                        'Mbps (measured',
                        avgMbps.toFixed(1),
                        'Mbps)'
                    );
                    callbacks.onBitrateAdjusted?.(targetMbps);
                } catch (e) {
                    console.warn('could not reconfigure encoder', e);
                }
            }
        }
        if (recentDropped > 0 && videoEncoder.encodeQueueSize > 8) {
            overloadStreak += 1;
        } else {
            overloadStreak = 0;
        }
        if (overloadStreak >= 4 && activeFramerate > 30) {
            const nextFps = 30;
            try {
                videoEncoder.configure({...chosen!, framerate: nextFps});
                activeFramerate = nextFps;
                overloadStreak = 0;
                console.warn('live encoder overloaded, framerate auto-reduced to', nextFps);
                callbacks.onFpsAdjusted?.(nextFps);
            } catch (e) {
                console.warn('could not reconfigure encoder framerate', e);
            }
        }
        recentFrames = 0;
        recentCaptured = 0;
        recentDropped = 0;
        lastSentBytes = sentBytes;
    }, 1000);

    const processor = new MediaStreamTrackProcessor({track: videoTrack});
    const reader = processor.readable.getReader();
    (async () => {
        let lastEncodedTimestamp = -1;
        while (running) {
            const {value: frame, done} = await reader.read();
            if (done || !frame) {
                break;
            }
            const timestamp = frame.timestamp ?? 0;
            recentCaptured++;
            const frameIntervalUs = 1_000_000 / activeFramerate;
            // The capture may run faster than the configured framerate: thin
            // the surplus so the encoder really runs at that rate. 0.9 leaves
            // room for capture jitter without dropping frames when source and
            // target framerate match.
            if (
                lastEncodedTimestamp >= 0 &&
                timestamp - lastEncodedTimestamp < frameIntervalUs * 0.9
            ) {
                recentDropped++;
                frame.close();
                continue;
            }
            // Force keyframes every 2s: fragments are keyframe aligned, so
            // this bounds the rewind needed by late joining viewers.
            const keyFrame = timestamp - lastKeyTimestamp >= 2_000_000;
            if (videoEncoder.encodeQueueSize > 30) {
                // encoder cannot keep up; drop this frame
                recentDropped++;
                frame.close();
                continue;
            }
            videoEncoder.encode(frame, {keyFrame});
            lastEncodedTimestamp = timestamp;
            if (keyFrame) {
                lastKeyTimestamp = timestamp;
            }
            frame.close();
            recentFrames++;
        }
    })().catch((e) => fail(`视频采集中断：${e}`));

    if (audioTrack && audioEncoder) {
        const audioProcessor = new MediaStreamTrackProcessor({track: audioTrack});
        const audioReader = audioProcessor.readable.getReader();
        (async () => {
            while (running) {
                const {value: data, done} = await audioReader.read();
                if (done || !data) {
                    break;
                }
                audioEncoder.encode(data);
                data.close();
            }
        })().catch((e) => console.warn('audio capture stopped', e));
    }

    return {
        stop: () => {
            running = false;
            clearInterval(meter);
            cleanup();
        },
    };
};
