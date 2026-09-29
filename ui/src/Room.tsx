import React, {useCallback} from 'react';
import {
    Badge,
    Box,
    Button,
    Dialog,
    DialogTitle,
    DialogContent,
    IconButton,
    Paper,
    Tooltip,
    Typography,
    Slider,
    Stack,
} from '@mui/material';
import CancelPresentationIcon from '@mui/icons-material/CancelPresentation';
import PresentToAllIcon from '@mui/icons-material/PresentToAll';
import FullScreenIcon from '@mui/icons-material/Fullscreen';
import PeopleIcon from '@mui/icons-material/People';
import VolumeMuteIcon from '@mui/icons-material/VolumeOff';
import VolumeIcon from '@mui/icons-material/VolumeUp';
import SettingsIcon from '@mui/icons-material/Settings';
import {useHotkeys} from 'react-hotkeys-hook';
import {Video} from './Video';
import {makeStyles} from 'tss-react/mui';
import {ConnectedRoom} from './useRoom';
import {useSnackbar} from 'notistack';
import {RoomUser, UIConfig} from './message';
import {useSettings, VideoDisplayMode} from './settings';
import {SettingDialog} from './SettingDialog';
import {LivePlayer} from './live/player';
import {LivePushStats} from './live/encoder';

const HostStream: unique symbol = Symbol('mystream');

const flags = (user: RoomUser) => {
    const result: string[] = [];
    if (user.you) {
        result.push('我');
    }
    if (user.owner) {
        result.push('房主');
    }
    if (user.streaming) {
        result.push('正在共享');
    }
    if (!result.length) {
        return '';
    }
    return ` (${result.join(', ')})`;
};

interface FullScreenHTMLVideoElement extends HTMLVideoElement {
    msRequestFullscreen?: () => void;
    mozRequestFullScreen?: () => void;
    webkitRequestFullscreen?: () => void;
}

const requestFullscreen = (element: FullScreenHTMLVideoElement | null) => {
    if (element?.requestFullscreen) {
        element.requestFullscreen();
    } else if (element?.mozRequestFullScreen) {
        element.mozRequestFullScreen();
    } else if (element?.msRequestFullscreen) {
        element.msRequestFullscreen();
    } else if (element?.webkitRequestFullscreen) {
        element.webkitRequestFullscreen();
    }
};

export const Room = ({
    state,
    config,
    share,
    stopShare,
    setName,
    reconnecting,
    liveStats,
}: {
    state: ConnectedRoom;
    config: UIConfig;
    share: (mode?: 'realtime' | 'live') => Promise<void>;
    stopShare: () => void;
    setName: (name: string) => void;
    reconnecting?: boolean;
    liveStats?: LivePushStats;
}) => {
    const {classes} = useStyles();
    const [open, setOpen] = React.useState(false);
    const [shareDialog, setShareDialog] = React.useState(false);
    const {enqueueSnackbar} = useSnackbar();
    const [settings, setSettings] = useSettings();
    const [showControl, setShowControl] = React.useState(true);
    const [hoverControl, setHoverControl] = React.useState(false);
    const [selectedStream, setSelectedStream] = React.useState<string | typeof HostStream>();
    const [videoElement, setVideoElement] = React.useState<FullScreenHTMLVideoElement | null>(null);

    const startShare = (mode: 'realtime' | 'live') => {
        setShareDialog(false);
        share(mode).catch((e) =>
            enqueueSnackbar(`共享失败：${e}`, {variant: 'error', persist: true})
        );
    };

    // A live share owned by somebody else is rendered by LivePlayer, which has
    // no WebRTC stream and therefore no `selectedStream`.
    const liveActive = !!(state.live && !state.live.self);

    useShowOnMouseMovement(setShowControl);

    const handleFullscreen = useCallback(() => requestFullscreen(videoElement), [videoElement]);

    React.useEffect(() => {
        if (selectedStream === HostStream && state.hostStream) {
            return;
        }
        if (state.clientStreams.some(({id}) => id === selectedStream)) {
            return;
        }
        if (state.clientStreams.length === 0 && selectedStream) {
            setSelectedStream(undefined);
            return;
        }
        setSelectedStream(state.clientStreams[0]?.id);
    }, [state.clientStreams, selectedStream, state.hostStream]);

    const stream =
        selectedStream === HostStream
            ? state.hostStream
            : state.clientStreams.find(({id}) => selectedStream === id)?.stream;

    React.useEffect(() => {
        if (videoElement && stream) {
            videoElement.srcObject = stream;
            videoElement.play().catch((err) => {
                console.log('Could not play main video', err);
                if (err.name === 'NotAllowedError') {
                    videoElement.muted = true;
                    videoElement
                        .play()
                        .catch((retryErr) =>
                            console.log('Could not play main video with mute', retryErr)
                        );
                }
            });
        }
    }, [videoElement, stream]);

    const copyLink = () => {
        navigator?.clipboard?.writeText(window.location.href)?.then(
            () => enqueueSnackbar('链接已复制', {variant: 'success'}),
            (err) => enqueueSnackbar('复制失败 ' + err, {variant: 'error'})
        );
    };

    const setHoverState = React.useMemo(
        () => ({
            onMouseLeave: () => setHoverControl(false),
            onMouseEnter: () => setHoverControl(true),
        }),
        [setHoverControl]
    );

    const controlVisible = showControl || open || hoverControl;

    useHotkeys('s', () => (state.hostStream ? stopShare() : setShareDialog(true)), [
        state.hostStream,
    ]);
    useHotkeys(
        'f',
        () => {
            if (selectedStream || liveActive) {
                handleFullscreen();
            }
        },
        [handleFullscreen, selectedStream, liveActive]
    );
    useHotkeys('c', copyLink);
    useHotkeys(
        'h',
        () => {
            if (state.clientStreams !== undefined && state.clientStreams.length > 0) {
                const currentStreamIndex = state.clientStreams.findIndex(
                    ({id}) => id === selectedStream
                );
                const nextIndex =
                    currentStreamIndex === state.clientStreams.length - 1
                        ? 0
                        : currentStreamIndex + 1;
                setSelectedStream(state.clientStreams[nextIndex].id);
            }
        },
        [state.clientStreams, selectedStream]
    );
    useHotkeys(
        'l',
        () => {
            if (state.clientStreams !== undefined && state.clientStreams.length > 0) {
                const currentStreamIndex = state.clientStreams.findIndex(
                    ({id}) => id === selectedStream
                );
                const previousIndex =
                    currentStreamIndex === 0
                        ? state.clientStreams.length - 1
                        : currentStreamIndex - 1;
                setSelectedStream(state.clientStreams[previousIndex].id);
            }
        },
        [state.clientStreams, selectedStream]
    );
    useHotkeys(
        'm',
        () => {
            if (videoElement) {
                videoElement.muted = !videoElement.muted;
            }
        },
        [videoElement]
    );

    const videoClasses = () => {
        switch (settings.displayMode) {
            case VideoDisplayMode.FitToWindow:
                return `${classes.video} ${classes.videoWindowFit}`;
            case VideoDisplayMode.OriginalSize:
                return `${classes.video}`;
            case VideoDisplayMode.FitWidth:
                return `${classes.video} ${classes.videoWindowWidth}`;
            case VideoDisplayMode.FitHeight:
                return `${classes.video} ${classes.videoWindowHeight}`;
        }
    };

    // Surface whether the media path bypasses the server: relayed connections
    // are bounded by the server's bandwidth (often just a few Mbps).
    const selectedClientStream = state.clientStreams.find(({id}) => selectedStream === id);
    let connectionHint: string | undefined;
    let connectionHintRelayed = false;
    if (state.hostStream) {
        if (state.relayed !== undefined) {
            connectionHintRelayed = state.relayed;
            connectionHint = state.relayed
                ? '连接：经服务器中继（画质受服务器带宽限制）'
                : '连接：直连（不经过服务器）';
        }
    } else if (selectedClientStream?.relayed !== undefined) {
        connectionHintRelayed = selectedClientStream.relayed;
        connectionHint = selectedClientStream.relayed
            ? '连接：经服务器中继（画质受服务器带宽限制）'
            : '连接：直连（不经过服务器）';
    }

    return (
        <div className={classes.videoContainer}>
            {controlVisible && (
                <Paper className={classes.title} elevation={10} {...setHoverState}>
                    <Tooltip title="复制链接">
                        <Typography
                            variant="h4"
                            component="h4"
                            style={{cursor: 'pointer'}}
                            onClick={copyLink}
                        >
                            {state.id}
                        </Typography>
                    </Tooltip>
                    {connectionHint && (
                        <Typography
                            variant="body2"
                            style={{color: connectionHintRelayed ? '#ffb74d' : '#9e9e9e'}}
                        >
                            {connectionHint}
                        </Typography>
                    )}
                </Paper>
            )}

            {state.hostStream && liveStats && (
                <Typography
                    variant="body2"
                    style={{
                        position: 'absolute',
                        top: 12,
                        right: 12,
                        color: '#9e9e9e',
                        background: 'rgba(0,0,0,.55)',
                        padding: '2px 8px',
                        fontFamily: 'monospace',
                        fontSize: 12,
                        zIndex: 20,
                    }}
                >
                    推流：采集 {liveStats.capturedFps}fps → 编码 {liveStats.fps}fps ｜{' '}
                    {liveStats.mbps.toFixed(1)} Mbps ｜ 队列 {liveStats.queue} ｜ 丢帧{' '}
                    {liveStats.droppedFps}/s
                </Typography>
            )}

            {reconnecting && (
                <Paper
                    elevation={10}
                    style={{
                        position: 'absolute',
                        top: 12,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        padding: '6px 14px',
                        backgroundColor: '#ff9800',
                        zIndex: 20,
                    }}
                >
                    <Typography variant="body2" style={{color: '#000'}}>
                        与服务器的连接已断开，正在重连…
                    </Typography>
                </Paper>
            )}

            {stream ? (
                <video
                    ref={setVideoElement}
                    className={videoClasses()}
                    onDoubleClick={handleFullscreen}
                />
            ) : state.live && !state.live.self ? (
                <LivePlayer
                    roomID={state.id}
                    token={state.live.viewerToken}
                    onVideoElement={setVideoElement}
                />
            ) : (
                <Typography
                    variant="h4"
                    align="center"
                    component="div"
                    style={{
                        top: '50%',
                        left: '50%',
                        position: 'absolute',
                        transform: 'translate(-50%, -50%)',
                    }}
                >
                    {reconnecting
                        ? '与服务器的连接已断开，正在重连…'
                        : '暂无可观看的画面（等待主播开始共享）'}
                </Typography>
            )}

            {controlVisible && (
                <Paper className={classes.control} elevation={10} {...setHoverState}>
                    {(stream?.getAudioTracks().length ?? 0) > 0 && videoElement && (
                        <AudioControl video={videoElement} />
                    )}
                    <Box whiteSpace="nowrap">
                        {state.hostStream ? (
                            <Tooltip title="停止共享" arrow>
                                <IconButton onClick={stopShare} size="large">
                                    <CancelPresentationIcon fontSize="large" />
                                </IconButton>
                            </Tooltip>
                        ) : (
                            <Tooltip title="开始共享" arrow>
                                <IconButton onClick={() => setShareDialog(true)} size="large">
                                    <PresentToAllIcon fontSize="large" />
                                </IconButton>
                            </Tooltip>
                        )}

                        <Tooltip
                            classes={{tooltip: classes.noMaxWidth}}
                            title={
                                <div>
                                    <Typography variant="h5">成员列表</Typography>
                                    {state.users.map((user) => (
                                        <Typography key={user.id}>
                                            {user.name} {flags(user)}
                                        </Typography>
                                    ))}
                                </div>
                            }
                            arrow
                        >
                            <Badge badgeContent={state.users.length} color="primary">
                                <PeopleIcon fontSize="large" />
                            </Badge>
                        </Tooltip>
                        <Tooltip title="全屏" arrow>
                            <IconButton
                                onClick={() => handleFullscreen()}
                                disabled={!selectedStream && !liveActive}
                                size="large"
                            >
                                <FullScreenIcon fontSize="large" />
                            </IconButton>
                        </Tooltip>

                        <Tooltip title="设置" arrow>
                            <IconButton onClick={() => setOpen(true)} size="large">
                                <SettingsIcon fontSize="large" />
                            </IconButton>
                        </Tooltip>
                    </Box>
                </Paper>
            )}

            <div className={classes.bottomContainer}>
                {state.clientStreams
                    .filter(({id}) => id !== selectedStream)
                    .map((client) => {
                        return (
                            <Paper
                                key={client.id}
                                elevation={4}
                                className={classes.smallVideoContainer}
                                onClick={() => setSelectedStream(client.id)}
                            >
                                <Video
                                    key={client.id}
                                    src={client.stream}
                                    className={classes.smallVideo}
                                />
                                <Typography
                                    variant="subtitle1"
                                    component="div"
                                    align="center"
                                    className={classes.smallVideoLabel}
                                >
                                    {state.users.find(({id}) => client.peer_id === id)?.name ??
                                        '未知用户'}
                                </Typography>
                            </Paper>
                        );
                    })}
                {state.hostStream && selectedStream !== HostStream && (
                    <Paper
                        elevation={4}
                        className={classes.smallVideoContainer}
                        onClick={() => setSelectedStream(HostStream)}
                    >
                        <Video src={state.hostStream} className={classes.smallVideo} />
                        <Typography
                            variant="subtitle1"
                            component="div"
                            align="center"
                            className={classes.smallVideoLabel}
                        >
                            我
                        </Typography>
                    </Paper>
                )}
                <SettingDialog
                    open={open}
                    setOpen={setOpen}
                    updateName={setName}
                    saveSettings={setSettings}
                    serverLiveBandwidthMbps={config.liveBandwidthMbps || 4}
                />
                <Dialog
                    open={shareDialog}
                    onClose={() => setShareDialog(false)}
                    maxWidth="xs"
                    fullWidth
                >
                    <DialogTitle>选择共享方式</DialogTitle>
                    <DialogContent>
                        <Button
                            fullWidth
                            variant="contained"
                            color="primary"
                            style={{marginBottom: 8}}
                            onClick={() => startShare('live')}
                        >
                            直播共享（推荐）：延迟约 3-5 秒，更流畅清晰
                        </Button>
                        <Button fullWidth variant="outlined" onClick={() => startShare('realtime')}>
                            实时共享：延迟最低，适合需要即时互动的场景
                        </Button>
                        <Typography variant="body2" color="textSecondary" style={{marginTop: 8}}>
                            直播共享经服务器分发，观众数量不影响画质，设置保持默认即可。
                        </Typography>
                    </DialogContent>
                </Dialog>
            </div>
        </div>
    );
};

const useShowOnMouseMovement = (doShow: (s: boolean) => void) => {
    const timeoutHandle = React.useRef(0);

    React.useEffect(() => {
        const update = () => {
            if (timeoutHandle.current === 0) {
                doShow(true);
            }

            clearTimeout(timeoutHandle.current);
            timeoutHandle.current = window.setTimeout(() => {
                timeoutHandle.current = 0;
                doShow(false);
            }, 1000);
        };
        window.addEventListener('mousemove', update);
        return () => window.removeEventListener('mousemove', update);
    }, [doShow]);

    React.useEffect(
        () =>
            void (timeoutHandle.current = window.setTimeout(() => {
                timeoutHandle.current = 0;
                doShow(false);
            }, 1000)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []
    );
};

const AudioControl = ({video}: {video: FullScreenHTMLVideoElement}) => {
    // this is used to force a rerender
    const [, setMuted] = React.useState<boolean>();

    React.useEffect(() => {
        const handler = () => setMuted(video.muted);
        video.addEventListener('volumechange', handler);
        setMuted(video.muted);
        return () => video.removeEventListener('volumechange', handler);
    });

    return (
        <Stack spacing={0.5} pr={2} direction="row" sx={{alignItems: 'center', my: 1, height: 35}}>
            <IconButton size="large" onClick={() => (video.muted = !video.muted)}>
                {video.muted ? (
                    <VolumeMuteIcon fontSize="large" />
                ) : (
                    <VolumeIcon fontSize="large" />
                )}
            </IconButton>
            <Slider
                min={0}
                max={1}
                step={0.01}
                defaultValue={video.volume}
                onChange={(_, newVolume) => {
                    video.muted = false;
                    video.volume = newVolume;
                }}
            />
        </Stack>
    );
};

const useStyles = makeStyles()(() => ({
    title: {
        padding: 15,
        position: 'fixed',
        top: '30px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 30,
    },
    bottomContainer: {
        position: 'fixed',
        display: 'flex',
        bottom: 0,
        right: 0,
        zIndex: 20,
    },
    control: {
        padding: 15,
        position: 'fixed',
        bottom: '30px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 30,
    },
    video: {
        display: 'block',
        margin: '0 auto',

        '&::-webkit-media-controls-start-playback-button': {
            display: 'none!important',
        },
        '&::-webkit-media-controls': {
            display: 'none!important',
        },
    },
    smallVideo: {
        minWidth: '100%',
        minHeight: '100%',
        width: 'auto',
        maxWidth: '300px',

        maxHeight: '200px',
    },
    videoWindowFit: {
        width: '100%',
        height: '100%',

        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%,-50%)',
    },
    videoWindowWidth: {
        height: 'auto',
        width: '100%',
    },
    videoWindowHeight: {
        height: '100%',
        width: 'auto',
    },
    smallVideoLabel: {
        position: 'absolute',
        display: 'block',
        bottom: 0,
        background: 'rgba(0,0,0,.5)',
        padding: '5px 15px',
    },
    noMaxWidth: {
        maxWidth: 'none',
    },
    smallVideoContainer: {
        height: '100%',
        padding: 5,
        maxHeight: 200,
        maxWidth: 400,
        width: '100%',
    },
    videoContainer: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: '100%',
        height: '100%',

        overflow: 'auto',
    },
}));
