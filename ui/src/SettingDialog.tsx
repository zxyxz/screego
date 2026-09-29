import React from 'react';
import {
    Collapse,
    Dialog,
    DialogTitle,
    DialogContent,
    TextField,
    DialogActions,
    Button,
    Autocomplete,
    Box,
    Typography,
} from '@mui/material';
import {
    CodecAuto,
    CodecBestQuality,
    CodecDefault,
    codecName,
    displayModeName,
    loadSettings,
    PreferredCodec,
    Settings,
    VideoDisplayMode,
} from './settings';
import {NumberField} from './NumberField';

export interface SettingDialogProps {
    open: boolean;
    setOpen: (open: boolean) => void;
    updateName: (s: string) => void;
    saveSettings: (s: Settings) => void;
    serverLiveBandwidthMbps: number;
}

const getAvailableCodecs = (): PreferredCodec[] => {
    if ('getCapabilities' in RTCRtpSender) {
        return RTCRtpSender.getCapabilities('video')?.codecs ?? [];
    }
    return [];
};

const NativeCodecs = getAvailableCodecs();

export const SettingDialog = ({
    open,
    setOpen,
    updateName,
    saveSettings,
    serverLiveBandwidthMbps,
}: SettingDialogProps) => {
    const [settingsInput, setSettingsInput] = React.useState(loadSettings);
    const [advanced, setAdvanced] = React.useState(false);

    const doSubmit = () => {
        saveSettings(settingsInput);
        updateName(settingsInput.name ?? '');
        setOpen(false);
    };

    const {
        name,
        preferCodec,
        displayMode,
        framerate,
        bitrateMbps,
        liveBitrateMbps,
        liveBitrateAuto,
        liveBufferSeconds,
    } = settingsInput;

    return (
        <Dialog open={open} onClose={() => setOpen(false)} maxWidth={'xs'} fullWidth>
            <DialogTitle>设置</DialogTitle>
            <DialogContent>
                <form onSubmit={doSubmit}>
                    <Box paddingBottom={1}>
                        <TextField
                            margin="dense"
                            label="用户名"
                            value={name}
                            onChange={(e) =>
                                setSettingsInput((c) => ({...c, name: e.target.value}))
                            }
                            fullWidth
                        />
                    </Box>
                    <Box paddingTop={1} paddingBottom={1}>
                        <Autocomplete<VideoDisplayMode>
                            options={Object.values(VideoDisplayMode)}
                            getOptionLabel={(mode) => displayModeName(mode)}
                            onChange={(_, value) =>
                                setSettingsInput((c) => ({
                                    ...c,
                                    displayMode: value ?? VideoDisplayMode.FitToWindow,
                                }))
                            }
                            value={displayMode}
                            fullWidth
                            renderInput={(params) => <TextField {...params} label="显示模式" />}
                        />
                    </Box>
                    <Typography
                        variant="body2"
                        color="primary"
                        style={{cursor: 'pointer', userSelect: 'none'}}
                        onClick={() => setAdvanced((c) => !c)}
                    >
                        {advanced ? '收起高级设置 ▲' : '高级设置（一般无需修改）▼'}
                    </Typography>
                    <Collapse in={advanced}>
                        <Box paddingTop={1}>
                            <Autocomplete<PreferredCodec>
                                options={[
                                    CodecAuto,
                                    CodecBestQuality,
                                    CodecDefault,
                                    ...NativeCodecs,
                                ]}
                                getOptionLabel={({mimeType, sdpFmtpLine}) =>
                                    codecName(mimeType) + (sdpFmtpLine ? ` (${sdpFmtpLine})` : '')
                                }
                                value={preferCodec}
                                isOptionEqualToValue={(a, b) =>
                                    a.mimeType === b.mimeType && a.sdpFmtpLine === b.sdpFmtpLine
                                }
                                fullWidth
                                onChange={(_, value) =>
                                    setSettingsInput((c) => ({
                                        ...c,
                                        preferCodec: value ?? undefined,
                                    }))
                                }
                                renderInput={(params) => (
                                    <TextField {...params} label="首选编码器" />
                                )}
                            />
                        </Box>
                        <Box paddingTop={1}>
                            <NumberField
                                label="帧率"
                                min={0}
                                helperText="0 = 自动（推荐）：直播码率 ≥15M 时 60fps，否则 30fps；实时共享自动时为 30fps。手动填写的值优先。"
                                onChange={(framerate) =>
                                    setSettingsInput((c) => ({...c, framerate: Math.max(0, framerate)}))
                                }
                                value={framerate}
                                fullWidth
                            />
                        </Box>
                        <Box paddingTop={1}>
                            <NumberField
                                label="码率上限 (Mbps)"
                                min={0}
                                helperText="0 = 浏览器默认。仅用于实时共享（直连不经过服务器）。广域网建议 5-20。"
                                onChange={(bitrateMbps) =>
                                    setSettingsInput((c) => ({...c, bitrateMbps}))
                                }
                                value={bitrateMbps}
                                fullWidth
                            />
                        </Box>
                        <Box paddingTop={1}>
                            <NumberField
                                label="直播码率 (Mbps)"
                                min={1}
                                helperText={
                                    liveBitrateAuto
                                        ? `跟随服务器配置（当前 ${serverLiveBandwidthMbps} Mbps），部署方按服务器带宽设置。`
                                        : '已固定为手动值，不再跟随服务器。'
                                }
                                onChange={(v) =>
                                    setSettingsInput((c) => ({
                                        ...c,
                                        liveBitrateMbps: v,
                                        liveBitrateAuto: false,
                                    }))
                                }
                                value={liveBitrateAuto ? serverLiveBandwidthMbps : liveBitrateMbps}
                                fullWidth
                            />
                            {!liveBitrateAuto && (
                                <Typography
                                    variant="body2"
                                    color="primary"
                                    style={{cursor: 'pointer', userSelect: 'none'}}
                                    onClick={() =>
                                        setSettingsInput((c) => ({...c, liveBitrateAuto: true}))
                                    }
                                >
                                    恢复跟随服务器
                                </Typography>
                            )}
                        </Box>
                        <Box paddingTop={1} paddingBottom={1}>
                            <NumberField
                                label="直播缓冲（秒）"
                                min={0}
                                helperText="0 = 自动（2.5 秒）。加大可抵抗网络抖动，代价是延迟更高。"
                                onChange={(liveBufferSeconds) =>
                                    setSettingsInput((c) => ({...c, liveBufferSeconds}))
                                }
                                value={liveBufferSeconds}
                                fullWidth
                            />
                        </Box>
                    </Collapse>
                </form>
            </DialogContent>
            <DialogActions>
                <Button onClick={() => setOpen(false)} color="primary">
                    取消
                </Button>
                <Button onClick={doSubmit} color="primary">
                    保存
                </Button>
            </DialogActions>
        </Dialog>
    );
};
