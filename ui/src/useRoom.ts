import {useSnackbar} from 'notistack';
import React from 'react';

import {
    ICEServer,
    IncomingMessage,
    JoinRoom,
    OutgoingMessage,
    RoomCreate,
    RoomInfo,
    UIConfig,
} from './message';
import {
    buildPreferredCodecs,
    loadSettings,
    resolveCodecPlaceholder,
    resolveLiveFramerate,
    resolveRoomFramerate,
} from './settings';
import {LivePushStats, startLivePush} from './live/encoder';
import {urlWithSlash} from './url';
import {authModeToRoomMode} from './useConfig';
import {getFromURL, useRoomID} from './useRoomID';

export type RoomState = false | ConnectedRoom;
export type ConnectedRoom = {
    ws: WebSocket;
    hostStream?: MediaStream;
    clientStreams: ClientStream[];
    /** True when one of our own outgoing sessions relays via the server. */
    relayed?: boolean;
} & RoomInfo;

interface ClientStream {
    id: string;
    peer_id: string;
    stream: MediaStream;
    relayed?: boolean;
}

// Detects whether the selected ICE path relays through the server (TURN) or
// connects the peers directly. Relay matters a lot on weak servers: the whole
// stream then flows through the server's bandwidth.
const detectRelayed = async (peer: RTCPeerConnection): Promise<boolean | undefined> => {
    try {
        const stats = await peer.getStats();
        const reports = new Map<string, any>();
        stats.forEach((report: any) => reports.set(report.id, report));
        let pair: any;
        reports.forEach((report) => {
            if (report.type === 'transport' && report.selectedCandidatePairId) {
                pair = reports.get(report.selectedCandidatePairId);
            }
        });
        if (!pair) {
            reports.forEach((report) => {
                if (
                    report.type === 'candidate-pair' &&
                    report.nominated &&
                    report.state === 'succeeded'
                ) {
                    pair = report;
                }
            });
        }
        if (!pair) {
            return undefined;
        }
        const local = pair.localCandidateId ? reports.get(pair.localCandidateId) : undefined;
        const remote = pair.remoteCandidateId ? reports.get(pair.remoteCandidateId) : undefined;
        return local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    } catch {
        return undefined;
    }
};

export interface UseRoom {
    state: RoomState;
    room: FCreateRoom;
    share: (mode?: 'realtime' | 'live') => Promise<void>;
    setName: (name: string) => void;
    stopShare: () => void;
    /** True while an unexpected disconnect is being retried. */
    reconnecting: boolean;
    /** Live push statistics while this client is sharing in live mode. */
    liveStats?: LivePushStats;
}

const relayConfig: Partial<RTCConfiguration> =
    window.location.search.indexOf('forceTurn=true') !== -1 ? {iceTransportPolicy: 'relay'} : {};

// Logs the codec actually negotiated for the video track. When a viewer cannot
// see a realtime picture this is the first thing to check: a codec can be
// advertised by both browsers and still produce no frames.
const logNegotiatedCodec = async (peer: RTCPeerConnection, role: string): Promise<void> => {
    try {
        const stats = await peer.getStats();
        const codecs = new Map<string, string>();
        stats.forEach((report: any) => {
            if (report.type === 'codec' && typeof report.mimeType === 'string') {
                codecs.set(report.id, report.mimeType);
            }
        });
        stats.forEach((report: any) => {
            if (report.type !== 'outbound-rtp' && report.type !== 'inbound-rtp') {
                return;
            }
            if ((report.kind ?? report.mediaType) !== 'video') {
                return;
            }
            const mime = report.codecId ? codecs.get(report.codecId) : undefined;
            if (mime) {
                console.log(`[realtime] ${role} video codec: ${mime}`);
            }
        });
    } catch (e) {
        console.warn('[realtime] could not read codec stats', e);
    }
};

const hostSession = async ({
    sid,
    ice,
    send,
    done,
    onRelayed,
    onFailed,
    stream,
}: {
    sid: string;
    ice: ICEServer[];
    send: (e: OutgoingMessage) => void;
    done: () => void;
    onRelayed: (relayed: boolean) => void;
    onFailed?: (message: string) => void;
    stream: MediaStream;
}): Promise<RTCPeerConnection> => {
    const peer = new RTCPeerConnection({...relayConfig, iceServers: ice});
    peer.onicecandidate = (event) => {
        if (!event.candidate) {
            return;
        }
        send({type: 'hostice', payload: {sid: sid, value: event.candidate}});
    };

    peer.onconnectionstatechange = (event) => {
        console.log('host change', event);
        if (peer.connectionState === 'connected') {
            void logNegotiatedCodec(peer, 'host');
            const check = (delay: number) =>
                setTimeout(() => {
                    detectRelayed(peer).then((relayed) => {
                        if (relayed !== undefined) {
                            onRelayed(relayed);
                            if (relayed) {
                                console.warn('session', sid, 'relays through the server');
                            }
                        }
                    });
                }, delay);
            check(1500);
            check(8000);
        }
        if (peer.connectionState === 'failed') {
            console.warn('[realtime] host ICE failed for session', sid);
            onFailed?.('与观众建立实时连接失败（直连和服务器中继都未能连通）');
        }
        if (
            peer.connectionState === 'closed' ||
            peer.connectionState === 'disconnected' ||
            peer.connectionState === 'failed'
        ) {
            peer.close();
            done();
        }
    };

    stream.getTracks().forEach((track) => peer.addTrack(track, stream));

    const settings = loadSettings();

    const videoSender = peer.getSenders().find((s) => s.track?.kind === 'video');
    if (videoSender) {
        const params = videoSender.getParameters();
        if (settings.bitrateMbps > 0) {
            // Chrome caps the send bitrate far below what a LAN can carry.
            // Without raising it, a high framerate just forces low resolution.
            params.encodings = params.encodings?.length ? params.encodings : [{}];
            params.encodings[0].maxBitrate = settings.bitrateMbps * 1_000_000;
        }
        // Realtime mode pursues clarity like upstream screego: keep the
        // resolution sharp and drop frames when bandwidth is tight. (Smoothness
        // priority is the live share's job, which has its own pipeline.)
        params.degradationPreference = 'maintain-resolution';
        try {
            await videoSender.setParameters(params);
        } catch (e) {
            console.warn('Could not apply sender quality parameters', e);
        }
    }

    const preferCodec = resolveCodecPlaceholder(settings.preferCodec);
    if (preferCodec) {
        const transceiver = peer
            .getTransceivers()
            .find((t) => t.sender && t.sender.track === stream.getVideoTracks()[0]);

        if (!!transceiver && 'setCodecPreferences' in transceiver) {
            // Sender capabilities are what this browser can encode; the
            // viewing side still picks what it can decode in its answer, so
            // unsupported preferences fall back instead of breaking.
            const capabilities =
                ('getCapabilities' in RTCRtpSender
                    ? RTCRtpSender.getCapabilities('video')?.codecs
                    : undefined) ??
                RTCRtpReceiver.getCapabilities('video')?.codecs ??
                [];
            const sortedCodecs = buildPreferredCodecs(capabilities, preferCodec) ?? capabilities;

            if (sortedCodecs.length > 0) {
                try {
                    console.log('Setting codec preferences', sortedCodecs);
                    transceiver.setCodecPreferences(sortedCodecs);
                } catch (e) {
                    console.warn('Could not set codec preferences', e);
                }
            }
        }
    }

    const hostOffer = await peer.createOffer({offerToReceiveVideo: true});
    await peer.setLocalDescription(hostOffer);
    send({type: 'hostoffer', payload: {value: hostOffer, sid: sid}});

    return peer;
};

const clientSession = async ({
    sid,
    ice,
    send,
    done,
    onRelayed,
    onTrack,
    onFailed,
}: {
    sid: string;
    ice: ICEServer[];
    send: (e: OutgoingMessage) => void;
    done: () => void;
    onRelayed: (relayed: boolean) => void;
    onTrack: (s: MediaStream) => void;
    onFailed?: (message: string) => void;
}): Promise<RTCPeerConnection> => {
    console.log('ice', ice);
    const peer = new RTCPeerConnection({...relayConfig, iceServers: ice});
    peer.onicecandidate = (event) => {
        if (!event.candidate) {
            return;
        }
        send({type: 'clientice', payload: {sid: sid, value: event.candidate}});
    };
    peer.onconnectionstatechange = (event) => {
        console.log('client change', event);
        if (peer.connectionState === 'connected') {
            void logNegotiatedCodec(peer, 'viewer');
            const check = (delay: number) =>
                setTimeout(() => {
                    detectRelayed(peer).then((relayed) => {
                        if (relayed !== undefined) {
                            onRelayed(relayed);
                        }
                    });
                }, delay);
            check(1500);
            check(8000);
        }
        if (peer.connectionState === 'failed') {
            console.warn('[realtime] viewer ICE failed for session', sid, ice);
            onFailed?.('无法建立实时连接（直连和服务器中继都未能连通）');
        }
        if (
            peer.connectionState === 'closed' ||
            peer.connectionState === 'disconnected' ||
            peer.connectionState === 'failed'
        ) {
            peer.close();
            done();
        }
    };

    let notified = false;
    const stream = new MediaStream();
    peer.ontrack = (event) => {
        stream.addTrack(event.track);
        if (!notified) {
            notified = true;
            onTrack(stream);
        }
    };

    return peer;
};

export type FCreateRoom = (room: RoomCreate | JoinRoom) => Promise<void>;

export const useRoom = (config: UIConfig): UseRoom => {
    const [roomID, setRoomID] = useRoomID();
    const {enqueueSnackbar} = useSnackbar();
    const conn = React.useRef<WebSocket | undefined>(undefined);
    const host = React.useRef<Record<string, RTCPeerConnection>>({});
    const client = React.useRef<Record<string, RTCPeerConnection>>({});
    const stream = React.useRef<MediaStream>(undefined);
    const liveStartRef = React.useRef<((session: {id: string; token: string}) => void) | undefined>(
        undefined
    );
    const livePushRef = React.useRef<{stop: () => void} | undefined>(undefined);
    const overshootWarnedRef = React.useRef(false);

    const [state, setState] = React.useState<RoomState>(false);
    // Kept true while an unexpected drop is being retried, so the room UI can
    // stay on screen instead of silently going stale.
    const [reconnecting, setReconnecting] = React.useState(false);
    const [liveStats, setLiveStats] = React.useState<LivePushStats | undefined>(undefined);
    const disposeRef = React.useRef<(() => void) | undefined>(undefined);

    React.useEffect(
        () => () => {
            disposeRef.current?.();
        },
        []
    );

    const room: FCreateRoom = React.useCallback(
        (create) => {
            return new Promise<void>((resolve) => {
                let attempt = 0;
                let settled = false;
                let disposed = false;
                let connectedOnce = false;

                const settle = () => {
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                };

                disposeRef.current = () => {
                    disposed = true;
                    conn.current?.close();
                };

                const connect = () => {
                    if (disposed) {
                        return;
                    }
                    const ws = (conn.current = new WebSocket(
                        urlWithSlash.replace('http', 'ws') + 'stream'
                    ));
                    const send = (message: OutgoingMessage) => {
                        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
                    };
                    let first = true;
                    ws.onmessage = (data) => {
                        const event: IncomingMessage = JSON.parse(data.data);
                        if (first) {
                            first = false;
                            if (event.type === 'room') {
                                settle();
                                setState({ws, ...event.payload, clientStreams: []});
                                setRoomID(event.payload.id);
                            } else {
                                settle();
                                enqueueSnackbar('未知事件：' + event.type, {variant: 'error'});
                                ws.close(1000, 'received unknown event');
                            }
                            return;
                        }

                    switch (event.type) {
                        case 'room':
                            setState((current) =>
                                current
                                    ? {
                                          ...current,
                                          ...event.payload,
                                          // Live shares are only announced while
                                          // one runs (json omitempty), so a
                                          // missing field means the share
                                          // ended: drop the stale player state.
                                          live: Object.prototype.hasOwnProperty.call(
                                              event.payload,
                                              'live'
                                          )
                                              ? event.payload.live
                                              : undefined,
                                      }
                                    : current
                            );
                            return;
                        case 'hostsession':
                            if (!stream.current) {
                                return;
                            }
                            hostSession({
                                sid: event.payload.id,
                                stream: stream.current!,
                                ice: event.payload.iceServers,
                                send,
                                done: () => delete host.current[event.payload.id],
                                onRelayed: (relayed) =>
                                    setState((current) =>
                                        current
                                            ? {...current, relayed: current.relayed || relayed}
                                            : current
                                    ),
                                onFailed: (message) =>
                                    enqueueSnackbar(message, {variant: 'error'}),
                            }).then((peer) => {
                                host.current[event.payload.id] = peer;
                            });
                            return;
                        case 'livehostsession':
                            liveStartRef.current?.(event.payload);
                            return;
                        case 'clientsession':
                            const {id: sid, peer} = event.payload;
                            clientSession({
                                sid,
                                send,
                                ice: event.payload.iceServers,
                                done: () => {
                                    delete client.current[sid];
                                    setState((current) =>
                                        current
                                            ? {
                                                  ...current,
                                                  clientStreams: current.clientStreams.filter(
                                                      ({id}) => id !== sid
                                                  ),
                                              }
                                            : current
                                    );
                                },
                                onRelayed: (relayed) =>
                                    setState((current) =>
                                        current
                                            ? {
                                                  ...current,
                                                  clientStreams: current.clientStreams.map((s) =>
                                                      s.id === sid ? {...s, relayed} : s
                                                  ),
                                              }
                                            : current
                                    ),
                                onTrack: (stream) =>
                                    setState((current) =>
                                        current
                                            ? {
                                                  ...current,
                                                  clientStreams: [
                                                      ...current.clientStreams,
                                                      {
                                                          id: sid,
                                                          stream,
                                                          peer_id: peer,
                                                      },
                                                  ],
                                              }
                                            : current
                                    ),
                                onFailed: (message) =>
                                    enqueueSnackbar(message, {variant: 'error'}),
                            }).then((peer) => (client.current[event.payload.id] = peer));
                            return;
                        case 'clientice':
                            host.current[event.payload.sid]?.addIceCandidate(event.payload.value);
                            return;
                        case 'clientanswer':
                            host.current[event.payload.sid]?.setRemoteDescription(
                                event.payload.value
                            );
                            return;
                        case 'hostoffer':
                            (async () => {
                                await client.current[event.payload.sid]?.setRemoteDescription(
                                    event.payload.value
                                );
                                const answer =
                                    await client.current[event.payload.sid]?.createAnswer();
                                await client.current[event.payload.sid]?.setLocalDescription(
                                    answer
                                );
                                send({
                                    type: 'clientanswer',
                                    payload: {sid: event.payload.sid, value: answer},
                                });
                            })();
                            return;
                        case 'hostice':
                            client.current[event.payload.sid]?.addIceCandidate(event.payload.value);
                            return;
                        case 'endshare':
                            client.current[event.payload]?.close();
                            host.current[event.payload]?.close();
                            setState((current) =>
                                current
                                    ? {
                                          ...current,
                                          clientStreams: current.clientStreams.filter(
                                              ({id}) => id !== event.payload
                                          ),
                                      }
                                    : current
                            );
                    }
                };
                ws.onclose = (event) => {
                    settle();
                    if (disposed) {
                        return;
                    }
                    // A normal close that carries a reason is a server-side
                    // rejection (room closed, login required, ...): retrying
                    // would just loop forever.
                    if (event.code === 1000 && event.reason) {
                        enqueueSnackbar(event.reason, {variant: 'error', persist: true});
                        setState(false);
                        return;
                    }
                    attempt += 1;
                    const backoff = Math.min(10000, 500 * 2 ** (attempt - 1));
                    console.warn(
                        `[room] connection lost (code ${event.code}), reconnect attempt ${attempt} in ${backoff}ms`
                    );
                    if (!connectedOnce) {
                        enqueueSnackbar('连接服务器失败，正在重试…', {variant: 'warning'});
                    }
                    setReconnecting(true);
                    window.setTimeout(connect, backoff);
                };
                ws.onerror = () => {
                    // onclose always follows and owns the retry decision.
                };
                ws.onopen = () => {
                    const isRetry = connectedOnce;
                    connectedOnce = true;
                    attempt = 0;
                    setReconnecting(false);
                    if (isRetry) {
                        console.info('[room] reconnected');
                        enqueueSnackbar('已重新连接服务器', {variant: 'info'});
                    }
                    create.payload.username = loadSettings().name;
                    send(create);
                };
                };

                connect();
            });
        },
        [setState, enqueueSnackbar, setRoomID]
    );

    const share = async (mode: 'realtime' | 'live' = 'realtime') => {
        if (!navigator.mediaDevices) {
            enqueueSnackbar('无法开始共享：请通过 HTTPS 访问页面（mediaDevices 未定义）', {
                variant: 'error',
                persist: true,
            });
            return;
        }
        if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
            enqueueSnackbar(
                `无法开始共享：你的浏览器可能不支持屏幕共享（getDisplayMedia: ${typeof navigator.mediaDevices.getDisplayMedia}）`,
                {variant: 'error', persist: true}
            );
            return;
        }
        // One decision per share session: capture and encoder must agree on
        // the framerate. Auto resolves live to 60fps when the effective live
        // bitrate allows it; realtime auto stays at 30 (clarity).
        const shareSettings = loadSettings();
        const captureFramerate =
            mode === 'live'
                ? resolveLiveFramerate(
                      shareSettings.framerate,
                      shareSettings.liveBitrateAuto
                          ? config.liveBandwidthMbps || 4
                          : shareSettings.liveBitrateMbps
                  )
                : resolveRoomFramerate(shareSettings.framerate);
        try {
            stream.current = await navigator.mediaDevices.getDisplayMedia({
                video: {frameRate: captureFramerate},
                audio: {
                    echoCancellation: false,
                    autoGainControl: false,
                    noiseSuppression: false,
                    // https://medium.com/@trystonperry/why-is-getdisplaymedias-audio-quality-so-bad-b49ba9cfaa83
                    // @ts-expect-error
                    googAutoGainControl: false,
                },
            });
        } catch (e) {
            console.log('Could not getDisplayMedia', e);
            enqueueSnackbar(`无法开始共享（getDisplayMedia 出错）：${e}`, {
                variant: 'error',
                persist: true,
            });
            return;
        }

        stream.current?.getVideoTracks()[0].addEventListener('ended', () => stopShare());
        setState((current) => (current ? {...current, hostStream: stream.current} : current));

        if (mode === 'live') {
            // The push starts once the server acknowledges the live share and
            // hands out the one-time push token.
            const captured = stream.current!;
            return new Promise<void>((resolve) => {
                liveStartRef.current = ({id, token}) => {
                    liveStartRef.current = undefined;
                    const s = loadSettings();
                    const liveBitrateMbps = s.liveBitrateAuto
                        ? config.liveBandwidthMbps || 4
                        : s.liveBitrateMbps;
                    overshootWarnedRef.current = false;
                    startLivePush(
                        captured,
                        {id, token},
                        {
                            liveBitrateMbps,
                            framerate: captureFramerate,
                            onFail: (message) =>
                                enqueueSnackbar(`直播推流失败：${message}`, {
                                    variant: 'error',
                                    persist: true,
                                }),
                            onStats: (stats) => {
                                setLiveStats(stats);
                                console.log('live push', stats);
                                if (
                                    stats.mbps > stats.targetMbps * 1.3 &&
                                    !overshootWarnedRef.current
                                ) {
                                    overshootWarnedRef.current = true;
                                    enqueueSnackbar(
                                        `实测推流码率 ${stats.mbps.toFixed(
                                            1
                                        )} Mbps 高于目标 ${stats.targetMbps} Mbps，已尝试自动下调。若观众仍卡顿，请降低直播码率或帧率。`,
                                        {variant: 'warning', persist: true}
                                    );
                                }
                            },
                            onBitrateAdjusted: (targetMbps) =>
                                enqueueSnackbar(
                                    `已自动把直播码率下调到 ${targetMbps} Mbps 以适配服务器带宽。`,
                                    {variant: 'info'}
                                ),
                            onFpsAdjusted: (fps) =>
                                enqueueSnackbar(
                                    `编码器跟不上 ${captureFramerate}fps，已自动降到 ${fps}fps 保证流畅。`,
                                    {variant: 'warning'}
                                ),
                        }
                    )
                        .then((push) => {
                            livePushRef.current = push;
                        })
                        .catch((e) =>
                            enqueueSnackbar(`直播启动失败：${e}`, {
                                variant: 'error',
                                persist: true,
                            })
                        );
                    resolve();
                };
                conn.current?.send(JSON.stringify({type: 'share', payload: {mode: 'live'}}));
            });
        }

        conn.current?.send(JSON.stringify({type: 'share', payload: {}}));
    };

    const stopShare = () => {
        livePushRef.current?.stop();
        livePushRef.current = undefined;
        setLiveStats(undefined);
        Object.values(host.current).forEach((peer) => {
            peer.close();
        });
        host.current = {};
        stream.current?.getTracks().forEach((track) => track.stop());
        stream.current = undefined;
        conn.current?.send(JSON.stringify({type: 'stopshare', payload: {}}));
        setState((current) => (current ? {...current, hostStream: undefined} : current));
    };

    const setName = (name: string): void => {
        conn.current?.send(JSON.stringify({type: 'name', payload: {username: name}}));
    };

    React.useEffect(() => {
        if (roomID) {
            const create = getFromURL('create') === 'true';
            if (create) {
                const closeOnOwnerLeaveString = getFromURL('closeOnOwnerLeave');
                const closeOnOwnerLeave =
                    closeOnOwnerLeaveString === undefined
                        ? config.closeRoomWhenOwnerLeaves
                        : closeOnOwnerLeaveString === 'true';
                room({
                    type: 'create',
                    payload: {
                        joinIfExist: true,
                        closeOnOwnerLeave,
                        id: roomID,
                        mode: authModeToRoomMode(config.authMode, config.loggedIn),
                    },
                });
            } else {
                room({type: 'join', payload: {id: roomID}});
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {state, room, share, stopShare, setName, reconnecting, liveStats};
};
