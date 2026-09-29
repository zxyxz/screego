import React from 'react';
import {Box, Typography} from '@mui/material';
import {loadSettings} from '../settings';
import {LiveInfo, liveWsURL} from './shared';

type PlayerStatus = 'connecting' | 'buffering' | 'playing' | 'error';

// LivePlayer renders the room's live (server relayed) stream with MSE and
// live-edge chasing. It is embedded in the room page whenever the room info
// announces an active live share. The video element is handed to the room so
// the shared fullscreen button / hotkeys work in live mode too.
export const LivePlayer = ({
    roomID,
    token,
    onVideoElement,
}: {
    roomID: string;
    token: string;
    onVideoElement?: (element: HTMLVideoElement | null) => void;
}) => {
    const [status, setStatus] = React.useState<PlayerStatus>('connecting');
    const [error, setError] = React.useState('');
    const [latency, setLatency] = React.useState(0);
    // Decoded-side numbers: what the viewer's machine actually renders. This is
    // the ground truth for "is it smooth": if the host encodes 60fps but this
    // reads 30, frames are lost here (decode/display), not on the wire.
    const [stats, setStats] = React.useState({fps: 0, dropped: 0, mbps: 0, hostFps: 0});

    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    const socketRef = React.useRef<WebSocket | undefined>(undefined);
    const queueRef = React.useRef<Uint8Array<ArrayBuffer>[]>([]);
    const sourceBufferRef = React.useRef<SourceBuffer | undefined>(undefined);
    const startedRef = React.useRef(false);
    const generationRef = React.useRef(0);
    const reconnectTimer = React.useRef<number>(0);
    const attemptsRef = React.useRef(0);
    const [starved, setStarved] = React.useState(false);
    const starveCountRef = React.useRef(0);

    const fullReset = React.useCallback(() => {
        generationRef.current++;
        startedRef.current = false;
        queueRef.current = [];
        sourceBufferRef.current = undefined;
        setStarved(false);
        starveCountRef.current = 0;
        if (socketRef.current) {
            const socket = socketRef.current;
            socketRef.current = undefined;
            socket.onclose = null;
            socket.close();
        }
        const video = videoRef.current;
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
    }, []);

    const attachVideo = React.useCallback(
        (element: HTMLVideoElement | null) => {
            videoRef.current = element;
            onVideoElement?.(element);
        },
        [onVideoElement]
    );

    React.useEffect(() => () => fullReset(), [fullReset]);

    const fail = React.useCallback((message: string) => {
        setStatus('error');
        setError(message);
    }, []);

    const connect = React.useCallback(() => {
        if (!roomID || !token) {
            return;
        }
        fullReset();
        const generation = ++generationRef.current;
        setStatus('connecting');
        setError('');

        const settings = loadSettings();
        // The extra latency budget of live mode: buffered seconds on the
        // viewer side. Larger = steadier picture on jittery WAN links.
        const targetDelay = settings.liveBufferSeconds > 0 ? settings.liveBufferSeconds : 2.5;

        const socket = new WebSocket(liveWsURL(roomID, 'viewer', token));
        socket.binaryType = 'arraybuffer';
        socketRef.current = socket;

        let mediaSource: MediaSource | undefined;
        let objectURL = '';
        let info: LiveInfo | undefined;
        let initReceived = false;
        // Stats sampling state (per connection).
        let bytesReceived = 0;
        let lastSampleAt = 0;
        let lastFrames = 0;
        let lastDropped = 0;
        let lastBytes = 0;

        const pump = () => {
            const sourceBuffer = sourceBufferRef.current;
            if (!sourceBuffer || sourceBuffer.updating || queueRef.current.length === 0) {
                return;
            }
            const chunk = queueRef.current.shift()!;
            try {
                sourceBuffer.appendBuffer(chunk);
            } catch (e) {
                console.error('appendBuffer failed', e);
                fail('播放缓冲异常，正在重连…');
            }
        };

        const chase = () => {
            const video = videoRef.current;
            const sourceBuffer = sourceBufferRef.current;
            if (!video || !sourceBuffer) {
                return;
            }
            const buffered = video.buffered;
            if (buffered.length === 0) {
                return;
            }
            const end = buffered.end(buffered.length - 1);
            const behind = end - video.currentTime;
            setLatency(Math.max(0, behind));
            if (!startedRef.current && behind >= targetDelay) {
                startedRef.current = true;
                // Start at the buffer target: drop the join replay backlog so
                // the latency equals what was configured instead of the whole
                // rewind length.
                const startAt = end - targetDelay;
                if (startAt > 0 && buffered.start(0) <= startAt) {
                    video.currentTime = startAt;
                }
                video.play().catch(() => {
                    // autoplay rejected: try muted, sound stays toggleable
                    video.muted = true;
                    video.play().catch(() => undefined);
                });
                setStatus('playing');
            }
            if (startedRef.current) {
                const drift = behind - targetDelay;
                if (drift > 3) {
                    // Large drift: hard seek back to the live edge.
                    video.currentTime = end - targetDelay;
                    video.playbackRate = 1;
                } else if (drift > 1.2) {
                    // Real accumulated lag: catch up by playing slightly faster.
                    if (video.playbackRate !== 1.05) {
                        video.playbackRate = 1.05;
                    }
                } else if (drift < 0.4 && video.playbackRate !== 1) {
                    // Hysteresis: fragments arrive in ~1s bursts, so the buffer
                    // naturally oscillates by ±0.5s around the target. A narrow
                    // on/off band at 0.4s made the rate flip to 1.05x roughly
                    // once a second — a visible micro-hitch that no amount of
                    // bitrate could smooth out.
                    video.playbackRate = 1;
                }
            }
            // Buffer drained to the playback edge: the arrival rate is below
            // the stream bitrate. Surface it instead of silently freezing.
            const starved = startedRef.current && behind < 1.0;
            setStarved(starved);
            if (starved) {
                starveCountRef.current += 1;
                if (starveCountRef.current % 10 === 1) {
                    console.warn(
                        '[live] starving: buffered',
                        behind.toFixed(2),
                        's — arrival rate below stream bitrate'
                    );
                }
            }
            if (startedRef.current && buffered.start(0) < video.currentTime - 30) {
                try {
                    sourceBuffer.remove(buffered.start(0), video.currentTime - 20);
                } catch {
                    // removal is best effort
                }
            }
        };

        const setupMSE = (liveInfo: LiveInfo) => {
            const video = videoRef.current;
            if (!video) {
                return;
            }
            if (
                typeof MediaSource === 'undefined' ||
                !MediaSource.isTypeSupported(liveInfo.mimeType)
            ) {
                fail(
                    `你的浏览器不支持该编码（${liveInfo.videoCodec}）。请使用较新的 Chrome/Edge，或让主播选择 H.264 编码。`
                );
                return;
            }
            mediaSource = new MediaSource();
            objectURL = URL.createObjectURL(mediaSource);
            video.src = objectURL;
            mediaSource.addEventListener(
                'sourceopen',
                () => {
                    if (generationRef.current !== generation) {
                        return;
                    }
                    try {
                        const sourceBuffer = mediaSource!.addSourceBuffer(liveInfo.mimeType);
                        sourceBuffer.mode = 'segments';
                        sourceBuffer.addEventListener('updateend', pump);
                        sourceBuffer.addEventListener('error', () =>
                            fail('解码数据异常，正在重连…')
                        );
                        sourceBufferRef.current = sourceBuffer;
                        pump();
                    } catch (e) {
                        fail(`无法初始化播放器：${e}`);
                    }
                },
                {once: true}
            );
            try {
                mediaSource.duration = Infinity;
            } catch {
                // some browsers reject Infinity; duration grows with appends
            }
            setStatus('buffering');
        };

        socket.onmessage = (event) => {
            if (generationRef.current !== generation) {
                return;
            }
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'info') {
                        attemptsRef.current = 0;
                        info = msg as LiveInfo;
                        setupMSE(info);
                    }
                } catch {
                    // ignore malformed control messages
                }
                return;
            }
            if (!info) {
                return; // segments before info cannot be appended
            }
            // The relay tags binary messages: 0x00 = fMP4 init segment
            // (ftyp+moov), 0x01 = media fragment. The tag byte is stripped
            // before the payload reaches the SourceBuffer.
            const bytes = new Uint8Array(event.data as ArrayBuffer);
            if (bytes.byteLength < 1) {
                return;
            }
            bytesReceived += bytes.byteLength;
            const tag = bytes[0];
            const payload = new Uint8Array(bytes.byteLength - 1);
            payload.set(bytes.subarray(1), 0);
            if (tag === 0) {
                if (initReceived) {
                    // A second init segment means the host restarted the
                    // stream: rebuild the pipeline instead of appending it
                    // mid-stream (which would break the decoder).
                    console.warn('[live] new init segment — stream restarted, reconnecting');
                    connect();
                    return;
                }
                initReceived = true;
            }
            queueRef.current.push(payload);
            pump();
        };

        socket.onclose = (event) => {
            if (generationRef.current !== generation) {
                return;
            }
            if (event.reason === '直播已结束') {
                fail('直播已结束');
                return;
            }
            // Kicks ("带宽不足"), not-yet-started lives and network errors are
            // retryable; surface the server's reason and back off.
            attemptsRef.current += 1;
            if (attemptsRef.current > 8) {
                fail(`多次连接失败（${event.reason || '网络异常'}）。`);
                return;
            }
            setStatus('connecting');
            reconnectTimer.current = window.setTimeout(() => {
                if (generationRef.current === generation) {
                    connect();
                }
            }, 3000);
        };

        socket.onerror = () => {
            if (generationRef.current === generation) {
                setStatus('connecting');
            }
        };

        const interval = window.setInterval(() => {
            if (generationRef.current !== generation) {
                clearInterval(interval);
                return;
            }
            chase();
            const video = videoRef.current;
            const quality = video?.getVideoPlaybackQuality?.();
            const now = performance.now();
            if (quality) {
                if (lastSampleAt > 0) {
                    const dt = (now - lastSampleAt) / 1000;
                    if (dt > 0.2) {
                        setStats({
                            fps: (quality.totalVideoFrames - lastFrames) / dt,
                            dropped: (quality.droppedVideoFrames - lastDropped) / dt,
                            mbps: ((bytesReceived - lastBytes) * 8) / 1e6 / dt,
                            hostFps: info?.fps ?? 0,
                        });
                        lastFrames = quality.totalVideoFrames;
                        lastDropped = quality.droppedVideoFrames;
                        lastBytes = bytesReceived;
                        lastSampleAt = now;
                    }
                } else {
                    lastFrames = quality.totalVideoFrames;
                    lastDropped = quality.droppedVideoFrames;
                    lastBytes = bytesReceived;
                    lastSampleAt = now;
                }
            }
            if (objectURL && videoRef.current && videoRef.current.readyState >= 3) {
                URL.revokeObjectURL(objectURL);
                objectURL = '';
            }
        }, 1000);
    }, [fail, fullReset, roomID, token]);

    React.useEffect(() => {
        connect();
        return () => {
            if (reconnectTimer.current) {
                clearTimeout(reconnectTimer.current);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roomID, token]);

    const toggleFullscreen = () => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => undefined);
        } else {
            video.requestFullscreen().catch(() => undefined);
        }
    };

    return (
        <Box style={{position: 'absolute', inset: 0, background: '#000'}}>
            <video
                ref={attachVideo}
                playsInline
                onDoubleClick={toggleFullscreen}
                style={{
                    width: '100%',
                    height: '100%',
                    display: status === 'playing' ? 'block' : 'none',
                }}
            />
            {status !== 'playing' && (
                <Typography
                    variant="h5"
                    align="center"
                    style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        color: '#fff',
                    }}
                >
                    {status === 'connecting' && '正在连接直播…'}
                    {status === 'buffering' && '正在缓冲…'}
                    {status === 'error' && error}
                </Typography>
            )}
            {status === 'playing' && (
                <Typography
                    variant="body2"
                    style={{
                        position: 'absolute',
                        left: 12,
                        bottom: 12,
                        color: '#9e9e9e',
                        background: 'rgba(0,0,0,.5)',
                        padding: '2px 8px',
                    }}
                >
                    直播中 ｜ 延迟约 {latency.toFixed(1)} 秒 ｜ 解码 {stats.fps.toFixed(0)}fps
                    {stats.hostFps > 0 ? `（主播 ${stats.hostFps}fps）` : ''} ｜ 丢帧{' '}
                    {stats.dropped.toFixed(1)}/s ｜ {stats.mbps.toFixed(1)} Mbps
                </Typography>
            )}
            {starved && (
                <Typography
                    variant="body2"
                    align="center"
                    style={{
                        position: 'absolute',
                        top: '18%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        color: '#ffb74d',
                        background: 'rgba(0,0,0,.6)',
                        padding: '4px 12px',
                    }}
                >
                    网络跟不上直播码率，正在缓冲…（请主播降低直播码率或帧率）
                </Typography>
            )}
        </Box>
    );
};
